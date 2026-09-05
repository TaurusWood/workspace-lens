import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AccessPolicy } from "../../src/core/access-policy.js";
import { SearchAdapter, compileFilePattern } from "../../src/adapters/search.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

describe("SearchAdapter", () => {
  let scratch: string;
  let outside: string;
  let root: string;
  let adapter: SearchAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-search-");
    outside = makeTempDir("wl-search-out-");
    root = path.join(scratch, "workspace");
    writeTree(root, {
      "src/access-policy.ts": "export class AccessPolicy {\n  decide(path: string) {}\n}\n",
      "src/server.ts": "const policy = new AccessPolicy();\n// literal chars: a.c (x) * star\n",
      "docs/guide.md": "The AccessPolicy decides access.\naccess policy lowercase\n",
      "notes/a.txt": "AccessPolicy in notes\n",
      "regex-bait.txt": "abc\n",
      ".env": "SUPER_SECRET_TOKEN=abc123\n",
      "node_modules/lib/index.js": "AccessPolicy vendored copy\n",
      "blob.bin": Buffer.from([0x00, 0x41, 0x63, 0x63, 0x65, 0x73, 0x73]),
      "latin.txt": Buffer.from([0xff, 0xfe, 0x41]),
      "big.txt": "x".repeat(DEFAULT_LIMITS.maxEligibleFileBytes + 1) + " AccessPolicy\n",
    });
    fs.writeFileSync(path.join(outside, "outside.txt"), "AccessPolicy outside\n");
    adapter = new SearchAdapter({ limits: DEFAULT_LIMITS, policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("finds literal matches with 1-based line and column", async () => {
    const result = await adapter.search(root, { query: "AccessPolicy" });
    const paths = result.matches.map((match) => match.path);
    expect(paths).toContain("src/access-policy.ts");
    expect(paths).toContain("docs/guide.md");
    expect(paths).toContain("notes/a.txt");
    expect(result.truncated).toBe(false);

    const first = result.matches.find((match) => match.path === "src/access-policy.ts")!;
    expect(first).toMatchObject({ line: 1, column: 14, preview: "export class AccessPolicy {" });
  });

  it("respects case sensitivity by default and supports insensitive search", async () => {
    const sensitive = await adapter.search(root, { query: "accesspolicy" });
    expect(sensitive.matches).toEqual([]);

    const insensitive = await adapter.search(root, {
      query: "accesspolicy",
      caseSensitive: false,
    });
    expect(insensitive.matches.length).toBeGreaterThan(0);
    expect(insensitive.matches.map((match) => match.path)).toContain("docs/guide.md");
  });

  it("treats the query as literal text, never as a regular expression", async () => {
    const result = await adapter.search(root, { query: "a.c" });
    // The literal "a.c" matches, but regex semantics must not turn it into "any char".
    expect(result.matches.map((match) => match.path)).toContain("src/server.ts");
    expect(result.matches.map((match) => match.path)).not.toContain("regex-bait.txt");

    const star = await adapter.search(root, { query: "* star" });
    expect(star.matches.map((match) => match.path)).toContain("src/server.ts");

    const parens = await adapter.search(root, { query: "(x)" });
    expect(parens.matches.map((match) => match.path)).toContain("src/server.ts");
  });

  it("reports every occurrence on a line with ascending columns", async () => {
    fs.mkdirSync(path.join(root, "dups"));
    fs.writeFileSync(path.join(root, "dups", "dup.ts"), "x AccessPolicy y AccessPolicy z\n");
    const result = await adapter.search(root, { query: "AccessPolicy", path: "dups" });
    const dup = result.matches.filter((match) => match.path === "dups/dup.ts");
    expect(dup.map((match) => match.column)).toEqual([3, 18]);
  });

  it("supports a workspace-relative search root", async () => {
    const result = await adapter.search(root, { query: "AccessPolicy", path: "src" });
    expect(result.matches.map((match) => match.path)).toEqual([
      "src/access-policy.ts",
      "src/server.ts",
    ]);
  });

  it("filters with a simple basename glob and rejects shell syntax", async () => {
    const tsOnly = await adapter.search(root, { query: "AccessPolicy", filePattern: "*.ts" });
    expect(tsOnly.matches.every((match) => match.path.endsWith(".ts"))).toBe(true);

    for (const bad of ["a/b", "a\\b", "", "a;rm", "$HOME", "`cmd`", "a|b", "x".repeat(101)]) {
      await expect(adapter.search(root, { query: "q", filePattern: bad })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    }
  });

  it("compiles simple globs", () => {
    const pattern = compileFilePattern("*.test.ts");
    expect(pattern.test("a.test.ts")).toBe(true);
    expect(pattern.test("test.ts")).toBe(false);
    expect(compileFilePattern("file_?.txt").test("file_1.txt")).toBe(true);
  });

  it("never searches or leaks blocked, excluded, binary, or oversized files", async () => {
    const result = await adapter.search(root, { query: "AccessPolicy" });
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("SUPER_SECRET_TOKEN");
    expect(text).not.toContain("node_modules");
    expect(text).not.toContain("blob.bin");
    expect(text).not.toContain("latin.txt");
    expect(text).not.toContain("big.txt");

    // The strongest invariant: a query for blocked content finds nothing.
    const secret = await adapter.search(root, { query: "SUPER_SECRET_TOKEN" });
    expect(secret.matches).toEqual([]);
    expect(secret.truncated).toBe(false);
  });

  it("returns bounded previews", async () => {
    fs.writeFileSync(
      path.join(root, "long-line.md"),
      `${"p".repeat(500)} AccessPolicy\n`,
    );
    const result = await adapter.search(root, { query: "AccessPolicy" });
    const long = result.matches.find((match) => match.path === "long-line.md")!;
    expect(long.preview.length).toBeLessThanOrEqual(DEFAULT_LIMITS.maxSearchPreviewChars);
  });

  it("marks truncation at the server ceiling and slices to caller max", async () => {
    const manyDir = path.join(root, "many");
    fs.mkdirSync(manyDir);
    for (let i = 0; i < 150; i += 1) {
      fs.writeFileSync(path.join(manyDir, `f${String(i).padStart(3, "0")}.txt`), `hit ${i}\n`);
    }

    const serverCapped = await adapter.search(root, { query: "hit", maxResults: 100 });
    expect(serverCapped.matches).toHaveLength(DEFAULT_LIMITS.maxSearchResults);
    expect(serverCapped.truncated).toBe(true);

    const callerCapped = await adapter.search(root, { query: "hit", maxResults: 5 });
    expect(callerCapped.matches).toHaveLength(5);
    expect(callerCapped.truncated).toBe(true);

    // Deterministic order: sorted by path even though the scan stopped early.
    const paths = serverCapped.matches.map((match) => match.path);
    expect(paths).toEqual([...paths].sort());
    expect(paths[0]).toBe("many/f000.txt");
  });

  it("honors a small file-scan guard with truncation", async () => {
    const tiny = new SearchAdapter({
      limits: { ...DEFAULT_LIMITS, maxSearchFileScan: 2 },
      policy: new AccessPolicy(),
    });
    const result = await tiny.search(root, { query: "AccessPolicy" });
    expect(result.truncated).toBe(true);
  });

  it("enforces the kernel before searching", async () => {
    await expect(adapter.search(root, { query: "x", path: "../outside" })).rejects.toMatchObject({
      code: "PATH_INVALID",
    });
    await expect(adapter.search(root, { query: "x", path: "missing-dir" })).rejects.toMatchObject({
      code: "PATH_NOT_FOUND",
    });
    await expect(adapter.search(root, { query: "x", path: ".env" })).rejects.toMatchObject({
      code: "PATH_BLOCKED",
    });
    await expect(
      adapter.search(root, { query: "x", path: "node_modules" }),
    ).rejects.toMatchObject({ code: "PATH_BLOCKED" });
    await expect(adapter.search(root, { query: "x", path: "notes/a.txt" })).rejects.toMatchObject({
      code: "NOT_A_DIRECTORY",
    });
    await expect(adapter.search(root, { query: "" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    await expect(adapter.search(root, { query: "x", maxResults: 1000 })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });
});

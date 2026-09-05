import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AccessPolicy } from "../../src/core/access-policy.js";
import { GitAdapter } from "../../src/adapters/git.js";
import { git, initRepo, write } from "../helpers/git.js";
import { makeTempDir } from "../helpers/fixtures.js";

/**
 * Phase 6 mandatory cases (`implementation-plan.md` §13): staged/unstaged/
 * combined diffs, deleted and renamed files, spaces in filenames, blocked
 * `.env` changes, oversized diff truncation, non-Git workspaces, and
 * repository-local config that must not trigger external diff execution.
 */
describe("GitAdapter", () => {
  let scratch: string;
  let root: string;
  let adapter: GitAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-git-");
    root = path.join(scratch, "repo");
    // The tracked .pem has enough bulk that a later rename is detected as a
    // true rename (similarity above git's threshold) rather than delete+add.
    const pemBody = ["PRIVATE KEY MATERIAL", ...Array.from({ length: 40 }, (_, i) => `keyline-${i}`)].join("\n") + "\n";
    initRepo(root, {
      "src/app.ts": "const a = 1;\n",
      "docs/readme.md": "# readme\n",
      "gone.txt": "soon gone\n",
      "ok.txt": "fine\n",
      "config.pem": pemBody,
      "with space.txt": "spaces are legal\n",
    });
    // Working-tree state used by most tests:
    write(root, "src/app.ts", "const a = 2;\n"); // unstaged modified
    write(root, "docs/readme.md", "# readme v2\n");
    git(root, "add", "docs/readme.md"); // staged modified
    fs.rmSync(path.join(root, "gone.txt")); // unstaged deleted
    write(root, "new.txt", "untracked\n"); // untracked
    write(root, "config.pem", `ROTATED\n${Array.from({ length: 40 }, (_, i) => `keyline-${i}`).join("\n")}\n`);
    git(root, "add", "config.pem"); // staged blocked change
    adapter = new GitAdapter({ limits: DEFAULT_LIMITS, policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe("status", () => {
    it("parses staged, unstaged, untracked, and renamed records", async () => {
      const result = await adapter.status(root);
      const byPath = new Map(result.changes.map((change) => [change.path, change]));

      expect(byPath.get("src/app.ts")).toMatchObject({ staged: null, unstaged: "modified" });
      expect(byPath.get("docs/readme.md")).toMatchObject({ staged: "modified", unstaged: null });
      expect(byPath.get("gone.txt")).toMatchObject({ staged: null, unstaged: "deleted" });
      expect(byPath.get("new.txt")).toMatchObject({ staged: null, unstaged: "untracked" });

      const rename = byPath.get("moved.txt");
      expect(rename).toBeUndefined(); // no rename in this fixture yet
      expect(result.branch).toMatchObject({
        name: "main",
        detached: false,
        upstream: null,
        ahead: null,
        behind: null,
      });
    });

    it("redacts blocked changes without disclosing the path", async () => {
      const result = await adapter.status(root);
      expect(result.redacted_changes).toBe(1);
      expect(result.changes.map((change) => change.path)).not.toContain("config.pem");
      expect(JSON.stringify(result)).not.toContain("config.pem");
      expect(result.clean).toBe(false);
    });

    it("reports renames with old_path subject to AccessPolicy", async () => {
      git(root, "mv", "ok.txt", "moved.txt");
      const result = await adapter.status(root);
      const rename = result.changes.find((change) => change.path === "moved.txt");
      expect(rename).toMatchObject({ staged: "renamed", unstaged: null, old_path: "ok.txt" });
    });

    it("reports a clean tree", async () => {
      const cleanRoot = path.join(scratch, "clean");
      initRepo(cleanRoot, { "a.txt": "a\n" });
      const result = await adapter.status(cleanRoot);
      expect(result).toMatchObject({ changes: [], redacted_changes: 0, clean: true });
    });

    it("reports upstream and ahead counts without network access", async () => {
      const aheadRoot = path.join(scratch, "ahead");
      initRepo(aheadRoot, { "a.txt": "a\n" });
      const bare = path.join(scratch, "origin.git");
      git(scratch, "clone", "-q", "--bare", aheadRoot, bare);
      git(aheadRoot, "remote", "add", "origin", bare);
      git(aheadRoot, "push", "-q", "-u", "origin", "main");
      write(aheadRoot, "a.txt", "b\n");
      git(aheadRoot, "add", "-A");
      git(aheadRoot, "commit", "-q", "-m", "second");

      const result = await adapter.status(aheadRoot);
      // Git only reports non-zero ahead/behind; absent values are null.
      expect(result.branch).toMatchObject({ upstream: "origin/main", ahead: 1, behind: null });
    });

    it("handles detached HEAD and unborn branches", async () => {
      const detachedRoot = path.join(scratch, "detached");
      initRepo(detachedRoot, { "a.txt": "a\n" });
      git(detachedRoot, "checkout", "-q", "--detach");
      const detached = await adapter.status(detachedRoot);
      expect(detached.branch.detached).toBe(true);
      expect(detached.branch.name).toBeNull();

      const unbornRoot = path.join(scratch, "unborn");
      initRepo(unbornRoot);
      write(unbornRoot, "f.txt", "hi\n");
      git(unbornRoot, "add", "f.txt");
      const unborn = await adapter.status(unbornRoot);
      expect(unborn.branch).toMatchObject({ name: "main", detached: false });
    });

    it("does not change repository state", async () => {
      const indexBefore = fs.readFileSync(path.join(root, ".git", "index"));
      const porcelainBefore = fs
        .readFileSync(path.join(root, ".git", "HEAD"))
        .toString("utf8");
      await adapter.status(root);
      const indexAfter = fs.readFileSync(path.join(root, ".git", "index"));
      const porcelainAfter = fs.readFileSync(path.join(root, ".git", "HEAD")).toString("utf8");
      expect(indexAfter.equals(indexBefore)).toBe(true);
      expect(porcelainAfter).toBe(porcelainBefore);
    });

    it("limits a subdirectory workspace to its own subtree", async () => {
      const subRoot = path.join(scratch, "subrepo");
      initRepo(subRoot, { "outside.txt": "out\n", "sub/inner.txt": "in\n" });
      write(subRoot, "sub/inner.txt", "in v2\n"); // inside workspace
      write(subRoot, "outside.txt", "out v2\n"); // outside workspace

      const workspace = path.join(subRoot, "sub");
      const result = await adapter.status(workspace);
      const paths = result.changes.map((change) => change.path);
      expect(paths).toContain("inner.txt"); // mapped to workspace-relative
      expect(paths).not.toContain("outside.txt");
      expect(paths.join("\n")).not.toContain("../");
    });

    it("handles spaces and unusual-but-valid filenames", async () => {
      write(root, "with space.txt", "spaces changed\n");
      const result = await adapter.status(root);
      expect(result.changes.map((change) => change.path)).toContain("with space.txt");
    });

    it("fails with NOT_A_GIT_REPOSITORY outside a repository", async () => {
      const plain = path.join(scratch, "plain");
      fs.mkdirSync(plain);
      await expect(adapter.status(plain)).rejects.toMatchObject({
        code: "NOT_A_GIT_REPOSITORY",
      });
    });
  });

  describe("diff", () => {
    it("returns staged and unstaged sections in contract order for scope all", async () => {
      const result = await adapter.diff(root, "all");
      expect(result.sections.map((section) => section.scope)).toEqual(["staged", "unstaged"]);
      expect(result.truncated).toBe(false);

      const staged = result.sections[0]!;
      const unstaged = result.sections[1]!;
      expect(staged.diff).toContain("docs/readme.md");
      expect(staged.diff).not.toContain("config.pem"); // blocked, never returned
      expect(unstaged.diff).toContain("src/app.ts");
      expect(unstaged.diff).toContain("gone.txt");
      // Untracked content is never part of a diff.
      expect(result.sections.map((section) => section.diff).join("")).not.toContain("new.txt");
    });

    it("supports single scopes", async () => {
      const staged = await adapter.diff(root, "staged");
      expect(staged.sections).toHaveLength(1);
      expect(staged.sections[0]!.scope).toBe("staged");
      expect(staged.sections[0]!.diff).toContain("docs/readme.md");
      expect(staged.sections[0]!.diff).not.toContain("src/app.ts");

      const unstaged = await adapter.diff(root, "unstaged");
      expect(unstaged.sections[0]!.diff).toContain("src/app.ts");
      expect(unstaged.sections[0]!.diff).not.toContain("docs/readme.md");
    });

    it("never returns blocked diff bodies or names", async () => {
      const result = await adapter.diff(root, "all");
      const text = JSON.stringify(result);
      expect(text).not.toContain("config.pem");
      expect(text).not.toContain("ROTATED PRIVATE KEY");
      expect(result.redacted_files).toBeGreaterThanOrEqual(1);
    });

    it("redacts renames involving blocked paths in either direction", async () => {
      // old blocked -> new allowed: a true rename (high similarity) so the
      // R record carries both endpoints and is redacted as a whole.
      git(root, "mv", "config.pem", "moved-key.txt");
      const result = await adapter.diff(root, "staged");
      const text = JSON.stringify(result);
      expect(text).not.toContain("config.pem");
      expect(text).not.toContain("moved-key.txt");
      expect(text).not.toContain("PRIVATE KEY MATERIAL");
      expect(result.redacted_files).toBeGreaterThanOrEqual(1);

      // allowed -> blocked
      const root2 = path.join(scratch, "repo2");
      initRepo(root2, { "ok2.txt": "fine\n", "keep.txt": "keep\n" });
      git(root2, "mv", "ok2.txt", ".env");
      const result2 = await adapter.diff(root2, "staged");
      const text2 = JSON.stringify(result2);
      expect(text2).not.toContain("ok2.txt");
      expect(text2).not.toContain(".env");
      expect(result2.redacted_files).toBeGreaterThanOrEqual(1);
    });

    it("filters by workspace-relative path", async () => {
      const result = await adapter.diff(root, "unstaged", "src");
      expect(result.sections[0]!.diff).toContain("src/app.ts");
      expect(result.sections[0]!.diff).not.toContain("gone.txt");

      const fileFilter = await adapter.diff(root, "unstaged", "src/app.ts");
      expect(fileFilter.sections[0]!.diff).toContain("src/app.ts");

      await expect(adapter.diff(root, "unstaged", "config.pem")).rejects.toMatchObject({
        code: "PATH_BLOCKED",
      });
      await expect(adapter.diff(root, "unstaged", "missing.ts")).rejects.toMatchObject({
        code: "PATH_NOT_FOUND",
      });
      await expect(adapter.diff(root, "unstaged", "../escape")).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
    });

    it("truncates oversized diffs with an explicit flag", async () => {
      const bigRoot = path.join(scratch, "big");
      initRepo(bigRoot, {
        "a.txt": `${"a".repeat(3000)}\n`,
        "b.txt": `${"b".repeat(3000)}\n`,
      });
      write(bigRoot, "a.txt", `${"A".repeat(3000)}\n`);
      write(bigRoot, "b.txt", `${"B".repeat(3000)}\n`);

      const tiny = new GitAdapter({
        limits: { ...DEFAULT_LIMITS, maxDiffPayloadBytes: 500 },
        policy: new AccessPolicy(),
      });
      const result = await tiny.diff(bigRoot, "unstaged");
      expect(result.truncated).toBe(true);
      const total = result.sections.reduce((sum, section) => sum + section.diff.length, 0);
      expect(Buffer.byteLength(result.sections.map((s) => s.diff).join(""), "utf8")).toBeLessThanOrEqual(500);
      expect(total).toBeGreaterThan(0);
    });

    it("reports an empty diff for a clean repository", async () => {
      const cleanRoot = path.join(scratch, "clean");
      initRepo(cleanRoot, { "a.txt": "a\n" });
      const result = await adapter.diff(cleanRoot, "all");
      expect(result.sections.map((section) => section.diff)).toEqual(["", ""]);
      expect(result.sections.every((section) => section.files_changed === 0)).toBe(true);
      expect(result.redacted_files).toBe(0);
      expect(result.truncated).toBe(false);
    });

    it("handles deleted and renamed files in diff output", async () => {
      git(root, "mv", "ok.txt", "renamed-ok.txt");
      const staged = await adapter.diff(root, "staged");
      const text = staged.sections[0]!.diff;
      expect(text).toContain("rename from ok.txt");
      expect(text).toContain("rename to renamed-ok.txt");
      // rename + staged readme modification; the blocked pem is redacted.
      expect(staged.sections[0]!.files_changed).toBe(2);
    });

    it("keeps spaces in filenames intact", async () => {
      write(root, "with space.txt", "spaces changed\n");
      const result = await adapter.diff(root, "unstaged");
      expect(result.sections[0]!.diff).toContain("b/with space.txt");
    });

    it("fails with NOT_A_GIT_REPOSITORY outside a repository", async () => {
      const plain = path.join(scratch, "plain");
      fs.mkdirSync(plain);
      await expect(adapter.diff(plain, "unstaged")).rejects.toMatchObject({
        code: "NOT_A_GIT_REPOSITORY",
      });
    });

    it("prevents repository-local config from executing external diff or textconv", async () => {
      const marker = path.join(scratch, "marker.txt");
      const script = path.join(scratch, "pwn.sh");
      fs.writeFileSync(
        script,
        `#!/bin/sh\ntouch "${marker}"\necho FAKE DIFF\n`,
        { mode: 0o755 },
      );
      git(root, "config", "diff.external", script);
      git(root, "config", "diff.pwn.textconv", script);
      fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt diff=pwn\n");

      const result = await adapter.diff(root, "unstaged");
      expect(fs.existsSync(marker)).toBe(false);
      expect(result.sections[0]!.diff).not.toContain("FAKE DIFF");
      expect(result.sections[0]!.diff).toContain("src/app.ts");
    });
  });
});

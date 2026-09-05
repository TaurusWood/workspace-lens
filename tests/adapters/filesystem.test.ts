import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AccessPolicy } from "../../src/core/access-policy.js";
import { AppError } from "../../src/core/errors.js";
import { FilesystemAdapter } from "../../src/adapters/filesystem.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

describe("FilesystemAdapter", () => {
  let scratch: string;
  let outside: string;
  let root: string;
  let adapter: FilesystemAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-fs-");
    outside = makeTempDir("wl-fs-out-");
    root = path.join(scratch, "workspace");
    writeTree(root, {
      "README.md": "# read me\n",
      "src/index.ts": "export const a = 1;\nexport const b = 2;\n",
      "src/util.ts": "export const u = () => 0;\n",
      "src/deep/nested.txt": "deep\n",
      ".env": "SECRET=1\n",
      "node_modules/pkg/index.js": "module.exports = 1;\n",
      "dist/out.js": "generated\n",
    });
    fs.symlinkSync(path.join(root, "src"), path.join(root, "link-in"));
    fs.symlinkSync(outside, path.join(root, "link-out"));
    adapter = new FilesystemAdapter({ limits: DEFAULT_LIMITS, policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  describe("listTree", () => {
    it("lists deterministic, policy-filtered entries", async () => {
      const result = await adapter.listTree(root, ".", 2);
      const paths = result.entries.map((entry) => entry.path);
      // Directories first, then files/symlinks, each lexicographically.
      expect(paths).toEqual([
        "src",
        "src/deep",
        "README.md",
        "link-in",
        "link-out",
        "src/index.ts",
        "src/util.ts",
      ]);
      expect(result.truncated).toBe(false);
      // Blocked and excluded entries are omitted entirely.
      expect(paths).not.toContain(".env");
      expect(paths.join("\n")).not.toContain("node_modules");
      expect(paths.join("\n")).not.toContain("dist");
    });

    it("reports kind and size, and never discloses symlink targets", async () => {
      const result = await adapter.listTree(root, ".", 5);
      const byPath = new Map(result.entries.map((entry) => [entry.path, entry]));
      expect(byPath.get("README.md")).toMatchObject({
        kind: "file",
        size_bytes: fs.statSync(path.join(root, "README.md")).size,
      });
      expect(byPath.get("src")).toMatchObject({ kind: "directory" });
      expect(byPath.get("link-in")).toMatchObject({ kind: "symlink" });
      expect(JSON.stringify(result)).not.toContain(outside);
    });

    it("respects depth", async () => {
      const depth1 = await adapter.listTree(root, ".", 1);
      expect(depth1.entries.map((e) => e.path)).not.toContain("src/deep");

      const depth2 = await adapter.listTree(root, ".", 2);
      expect(depth2.entries.map((e) => e.path)).toContain("src/deep");
      expect(depth2.entries.map((e) => e.path)).not.toContain("src/deep/nested.txt");
    });

    it("lists a subdirectory and returns its normalized path", async () => {
      const result = await adapter.listTree(root, "src/", 1);
      expect(result.path).toBe("src");
      // Entry paths are workspace-relative, not relative to the subroot.
      expect(result.entries.map((e) => e.path).sort()).toEqual([
        "src/deep",
        "src/index.ts",
        "src/util.ts",
      ]);
    });

    it("enforces the hard entry ceiling with truncation", async () => {
      const tinyLimits = { ...DEFAULT_LIMITS, maxListEntries: 3 };
      const tiny = new FilesystemAdapter({ limits: tinyLimits, policy: new AccessPolicy() });
      const result = await tiny.listTree(root, ".", 5);
      expect(result.entries).toHaveLength(3);
      expect(result.truncated).toBe(true);
    });

    it("rejects invalid depth before touching the filesystem", async () => {
      await expect(adapter.listTree(root, ".", 6)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
      await expect(adapter.listTree(root, ".", 0)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    });

    it("fails on missing paths, files, and blocked directories", async () => {
      await expect(adapter.listTree(root, "missing-dir", 1)).rejects.toMatchObject({
        code: "PATH_NOT_FOUND",
      });
      await expect(adapter.listTree(root, "README.md", 1)).rejects.toMatchObject({
        code: "NOT_A_DIRECTORY",
      });
      // Blocked path: policy denies even directory access.
      await expect(adapter.listTree(root, "node_modules", 1)).rejects.toMatchObject({
        code: "PATH_BLOCKED",
      });
    });

    it("cannot be bypassed with caller-controlled escaping paths", async () => {
      await expect(adapter.listTree(root, "../", 1)).rejects.toMatchObject({ code: "PATH_INVALID" });
      await expect(adapter.listTree(root, "../workspace/src", 1)).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
    });
  });

  describe("readFile", () => {
    it("reads bounded text with explicit line ranges", async () => {
      const result = await adapter.readFile(root, "src/index.ts", 1, 1);
      expect(result).toMatchObject({
        path: "src/index.ts",
        encoding: "utf-8",
        content: "export const a = 1;",
        line_start: 1,
        line_end: 1,
        truncated: false,
      });
      expect(result.size_bytes).toBe(fs.statSync(path.join(root, "src/index.ts")).size);

      const lines2 = await adapter.readFile(root, "src/index.ts", 2, 2);
      expect(lines2.content).toBe("export const b = 2;");
    });

    it("clamps end_line to the file length without truncation flag", async () => {
      const result = await adapter.readFile(root, "src/index.ts", 1, 999);
      expect(result.line_end).toBe(2);
      expect(result.truncated).toBe(false);
    });

    it("marks truncation when the payload ceiling cuts lines", async () => {
      const file = path.join(root, "many-lines.txt");
      fs.writeFileSync(file, Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n"));
      const tight = new FilesystemAdapter({
        limits: { ...DEFAULT_LIMITS, maxReadPayloadBytes: 200 },
        policy: new AccessPolicy(),
      });
      const result = await tight.readFile(root, "many-lines.txt", 1, undefined);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(200);
      expect(result.line_end).toBeLessThan(500);
    });

    it("cuts a single oversized line at a UTF-8 boundary", async () => {
      const file = path.join(root, "one-line.txt");
      fs.writeFileSync(file, `${"é".repeat(100)}END`);
      const tight = new FilesystemAdapter({
        limits: { ...DEFAULT_LIMITS, maxReadPayloadBytes: 50 },
        policy: new AccessPolicy(),
      });
      const result = await tight.readFile(root, "one-line.txt", 1, undefined);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(50);
      expect(result.content.endsWith("END")).toBe(false);
    });

    it("rejects binary files and unsupported types", async () => {
      fs.writeFileSync(path.join(root, "blob.bin"), Buffer.from([0x00, 0x01, 0x02]));
      await expect(adapter.readFile(root, "blob.bin", 1, undefined)).rejects.toMatchObject({
        code: "BINARY_FILE_NOT_SUPPORTED",
      });

      const fifo = path.join(root, "fifo");
      if (process.platform !== "win32") {
        execFileSync("mkfifo", [fifo]);
        await expect(adapter.readFile(root, "fifo", 1, undefined)).rejects.toMatchObject({
          code: "UNSUPPORTED_FILE_TYPE",
        });
      }
    });

    it("rejects directories and files beyond the eligibility ceiling", async () => {
      await expect(adapter.readFile(root, "src", 1, undefined)).rejects.toMatchObject({
        code: "NOT_A_FILE",
      });

      const big = path.join(root, "big.txt");
      fs.writeFileSync(big, "x".repeat(DEFAULT_LIMITS.maxEligibleFileBytes + 1));
      await expect(adapter.readFile(root, "big.txt", 1, undefined)).rejects.toMatchObject({
        code: "FILE_TOO_LARGE",
      });
    });

    it("applies policy and kernel checks: blocked, missing, traversal", async () => {
      await expect(adapter.readFile(root, ".env", 1, undefined)).rejects.toMatchObject({
        code: "PATH_BLOCKED",
      });
      await expect(adapter.readFile(root, "missing.ts", 1, undefined)).rejects.toMatchObject({
        code: "PATH_NOT_FOUND",
      });
      await expect(adapter.readFile(root, "../../etc/passwd", 1, undefined)).rejects.toMatchObject({
        code: "PATH_INVALID",
      });
      await expect(adapter.readFile(root, "link-out", 1, undefined)).rejects.toMatchObject({
        code: "PATH_OUTSIDE_WORKSPACE",
      });
      // Contained symlink reads through to its target.
      const viaLink = await adapter.readFile(root, "link-in/index.ts", 1, 1);
      expect(viaLink.content).toBe("export const a = 1;");
    });

    it("rejects end_line smaller than start_line", async () => {
      await expect(adapter.readFile(root, "src/index.ts", 5, 4)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });

    it("allows errors to be AppErrors with defined codes", async () => {
      try {
        await adapter.readFile(root, ".env", 1, undefined);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
      }
    });
  });
});

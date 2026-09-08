import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AccessPolicy } from "../../src/core/access-policy.js";
import { GitAdapter, validateRevisionInput } from "../../src/adapters/git.js";
import { git, initRepo, write } from "../helpers/git.js";
import { makeTempDir } from "../helpers/fixtures.js";

/**
 * Phase 1 historical Git primitives (`v0.2-implementation-plan.md` §4,
 * `v0.2-test-contract.md` §3-§6, §8): revision grammar, resolution, commit
 * metadata, history, merge-base, committed comparison, hardening.
 */

function revParse(root: string, revision: string): string {
  return git(root, "rev-parse", revision).trim();
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return revParse(root, "HEAD");
}

/**
 * Diverged topology from `v0.2-test-contract.md` §2:
 *
 *           C---D---E  main (base branch)
 *          /
 *   A---B-+
 *          \
 *           X---Y      feature (reviewed head)
 */
function buildDivergedRepo(root: string): { baseTip: string; headTip: string; mergeBase: string } {
  initRepo(root, { "src/app.ts": "const a = 1;\n", "docs/readme.md": "# readme\n" }); // A
  write(root, "src/shared.ts", "export const shared = 1;\n");
  const mergeBase = commitAll(root, "B: add shared");
  git(root, "checkout", "-q", "-b", "feature");
  write(root, "src/feature.ts", "export const feature = 1;\n");
  commitAll(root, "X: add feature");
  write(root, "src/feature.ts", "export const feature = 2;\n");
  const headTip = commitAll(root, "Y: extend feature");
  git(root, "checkout", "-q", "main");
  write(root, "src/base.ts", "export const base = 1;\n");
  commitAll(root, "C: add base");
  write(root, "src/base.ts", "export const base = 2;\n");
  commitAll(root, "D: change base");
  write(root, "docs/readme.md", "# readme v2\n");
  const baseTip = commitAll(root, "E: docs");
  return { baseTip, headTip, mergeBase };
}

describe("GitAdapter historical primitives (v0.2)", () => {
  let scratch: string;
  let adapter: GitAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-githist-");
    adapter = new GitAdapter({ limits: DEFAULT_LIMITS, policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  describe("revision validation", () => {
    const accepted = [
      "HEAD",
      "main",
      "feature/foo",
      "v0.2.0",
      "832de4f",
      "832de4f8b6d3",
      "832de4f8b6d3c9a1b2e4f5a6b7c8d9e0f1a2b3c4",
      "refs/heads/main",
      "a.b_c-d/e",
    ];
    for (const value of accepted) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        expect(validateRevisionInput(value)).toBe(value);
      });
    }

    const rejected = [
      "HEAD~3",
      "HEAD^",
      "main..HEAD",
      "main...HEAD",
      "@{upstream}",
      "HEAD@{1}",
      "HEAD:src/index.ts",
      ":/pattern",
      "--all",
      "-leading",
      "-",
      "trailing/",
      "foo//bar",
      "foo.lock",
      "refs/heads/x.lock",
      "revision with whitespace",
      "revision\ttab",
      "revision\\backslash",
      "a:b",
      "a~b",
      "a^b",
      "a@b",
      "a{b",
      "..",
      "$PATH",
      "`id`",
      "a|b",
      "main;rm",
      "\u00e9acute", // non-ASCII
      "",
    ];
    for (const value of rejected) {
      it(`rejects ${JSON.stringify(value)}`, () => {
        expect(() => validateRevisionInput(value)).toThrowError(
          expect.objectContaining({ code: "INVALID_ARGUMENT" }),
        );
      });
    }

    it("rejects invalid revisions from every tool primitive before Git use", async () => {
      const root = path.join(scratch, "repo");
      initRepo(root, { "a.txt": "a\n" });
      await expect(adapter.history(root, "HEAD~1", 5)).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(adapter.commit(root, "main..HEAD")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(adapter.compare(root, "--all", "HEAD", "direct")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(adapter.compare(root, "main", "HEAD^", "direct")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
      await expect(adapter.compare(root, "main", "HEAD^", "merge_base")).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    });
  });

  describe("history", () => {
    it("returns newest-to-oldest bounded metadata and never file data", async () => {
      const root = path.join(scratch, "repo");
      buildDivergedRepo(root);
      const result = await adapter.history(root, "main", 100);

      expect(result.truncated).toBe(false);
      expect(result.commits.map((commit) => commit.subject)).toEqual([
        "E: docs",
        "D: change base",
        "C: add base",
        "B: add shared",
        "init",
      ]);
      const top = result.commits[0]!;
      expect(top.commit).toBe(revParse(root, "main"));
      expect(top.parents).toEqual([revParse(root, "main~1")]);
      expect(top.author_name).toBe("Test");
      expect(top.committed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      // Metadata only: no bodies, no changed filenames, no patches.
      const text = JSON.stringify(result);
      expect(text).not.toContain("export const");
      expect(text).not.toContain("base.ts");
      expect(text).not.toContain("diff --git");
    });

    it("resolves HEAD, branch names, tags, and SHAs to the start commit", async () => {
      const root = path.join(scratch, "repo");
      initRepo(root, { "a.txt": "a\n" });
      git(root, "tag", "-a", "v0.2.0", "-m", "release");
      git(root, "branch", "feature/foo");
      const sha = revParse(root, "HEAD");

      const starts = await Promise.all(
        ["HEAD", "main", "feature/foo", "v0.2.0", sha, sha.slice(0, 10)].map((start) =>
          adapter.history(root, start, 5).then((result) => result.start),
        ),
      );
      for (const start of starts) {
        expect(start).toBe(sha);
      }
    });

    it("respects caller max_commits and reports truncation", async () => {
      const root = path.join(scratch, "repo");
      buildDivergedRepo(root);

      const bounded = await adapter.history(root, "main", 3);
      expect(bounded.commits.map((commit) => commit.subject)).toEqual([
        "E: docs",
        "D: change base",
        "C: add base",
      ]);
      expect(bounded.truncated).toBe(true);

      const single = await adapter.history(root, "main", 1);
      expect(single.commits).toHaveLength(1);
      expect(single.truncated).toBe(true);
    });

    it("clamps to the server hard history ceiling", async () => {
      const root = path.join(scratch, "repo");
      buildDivergedRepo(root);
      const tiny = new GitAdapter({
        limits: { ...DEFAULT_LIMITS, maxGitHistoryCommits: 2 },
        policy: new AccessPolicy(),
      });
      const result = await tiny.history(root, "main", 5);
      expect(result.commits).toHaveLength(2);
      expect(result.truncated).toBe(true);
    });

    it("handles detached HEAD", async () => {
      const root = path.join(scratch, "repo");
      buildDivergedRepo(root);
      git(root, "checkout", "-q", "--detach", "main~1");
      const result = await adapter.history(root, "HEAD", 5);
      expect(result.start).toBe(revParse(root, "main~1"));
      expect(result.commits[0]!.subject).toBe("D: change base");
    });

    it("fails with GIT_REVISION_NOT_FOUND for unknown revisions and unborn repositories", async () => {
      const root = path.join(scratch, "repo");
      initRepo(root, { "a.txt": "a\n" });
      await expect(adapter.history(root, "nosuchbranch", 5)).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });
      await expect(adapter.history(root, "deadbeef", 5)).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });

      const unborn = path.join(scratch, "unborn");
      initRepo(unborn);
      await expect(adapter.history(unborn, "HEAD", 5)).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });
      await expect(adapter.commit(unborn, "HEAD")).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });
      await expect(adapter.compare(unborn, "main", "HEAD", "direct")).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });
    });

    it("fails with NOT_A_GIT_REPOSITORY outside a repository", async () => {
      const plain = path.join(scratch, "plain");
      fs.mkdirSync(plain);
      await expect(adapter.history(plain, "HEAD", 5)).rejects.toMatchObject({
        code: "NOT_A_GIT_REPOSITORY",
      });
      await expect(adapter.commit(plain, "HEAD")).rejects.toMatchObject({
        code: "NOT_A_GIT_REPOSITORY",
      });
      await expect(adapter.compare(plain, "main", "HEAD", "direct")).rejects.toMatchObject({
        code: "NOT_A_GIT_REPOSITORY",
      });
    });
  });

  describe("commit inspection", () => {
    it("reviews a normal commit against its first parent", async () => {
      const root = path.join(scratch, "repo");
      initRepo(root, { "src/app.ts": "const a = 1;\n" });
      write(root, "src/app.ts", "const a = 2;\n");
      const sha = commitAll(root, "change app");

      const result = await adapter.commit(root, sha);
      expect(result.commit).toBe(sha);
      expect(result.parents).toEqual([revParse(root, "HEAD~1")]);
      expect(result.comparison_base).toBe(revParse(root, "HEAD~1"));
      expect(result.subject).toBe("change app");
      expect(result.author_name).toBe("Test");
      expect(result.files_changed).toBe(1);
      expect(result.redacted_files).toBe(0);
      expect(result.truncated).toBe(false);
      expect(result.diff).toContain("src/app.ts");
      expect(result.diff).toContain("+const a = 2;");
      expect(result.diff).toContain("-const a = 1;");
    });

    it("covers add, delete, rename, and filenames with spaces", async () => {
      const root = path.join(scratch, "repo");
      initRepo(root, {
        "src/app.ts": "one\n",
        "gone.txt": "soon gone\n",
        "with space.txt": "spaces\n",
      });
      write(root, "src/app.ts", "two\n");
      write(root, "added.txt", "added\n");
      fs.rmSync(path.join(root, "gone.txt"));
      git(root, "mv", "with space.txt", "renamed with space.txt");
      const sha = commitAll(root, "mixed shapes");

      const result = await adapter.commit(root, sha);
      expect(result.files_changed).toBe(4);
      expect(result.diff).toContain("added.txt");
      expect(result.diff).toContain("gone.txt");
      expect(result.diff).toContain("rename from with space.txt");
      expect(result.diff).toContain("rename to renamed with space.txt");
    });

    it("reviews a root commit against the empty tree", async () => {
      const root = path.join(scratch, "rootrepo");
      initRepo(root, { "a.txt": "a\n", "b/b.txt": "b\n" });
      const sha = revParse(root, "HEAD");

      const result = await adapter.commit(root, sha);
      expect(result.parents).toEqual([]);
      expect(result.comparison_base).toBeNull();
      expect(result.files_changed).toBe(2);
      expect(result.diff).toContain("a.txt");
      expect(result.diff).toContain("b/b.txt");
    });

    it("reviews a merge commit as first parent -> merge commit", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip, headTip } = buildDivergedRepo(root);
      git(root, "checkout", "-q", "feature");
      git(root, "merge", "-q", "--no-ff", "-m", "M: merge main into feature", "main");
      const mergeSha = revParse(root, "HEAD");

      const result = await adapter.commit(root, mergeSha);
      expect(result.parents).toEqual([headTip, baseTip]);
      expect(result.comparison_base).toBe(headTip);
      // First-parent diff shows only the main-side changes.
      expect(result.diff).toContain("base.ts");
      expect(result.diff).toContain("readme.md");
      expect(result.diff).not.toContain("feature.ts");
      // Metadata exposes both parents so the reviewer understands merge semantics.
      expect(result.parents).toHaveLength(2);
    });

    it("truncates oversized commit diffs with an explicit flag", async () => {
      const root = path.join(scratch, "big");
      initRepo(root, { "a.txt": "a\n" });
      write(root, "a.txt", `${"x".repeat(5000)}\n`);
      const sha = commitAll(root, "big change");

      const tiny = new GitAdapter({
        limits: { ...DEFAULT_LIMITS, maxDiffPayloadBytes: 500 },
        policy: new AccessPolicy(),
      });
      const result = await tiny.commit(root, sha);
      expect(result.truncated).toBe(true);
      expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(500);
      expect(result.diff).toContain("a.txt");
    });

    it("prevents repository-local config from executing external diff or textconv", async () => {
      const root = path.join(scratch, "pwn");
      initRepo(root, { "a.txt": "one\n" });
      write(root, "a.txt", "two\n");
      const sha = commitAll(root, "two");

      const marker = path.join(scratch, "marker.txt");
      const script = path.join(scratch, "pwn.sh");
      fs.writeFileSync(script, `#!/bin/sh\ntouch "${marker}"\necho FAKE DIFF\n`, { mode: 0o755 });
      git(root, "config", "diff.external", script);
      git(root, "config", "diff.pwn.textconv", script);
      fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt diff=pwn\n");

      const committed = await adapter.commit(root, sha);
      expect(fs.existsSync(marker)).toBe(false);
      expect(committed.diff).not.toContain("FAKE DIFF");
      expect(committed.diff).toContain("two");

      const base = revParse(root, "HEAD~1");
      const compared = await adapter.compare(root, base, sha, "direct");
      expect(fs.existsSync(marker)).toBe(false);
      expect(compared.diff).not.toContain("FAKE DIFF");
    });

    it("leaves the repository working tree and index unchanged", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip } = buildDivergedRepo(root);
      write(root, "src/app.ts", "const a = working-tree;\n"); // uncommitted noise

      const indexBefore = fs.readFileSync(path.join(root, ".git", "index")).toString("hex");
      const headBefore = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8");
      const porcelainBefore = git(root, "status", "--porcelain");

      await adapter.history(root, "HEAD", 10);
      await adapter.commit(root, "HEAD");
      await adapter.compare(root, baseTip, "HEAD", "direct");
      await adapter.compare(root, baseTip, "HEAD", "merge_base");

      const indexAfter = fs.readFileSync(path.join(root, ".git", "index")).toString("hex");
      const headAfter = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8");
      const porcelainAfter = git(root, "status", "--porcelain");
      expect(indexAfter).toBe(indexBefore);
      expect(headAfter).toBe(headBefore);
      expect(porcelainAfter).toBe(porcelainBefore);
    });
  });

  describe("compare", () => {
    it("direct mode compares resolved base -> resolved head", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip, headTip } = buildDivergedRepo(root);

      const result = await adapter.compare(root, baseTip, headTip, "direct");
      expect(result.mode).toBe("direct");
      expect(result.requested_base).toBe(baseTip);
      expect(result.head).toBe(headTip);
      expect(result.comparison_base).toBe(baseTip);
      // E -> Y includes the base-branch work as reversals plus the feature work.
      expect(result.diff).toContain("feature.ts");
      expect(result.diff).toContain("base.ts");
      expect(result.diff).toContain("readme.md");
    });

    it("merge_base mode reviews only the diverged feature work", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip, headTip, mergeBase } = buildDivergedRepo(root);

      const merged = await adapter.compare(root, baseTip, headTip, "merge_base");
      expect(merged.mode).toBe("merge_base");
      expect(merged.comparison_base).toBe(mergeBase);
      // B -> Y contains only the feature branch work.
      expect(merged.diff).toContain("feature.ts");
      expect(merged.diff).not.toContain("base.ts");
      expect(merged.diff).not.toContain("readme.md");

      // The modes must be observably different on this topology, so an
      // implementation that degrades merge_base into direct fails here.
      const direct = await adapter.compare(root, baseTip, headTip, "direct");
      expect(merged.diff).not.toBe(direct.diff);
      expect(merged.comparison_base).not.toBe(direct.comparison_base);
      expect(direct.diff).toContain("base.ts");
    });

    it("returns a valid empty comparison for identical base and head", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip } = buildDivergedRepo(root);

      for (const mode of ["direct", "merge_base"] as const) {
        const result = await adapter.compare(root, baseTip, baseTip, mode);
        expect(result.diff).toBe("");
        expect(result.files_changed).toBe(0);
        expect(result.truncated).toBe(false);
        expect(result.comparison_base).toBe(baseTip);
      }
    });

    it("fails with GIT_REVISION_NOT_FOUND for invalid base or head", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip } = buildDivergedRepo(root);
      await expect(adapter.compare(root, "nosuchref", "HEAD", "direct")).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });
      await expect(adapter.compare(root, baseTip, "nosuchref", "direct")).rejects.toMatchObject({
        code: "GIT_REVISION_NOT_FOUND",
      });
    });

    it("fails with GIT_NO_MERGE_BASE for unrelated histories", async () => {
      const root = path.join(scratch, "repo");
      initRepo(root, { "a.txt": "a\n" });
      write(root, "a.txt", "main work\n");
      const mainTip = commitAll(root, "main work");
      git(root, "checkout", "-q", "--orphan", "isolated");
      git(root, "rm", "-rqf", "--ignore-unmatch", "."); // empty the orphan branch
      write(root, "other.txt", "orphan\n");
      const orphanTip = commitAll(root, "orphan work");

      await expect(adapter.compare(root, mainTip, orphanTip, "merge_base")).rejects.toMatchObject({
        code: "GIT_NO_MERGE_BASE",
      });
    });

    it("excludes working-tree state from committed comparisons", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip, headTip, mergeBase } = buildDivergedRepo(root);
      write(root, "src/feature.ts", "export const feature = UNCOMMITTED;\n");
      write(root, "untracked.txt", "untracked\n");

      for (const mode of ["direct", "merge_base"] as const) {
        const result = await adapter.compare(root, mode === "direct" ? baseTip : mergeBase, headTip, mode);
        expect(result.diff).not.toContain("UNCOMMITTED");
        expect(result.diff).not.toContain("untracked.txt");
      }
    });

    it("reviews local-only commits without any remote", async () => {
      const root = path.join(scratch, "repo");
      const { baseTip, headTip } = buildDivergedRepo(root);
      // No remote is configured anywhere in this fixture; resolution and
      // comparison are purely local object-database operations.
      expect(git(root, "remote")).toBe("");
      const result = await adapter.compare(root, baseTip, headTip, "merge_base");
      expect(result.head).toBe(headTip);
      expect(result.diff).toContain("feature.ts");
    });
  });
});

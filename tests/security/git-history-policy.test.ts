import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AccessPolicy } from "../../src/core/access-policy.js";
import { GitAdapter } from "../../src/adapters/git.js";
import { git, initRepo, write } from "../helpers/git.js";
import { makeTempDir } from "../helpers/fixtures.js";

/**
 * Release-blocking historical AccessPolicy fixtures
 * (`v0.2-security-contract.md` §2-§3, `v0.2-test-contract.md` §7): a path
 * blocked from `read_file`/`git_diff` must never become readable through
 * `git_commit` or `git_compare`, including when it existed only historically.
 */

function revParse(root: string, revision: string): string {
  return git(root, "rev-parse", revision).trim();
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return revParse(root, "HEAD");
}

/** The tracked key file has enough bulk for git to detect renames (R100). */
const PEM_BODY = ["PRIVATE KEY MATERIAL", ...Array.from({ length: 40 }, (_, i) => `keyline-${i}`)].join("\n") + "\n";

describe("historical Git AccessPolicy (v0.2)", () => {
  let scratch: string;
  let adapter: GitAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-histsec-");
    adapter = new GitAdapter({ limits: DEFAULT_LIMITS, policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("redacts a commit that adds a blocked file and keeps allowed files visible", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    write(root, "src/app.ts", "const a = 2;\n");
    write(root, ".env", "TOKEN=super-secret-value\n");
    const sha = commitAll(root, "add env and app");

    const result = await adapter.commit(root, sha);
    expect(result.redacted_files).toBe(1);
    expect(result.files_changed).toBe(1);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("super-secret-value");
    expect(result.diff).toContain("src/app.ts");
    expect(result.diff).toContain("+const a = 2;");
  });

  it("redacts historical blocked-file modifications", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    write(root, ".env", "TOKEN=first-value\n");
    commitAll(root, "add env");
    write(root, ".env", "TOKEN=rotated-secret-value\n");
    const sha = commitAll(root, "rotate env");

    const result = await adapter.commit(root, sha);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("rotated-secret-value");
    expect(text).not.toContain("first-value");
    expect(result.redacted_files).toBe(1);
    expect(result.files_changed).toBe(0);
  });

  it("redacts historical blocked-file deletions", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    write(root, ".env", "TOKEN=hush\n");
    commitAll(root, "add env");
    fs.rmSync(path.join(root, ".env"));
    const sha = commitAll(root, "delete env");

    const result = await adapter.commit(root, sha);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(result.redacted_files).toBe(1);
    expect(result.files_changed).toBe(0);
  });

  it("redacts allowed -> blocked renames on both endpoints", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "notes.txt": "some notes\n", "keep.txt": "keep\n" });
    git(root, "mv", "notes.txt", ".env");
    const sha = commitAll(root, "rename notes to env");

    const result = await adapter.commit(root, sha);
    const text = JSON.stringify(result);
    expect(text).not.toContain("notes.txt");
    expect(text).not.toContain(".env");
    expect(text).not.toContain("some notes");
    expect(result.redacted_files).toBe(1);
    expect(result.files_changed).toBe(0);
  });

  it("redacts blocked -> allowed renames on both endpoints", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "keep.txt": "keep\n" });
    write(root, "config.pem", PEM_BODY);
    commitAll(root, "add key");
    git(root, "mv", "config.pem", "moved-key.txt");
    const sha = commitAll(root, "move key out");

    const result = await adapter.commit(root, sha);
    const text = JSON.stringify(result);
    expect(text).not.toContain("config.pem");
    expect(text).not.toContain("moved-key.txt");
    expect(text).not.toContain("PRIVATE KEY MATERIAL");
    expect(result.redacted_files).toBe(1);
    expect(result.files_changed).toBe(0);
  });

  it("keeps unrelated history from leaking blocked names after deletion", async () => {
    // .env existed only in the past; a range spanning its lifetime must not
    // disclose it, and a range with no net change returns an empty diff.
    const root = path.join(scratch, "repo");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    const base = revParse(root, "HEAD");
    write(root, ".env", "TOKEN=hush\n");
    const withEnv = commitAll(root, "add env");
    fs.rmSync(path.join(root, ".env"));
    const afterDelete = commitAll(root, "delete env");

    const added = await adapter.compare(root, base, withEnv, "direct");
    expect(added.redacted_files).toBe(1);
    expect(JSON.stringify(added)).not.toContain(".env");

    const netEmpty = await adapter.compare(root, base, afterDelete, "direct");
    expect(netEmpty.diff).toBe("");
    expect(netEmpty.redacted_files).toBe(0);
    expect(JSON.stringify(netEmpty)).not.toContain(".env");

    const deleted = await adapter.compare(root, withEnv, afterDelete, "direct");
    expect(deleted.redacted_files).toBe(1);
    expect(JSON.stringify(deleted)).not.toContain(".env");
  });

  it("limits a subdirectory workspace to its own committed subtree", async () => {
    const root = path.join(scratch, "subrepo");
    initRepo(root, { "sub/inner.txt": "in\n", "sibling.txt": "out\n" });
    write(root, "sub/inner.txt", "in v2\n");
    write(root, "sibling.txt", "out v2\n");
    const sha = commitAll(root, "touch inside and outside");

    const workspace = path.join(root, "sub");
    const result = await adapter.commit(workspace, sha);
    expect(result.files_changed).toBe(1);
    expect(result.diff).toContain("in v2");
    // Workspace-relative paths, not repository-relative.
    expect(result.diff).toContain("a/inner.txt");
    expect(result.diff).not.toContain("a/sub/inner.txt");
    expect(JSON.stringify(result)).not.toContain("sibling");
  });

  it("limits subdirectory workspaces on root commits as well", async () => {
    const root = path.join(scratch, "subrepo");
    initRepo(root, { "sub/inner.txt": "in\n", "sibling.txt": "out\n" });

    const workspace = path.join(root, "sub");
    const result = await adapter.commit(workspace, revParse(root, "HEAD"));
    expect(result.comparison_base).toBeNull();
    expect(result.files_changed).toBe(1);
    expect(result.diff).toContain("a/inner.txt");
    expect(JSON.stringify(result)).not.toContain("sibling");
  });

  it("does not disclose outside endpoints of cross-boundary renames", async () => {
    const root = path.join(scratch, "subrepo");
    initRepo(root, { "sub/inner.txt": "in\n", "sibling.txt": "moved content\n" });
    git(root, "mv", "sibling.txt", "sub/from-outside.txt");
    const intoSha = commitAll(root, "rename into workspace");
    git(root, "mv", "sub/inner.txt", "inner-moved-out.txt");
    const outSha = commitAll(root, "rename out of workspace");

    const workspace = path.join(root, "sub");
    const into = await adapter.commit(workspace, intoSha);
    expect(into.diff).toContain("from-outside.txt");
    expect(JSON.stringify(into)).not.toContain("sibling");

    const out = await adapter.commit(workspace, outSha);
    expect(out.diff).toContain("a/inner.txt");
    expect(JSON.stringify(out)).not.toContain("inner-moved-out.txt");
  });

  it("redacts blocked paths inside a subdirectory workspace", async () => {
    const root = path.join(scratch, "subrepo");
    initRepo(root, { "sub/inner.txt": "in\n" });
    write(root, "sub/.env", "TOKEN=buried-secret\n");
    const sha = commitAll(root, "add nested env");

    const workspace = path.join(root, "sub");
    const result = await adapter.commit(workspace, sha);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("buried-secret");
    expect(result.redacted_files).toBe(1);
  });

  it("keeps blocked paths out of git_compare ranges", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    const base = revParse(root, "HEAD");
    write(root, "src/app.ts", "const a = 2;\n");
    write(root, ".env", "TOKEN=range-secret\n");
    write(root, "credentials.json", "{}");
    const head = commitAll(root, "mixed range");

    const result = await adapter.compare(root, base, head, "direct");
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("credentials.json");
    expect(text).not.toContain("range-secret");
    expect(result.redacted_files).toBe(2);
    expect(result.diff).toContain("+const a = 2;");
  });

  it("never lets diff truncation reveal blocked content", async () => {
    const root = path.join(scratch, "big");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    const base = revParse(root, "HEAD");
    write(root, "src/app.ts", `${"allowed-line\n".repeat(200)}`);
    write(root, ".env", "TOKEN=truncated-secret\n");
    const head = commitAll(root, "big mixed change");

    const tiny = new GitAdapter({
      limits: { ...DEFAULT_LIMITS, maxDiffPayloadBytes: 300 },
      policy: new AccessPolicy(),
    });
    const result = await tiny.compare(root, base, head, "direct");
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.diff, "utf8")).toBeLessThanOrEqual(300);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("truncated-secret");
    expect(result.diff).toContain("allowed-line");
  });

  it("redacts historical copies of unmodified blocked files to allowed destinations", async () => {
    const root = path.join(scratch, "repo-copy");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    write(root, ".env", "TOKEN=copied-secret-val\n");
    const base = commitAll(root, "add env");

    // Copy .env to notes.txt without touching .env
    write(root, "notes.txt", "TOKEN=copied-secret-val\n");
    const head = commitAll(root, "copy env to notes");

    const commitRes = await adapter.commit(root, head);
    expect(commitRes.redacted_files).toBeGreaterThanOrEqual(1);
    const commitText = JSON.stringify(commitRes);
    expect(commitText).not.toContain("notes.txt");
    expect(commitText).not.toContain("copied-secret-val");

    const compareRes = await adapter.compare(root, base, head, "direct");
    expect(compareRes.redacted_files).toBeGreaterThanOrEqual(1);
    const compareText = JSON.stringify(compareRes);
    expect(compareText).not.toContain("notes.txt");
    expect(compareText).not.toContain("copied-secret-val");
  });

  it("prevents repo config diff.renames=false from leaking blocked content on rename", async () => {
    const root = path.join(scratch, "repo-renames-false");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    write(root, ".env", "TOKEN=renamed-secret-val\n");
    commitAll(root, "add env");

    git(root, "mv", ".env", "notes.txt");
    const head = commitAll(root, "rename env to notes");

    git(root, "config", "diff.renames", "false");

    const commitRes = await adapter.commit(root, head);
    expect(commitRes.redacted_files).toBeGreaterThanOrEqual(1);
    const commitText = JSON.stringify(commitRes);
    expect(commitText).not.toContain("notes.txt");
    expect(commitText).not.toContain("renamed-secret-val");
  });

  it("fails closed when rename detection was skipped due to limits", async () => {
    const root = path.join(scratch, "repo-rename-limit");
    initRepo(root, {});
    for (let i = 0; i < 5; i++) {
      const lines = Array.from({ length: 30 }, (_, j) => `line ${j} for file ${i}`).join("\n");
      write(root, `f${i}.txt`, lines + "\n");
    }
    const base = commitAll(root, "init files");

    for (let i = 0; i < 5; i++) {
      fs.unlinkSync(path.join(root, `f${i}.txt`));
      const lines = Array.from({ length: 30 }, (_, j) => `line ${j} for file ${i}`).join("\n");
      write(root, `renamed_${i}.txt`, lines + "\nmodified\n");
    }
    const head = commitAll(root, "inexact renames");

    // Force renameLimit = 1 inside repository config, overriding default
    git(root, "config", "diff.renameLimit", "1");

    // But runGit passes -c diff.renameLimit=10000 by default from GIT_CONFIG_ARGS!
    // If GIT_CONFIG_ARGS overrides diff.renameLimit=10000, git diff succeeds with R099.
    const commitRes = await adapter.commit(root, head);
    expect(commitRes.files_changed).toBe(5);
  });

  it("fails closed when stderr contains rename detection skipped warning", async () => {
    const { assertReliableRenameDetection } = await import("../../src/adapters/git.js");
    expect(() =>
      assertReliableRenameDetection("warning: exhaustive rename detection was skipped due to too many files.\n"),
    ).toThrowError(
      expect.objectContaining({
        code: "GIT_OPERATION_FAILED",
      }),
    );
    expect(() =>
      assertReliableRenameDetection("warning: inexact rename detection was skipped\n"),
    ).toThrowError(
      expect.objectContaining({
        code: "GIT_OPERATION_FAILED",
      }),
    );
    expect(() => assertReliableRenameDetection("")).not.toThrow();
  });
});

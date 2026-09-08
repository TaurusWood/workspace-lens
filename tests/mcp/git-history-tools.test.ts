import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { GitAdapter } from "../../src/adapters/git.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createToolContext, createWorkspaceLensServer } from "../../src/mcp/server.js";
import type { ToolContext } from "../../src/mcp/context.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import type { Logger } from "../../src/core/logger.js";
import { git, initRepo, write } from "../helpers/git.js";
import { makeTempDir } from "../helpers/fixtures.js";

/**
 * Phase 2-4 MCP-path contract tests (`v0.2-test-contract.md` §3-§6):
 * git_history, git_commit, and git_compare exercised through the real MCP
 * boundary, including schema strictness and rejection before adapter use.
 */

function revParse(root: string, revision: string): string {
  return git(root, "rev-parse", revision).trim();
}

function commitAll(root: string, message: string): string {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return revParse(root, "HEAD");
}

/** Diverged topology from `v0.2-test-contract.md` §2. */
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

describe("historical git tools over MCP", () => {
  let scratch: string;
  let diverged: string;
  let unborn: string;
  let plain: string;
  let context: ToolContext;
  let client: Client;

  beforeEach(async () => {
    scratch = makeTempDir("wl-mcp-histgit-");
    diverged = path.join(scratch, "diverged");
    buildDivergedRepo(diverged);

    unborn = path.join(scratch, "unborn");
    initRepo(unborn);

    plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);

    const logger: Logger = {
      toolCall: () => undefined,
      event: () => undefined,
      error: () => undefined,
    };
    const registry = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [
        { workspace_id: "diverged", name: "Diverged", root: diverged, enabled: true },
        { workspace_id: "unborn", name: "Unborn", root: unborn, enabled: true },
        { workspace_id: "plain", name: "Plain", root: plain, enabled: true },
        // Fixture roots are created lazily inside individual tests.
        {
          workspace_id: "sensitive",
          name: "Sensitive",
          root: path.join(scratch, "sensitive"),
          enabled: true,
        },
        {
          workspace_id: "sub",
          name: "Sub",
          root: path.join(scratch, "subrepo", "sub"),
          enabled: true,
        },
        {
          workspace_id: "orphan",
          name: "Orphan",
          root: path.join(scratch, "orphan"),
          enabled: true,
        },
        {
          workspace_id: "mixed",
          name: "Mixed",
          root: path.join(scratch, "mixed"),
          enabled: true,
        },
      ],
    });
    context = createToolContext({ registry, logger });

    const server = createWorkspaceLensServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  function envelope(result: CallToolResult): any {
    return result.structuredContent;
  }

  // ---------------------------------------------------------------------
  // git_history
  // ---------------------------------------------------------------------

  it("git_history returns bounded metadata with the resolved start SHA", async () => {
    const result = await call("git_history", { workspace_id: "diverged", start: "main" });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.workspace_id).toBe("diverged");
    expect(data.start).toBe(revParse(diverged, "main"));
    expect(data.commits.map((commit: any) => commit.subject)).toEqual([
      "E: docs",
      "D: change base",
      "C: add base",
      "B: add shared",
      "init",
    ]);
    expect(data.commits[0]).toMatchObject({
      commit: revParse(diverged, "main"),
      author_name: "Test",
    });
    expect(data.commits[0].committed_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(data.truncated).toBe(false);
  });

  it("git_history defaults to HEAD and reports truncation", async () => {
    const defaultCall = envelope(await call("git_history", { workspace_id: "diverged" }));
    expect(defaultCall.data.start).toBe(revParse(diverged, "HEAD"));
    expect(defaultCall.data.commits[0].subject).toBe("E: docs");

    const bounded = envelope(
      await call("git_history", { workspace_id: "diverged", max_commits: 2 }),
    );
    expect(bounded.data.commits).toHaveLength(2);
    expect(bounded.data.truncated).toBe(true);
  });

  it("git_history rejects invalid revision grammar with INVALID_ARGUMENT before adapter use", async () => {
    const spy = vi.spyOn(GitAdapter.prototype, "history");
    try {
      for (const start of ["HEAD~1", "HEAD^", "main..HEAD", "@{upstream}", "--all", "a//b"]) {
        const result = await call("git_history", { workspace_id: "diverged", start });
        expect(result.isError, start).toBe(true);
        expect(envelope(result).error.code, start).toBe("INVALID_ARGUMENT");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("git_history rejects unknown properties and out-of-bounds max_commits", async () => {
    const extra = await call("git_history", { workspace_id: "diverged", pathspec: "--all" });
    expect(extra.isError).toBe(true);
    expect(JSON.stringify(extra)).toContain("Unrecognized key");

    const zero = await call("git_history", { workspace_id: "diverged", max_commits: 0 });
    expect(zero.isError).toBe(true);

    const overCeiling = await call("git_history", {
      workspace_id: "diverged",
      max_commits: DEFAULT_LIMITS.maxGitHistoryCommits + 1,
    });
    expect(overCeiling.isError).toBe(true);
  });

  it("git_history reports stable errors for unborn and non-Git workspaces", async () => {
    const noCommits = await call("git_history", { workspace_id: "unborn" });
    expect(envelope(noCommits).error.code).toBe("GIT_REVISION_NOT_FOUND");

    const notGit = await call("git_history", { workspace_id: "plain" });
    expect(envelope(notGit).error.code).toBe("NOT_A_GIT_REPOSITORY");

    const unknownWorkspace = await call("git_history", { workspace_id: "ghost" });
    expect(envelope(unknownWorkspace).error.code).toBe("WORKSPACE_NOT_FOUND");
  });

  // ---------------------------------------------------------------------
  // git_commit
  // ---------------------------------------------------------------------

  it("git_commit inspects a normal commit against its first parent", async () => {
    const head = revParse(diverged, "HEAD");
    const result = await call("git_commit", { workspace_id: "diverged", revision: "HEAD" });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.workspace_id).toBe("diverged");
    expect(data.commit).toBe(head);
    expect(data.parents).toEqual([revParse(diverged, "HEAD~1")]);
    expect(data.comparison_base).toBe(revParse(diverged, "HEAD~1"));
    expect(data.subject).toBe("E: docs");
    expect(data.diff).toContain("docs/readme.md");
    expect(data.files_changed).toBe(1);
    expect(data.redacted_files).toBe(0);
    expect(data.truncated).toBe(false);
  });

  it("git_commit reviews root and merge commits with contract comparison bases", async () => {
    const rootResult = await call("git_commit", {
      workspace_id: "diverged",
      revision: revParse(diverged, "main~4"),
    });
    const rootData = envelope(rootResult).data;
    expect(rootData.parents).toEqual([]);
    expect(rootData.comparison_base).toBeNull();
    expect(rootData.diff).toContain("src/app.ts");

    git(diverged, "checkout", "-q", "feature");
    git(diverged, "merge", "-q", "--no-ff", "-m", "M: merge main into feature", "main");
    const mergeData = envelope(
      await call("git_commit", { workspace_id: "diverged", revision: "HEAD" }),
    ).data;
    expect(mergeData.parents).toHaveLength(2);
    expect(mergeData.comparison_base).toBe(mergeData.parents[0]);
    expect(mergeData.diff).toContain("src/base.ts");
  });

  it("git_commit redacts historically blocked content through MCP", async () => {
    const root = path.join(scratch, "sensitive");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    write(root, "src/app.ts", "const a = 2;\n");
    write(root, ".env", "TOKEN=mcp-secret-value\n");
    const sha = commitAll(root, "mixed sensitive commit");

    const result = await call("git_commit", { workspace_id: "sensitive", revision: sha });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.files_changed).toBe(1);
    expect(data.redacted_files).toBe(1);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("mcp-secret-value");
    expect(data.diff).toContain("+const a = 2;");
  });

  it("git_commit inspects a local-only commit inside a subdirectory workspace", async () => {
    const root = path.join(scratch, "subrepo");
    initRepo(root, { "sub/inner.txt": "in\n", "sibling.txt": "out\n" });
    write(root, "sub/inner.txt", "in v2\n");
    write(root, "sibling.txt", "out v2\n");
    const sha = commitAll(root, "touch inside and outside");

    const result = await call("git_commit", { workspace_id: "sub", revision: sha });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.files_changed).toBe(1);
    expect(data.diff).toContain("a/inner.txt");
    expect(data.diff).not.toContain("a/sub/inner.txt");
    expect(JSON.stringify(result)).not.toContain("sibling");
  });

  it("git_commit rejects invalid revision grammar before adapter use", async () => {
    const spy = vi.spyOn(GitAdapter.prototype, "commit");
    try {
      for (const revision of ["HEAD~1", "HEAD:path", "main...HEAD", "-b", "x.lock"]) {
        const result = await call("git_commit", { workspace_id: "diverged", revision });
        expect(result.isError, revision).toBe(true);
        expect(envelope(result).error.code, revision).toBe("INVALID_ARGUMENT");
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("git_commit reports stable errors and rejects unknown properties", async () => {
    const unknownRevision = await call("git_commit", {
      workspace_id: "diverged",
      revision: "nosuchref",
    });
    expect(envelope(unknownRevision).error.code).toBe("GIT_REVISION_NOT_FOUND");

    const unbornHead = await call("git_commit", { workspace_id: "unborn", revision: "HEAD" });
    expect(envelope(unbornHead).error.code).toBe("GIT_REVISION_NOT_FOUND");

    const notGit = await call("git_commit", { workspace_id: "plain", revision: "HEAD" });
    expect(envelope(notGit).error.code).toBe("NOT_A_GIT_REPOSITORY");

    const extra = await call("git_commit", {
      workspace_id: "diverged",
      revision: "HEAD",
      args: ["--patch"],
    });
    expect(extra.isError).toBe(true);
    expect(JSON.stringify(extra)).toContain("Unrecognized key");
  });

  it("git_commit truncates oversized diffs at the server ceiling", async () => {
    const root = path.join(scratch, "big");
    initRepo(root, { "a.txt": "a\n" });
    write(root, "a.txt", `${"x".repeat(5000)}\n`);
    const sha = commitAll(root, "big change");

    const tight = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [{ workspace_id: "big", name: "Big", root, enabled: true }],
    });
    const tightContext = createToolContext({
      registry: tight,
      limits: { ...DEFAULT_LIMITS, maxDiffPayloadBytes: 500 },
    });
    const server2 = createWorkspaceLensServer(tightContext);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "tight", version: "0.0.0" });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const result = (await client2.callTool({
      name: "git_commit",
      arguments: { workspace_id: "big", revision: sha },
    })) as CallToolResult;
    const data = envelope(result).data;
    expect(data.truncated).toBe(true);
    expect(Buffer.byteLength(data.diff, "utf8")).toBeLessThanOrEqual(500);
    await client2.close();
  });

  // ---------------------------------------------------------------------
  // git_compare
  // ---------------------------------------------------------------------

  it("git_compare direct mode compares resolved base -> resolved head", async () => {
    const baseTip = revParse(diverged, "main");
    const headTip = revParse(diverged, "feature");
    const result = await call("git_compare", {
      workspace_id: "diverged",
      base: "main",
      head: "feature",
      mode: "direct",
    });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.workspace_id).toBe("diverged");
    expect(data.mode).toBe("direct");
    expect(data.requested_base).toBe(baseTip);
    expect(data.head).toBe(headTip);
    expect(data.comparison_base).toBe(baseTip);
    expect(data.diff).toContain("feature.ts");
    expect(data.diff).toContain("base.ts"); // post-divergence base work appears as reversals
  });

  it("git_compare merge_base mode excludes unrelated post-divergence base commits", async () => {
    const mergeBase = git(diverged, "merge-base", "main", "feature").trim();
    const headTip = revParse(diverged, "feature");
    const result = await call("git_compare", {
      workspace_id: "diverged",
      base: "main",
      head: "feature",
      mode: "merge_base",
    });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.mode).toBe("merge_base");
    expect(data.comparison_base).toBe(mergeBase);
    expect(data.head).toBe(headTip);
    expect(data.diff).toContain("feature.ts");
    // The discriminator: direct includes base.ts, merge_base must not. A
    // merge_base implementation that behaves like direct fails here.
    expect(data.diff).not.toContain("base.ts");
    expect(data.files_changed).toBe(1);
  });

  it("git_compare defaults head to HEAD and mode to direct", async () => {
    const baseSha = revParse(diverged, "main~1"); // tests resolve via trusted git; the tool input is a plain SHA
    const data = envelope(await call("git_compare", { workspace_id: "diverged", base: baseSha }))
      .data;
    expect(data.mode).toBe("direct");
    expect(data.head).toBe(revParse(diverged, "HEAD"));
    expect(data.comparison_base).toBe(baseSha);
  });

  it("git_compare returns an empty diff for identical base and head", async () => {
    const tip = revParse(diverged, "main");
    for (const mode of ["direct", "merge_base"]) {
      const data = envelope(
        await call("git_compare", { workspace_id: "diverged", base: tip, head: tip, mode }),
      ).data;
      expect(data.diff).toBe("");
      expect(data.files_changed).toBe(0);
      expect(data.truncated).toBe(false);
    }
  });

  it("git_compare rejects invalid revisions and unrelated histories with stable errors", async () => {
    const spy = vi.spyOn(GitAdapter.prototype, "compare");
    try {
      for (const args of [
        { base: "HEAD~1", head: "HEAD" },
        { base: "main", head: "@{upstream}" },
        { base: "-C", head: "HEAD" },
        { base: "main", head: "HEAD", mode: "not-a-mode" },
      ]) {
        const result = await call("git_compare", { workspace_id: "diverged", ...args });
        expect(result.isError, JSON.stringify(args)).toBe(true);
      }
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }

    const unknownBase = await call("git_compare", {
      workspace_id: "diverged",
      base: "nosuchref",
    });
    expect(envelope(unknownBase).error.code).toBe("GIT_REVISION_NOT_FOUND");

    const unknownHead = await call("git_compare", {
      workspace_id: "diverged",
      base: "main",
      head: "nosuchref",
    });
    expect(envelope(unknownHead).error.code).toBe("GIT_REVISION_NOT_FOUND");

    const root = path.join(scratch, "orphan");
    initRepo(root, { "a.txt": "a\n" });
    write(root, "a.txt", "main work\n");
    const mainTip = commitAll(root, "main work");
    git(root, "checkout", "-q", "--orphan", "isolated");
    git(root, "rm", "-rqf", "--ignore-unmatch", ".");
    write(root, "other.txt", "orphan\n");
    const orphanTip = commitAll(root, "orphan work");

    const noBase = await call("git_compare", {
      workspace_id: "orphan",
      base: mainTip,
      head: orphanTip,
      mode: "merge_base",
    });
    expect(envelope(noBase).error.code).toBe("GIT_NO_MERGE_BASE");
  });

  it("git_compare excludes working-tree state and keeps blocked paths redacted", async () => {
    const root = path.join(scratch, "mixed");
    initRepo(root, { "src/app.ts": "const a = 1;\n" });
    const base = revParse(root, "HEAD");
    write(root, "src/app.ts", "const a = 2;\n");
    write(root, ".env", "TOKEN=committed-secret\n");
    const head = commitAll(root, "mixed commit");
    write(root, "src/app.ts", "const a = UNCOMMITTED;\n"); // working-tree noise

    const result = await call("git_compare", { workspace_id: "mixed", base, head });
    expect(result.isError).toBeFalsy();
    const data = envelope(result).data;
    expect(data.diff).toContain("+const a = 2;");
    expect(data.diff).not.toContain("UNCOMMITTED");
    expect(data.redacted_files).toBe(1);
    const text = JSON.stringify(result);
    expect(text).not.toContain(".env");
    expect(text).not.toContain("committed-secret");
  });

  it("historical inspection through MCP leaves repository and index unchanged", async () => {
    const indexBefore = fs.readFileSync(path.join(diverged, ".git", "index")).toString("hex");
    const headBefore = fs.readFileSync(path.join(diverged, ".git", "HEAD"), "utf8");
    const porcelainBefore = git(diverged, "status", "--porcelain");
    const mainTip = revParse(diverged, "main");

    await call("git_history", { workspace_id: "diverged", start: "main", max_commits: 5 });
    await call("git_commit", { workspace_id: "diverged", revision: mainTip });
    await call("git_compare", {
      workspace_id: "diverged",
      base: "main",
      head: "feature",
      mode: "merge_base",
    });

    const indexAfter = fs.readFileSync(path.join(diverged, ".git", "index")).toString("hex");
    const headAfter = fs.readFileSync(path.join(diverged, ".git", "HEAD"), "utf8");
    const porcelainAfter = git(diverged, "status", "--porcelain");
    expect(indexAfter).toBe(indexBefore);
    expect(headAfter).toBe(headBefore);
    expect(porcelainAfter).toBe(porcelainBefore);
  });

  it("historical tool errors never disclose raw Git command lines", async () => {
    const result = await call("git_history", { workspace_id: "plain", start: "HEAD" });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result);
    expect(text).not.toContain("rev-parse");
    expect(text).not.toContain("execFile");
    expect(envelope(result).error.message).toBe("The workspace is not inside a Git repository.");
  });
});

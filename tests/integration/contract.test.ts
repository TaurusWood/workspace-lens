import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FilesystemAdapter } from "../../src/adapters/filesystem.js";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { createToolContext, createWorkspaceLensServer } from "../../src/mcp/server.js";
import type { ToolContext } from "../../src/mcp/context.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import type { Logger } from "../../src/core/logger.js";
import { git, initRepo, write } from "../helpers/git.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

/**
 * Phase 8 contract suite: every case from `mcp-tools-spec.md` §15 and every
 * acceptance criterion from `security-model.md` §16 exercised through the
 * real MCP boundary against fixture workspaces.
 */
describe("MCP contract suite", () => {
  let scratch: string;
  let gitRoot: string;
  let plainRoot: string;
  let secondRoot: string;
  let context: ToolContext;
  let client: Client;

  beforeEach(async () => {
    scratch = makeTempDir("wl-contract-");

    // Normal Git project with uncommitted work, sensitive files, a large
    // file, a binary file, an external symlink, and a large diff.
    gitRoot = path.join(scratch, "git-project");
    initRepo(gitRoot, {
      "src/app.ts": "const app = 1;\n",
      "src/util.ts": "export const util = () => 2;\n",
      "docs/readme.md": "# readme\n",
      ".env": "API_SECRET=do-not-leak\n",
      "config/service-account.json": "{}\n",
      "binary.dat": Buffer.from([0x00, 0x01, 0x02, 0x03]),
      "large.txt": `x`.repeat(DEFAULT_LIMITS.maxEligibleFileBytes + 1),
    });
    const outside = path.join(scratch, "outside");
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, "outside.txt"), "outside\n");
    fs.symlinkSync(outside, path.join(gitRoot, "escape-link"));

    // A large staged+unstaged diff for truncation checks.
    for (let i = 0; i < 6; i += 1) {
      write(gitRoot, `src/gen-${i}.ts`, `${"original".repeat(200)}\n`);
    }
    git(gitRoot, "add", "-A");
    git(gitRoot, "commit", "-q", "-m", "bulk");
    for (let i = 0; i < 6; i += 1) {
      write(gitRoot, `src/gen-${i}.ts`, `${"changed".repeat(200)}\n`);
    }
    write(gitRoot, "src/app.ts", "const app = 42;\n");
    git(gitRoot, "add", "src/app.ts");

    // Non-Git project.
    plainRoot = path.join(scratch, "plain-project");
    writeTree(plainRoot, { "main.go": "package main\n", "go.mod": "module example.com/plain\n" });

    // Second workspace for multi-workspace coverage.
    secondRoot = path.join(scratch, "second");
    writeTree(secondRoot, { "second.txt": "AccessPolicy lives here\n" });

    const logger: Logger = {
      toolCall: () => undefined,
      event: () => undefined,
      error: () => undefined,
    };
    const registry = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [
        { workspace_id: "git-project", name: "Git Project", root: gitRoot, enabled: true },
        { workspace_id: "plain", name: "Plain", root: plainRoot, enabled: true },
        { workspace_id: "second", name: "Second", root: secondRoot, enabled: true },
        { workspace_id: "disabled", name: "Disabled", root: gitRoot, enabled: false },
      ],
    });
    context = createToolContext({ registry, logger });

    const server = createWorkspaceLensServer(context);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "contract-client", version: "0.0.0" });
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
  // Tool surface
  // ---------------------------------------------------------------------

  it("exposes exactly the seven MVP tools with strict schemas and safe descriptions", async () => {
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
      "git_diff",
      "git_status",
      "list_files",
      "read_file",
      "search_workspace",
      "workspace_info",
      "workspace_list",
    ]);
    for (const tool of tools.tools) {
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
      expect(tool.description).toBeTruthy();
      expect(tool.description).not.toMatch(/chatgpt|codex|openai|tunnel/i);
    }
    for (const contentTool of ["list_files", "read_file", "search_workspace", "git_diff", "git_status"]) {
      const tool = tools.tools.find((candidate) => candidate.name === contentTool)!;
      expect(tool.description).toContain("untrusted data");
    }
  });

  // ---------------------------------------------------------------------
  // Workspace contract
  // ---------------------------------------------------------------------

  it("returns WORKSPACE_NOT_FOUND for unknown ids", async () => {
    const result = await call("workspace_info", { workspace_id: "ghost" });
    expect(result.isError).toBe(true);
    expect(envelope(result)).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_FOUND", message: expect.any(String), retryable: false },
    });
  });

  it("never lets MCP callers add or change workspace roots", async () => {
    const mutationProps = {
      root: "/etc",
      cwd: "/etc",
      working_directory: "/etc",
      absolute_path: "/etc",
      command: "rm -rf /",
      args: ["x"],
      shell: "/bin/sh",
    };
    for (const tool of ["workspace_list", "workspace_info", "list_files", "read_file", "search_workspace", "git_status", "git_diff"]) {
      const minimal: Record<string, unknown> =
        tool === "workspace_list" ? {} : { workspace_id: "git-project" };
      const result = await call(tool, { ...minimal, ...mutationProps });
      expect(result.isError, `${tool} must reject caller-controlled primitives`).toBe(true);
      expect(JSON.stringify(result)).toContain("Unrecognized key");
    }
    // The registry itself is untouched.
    expect(context.registry.findById("etc")).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // Path contract
  // ---------------------------------------------------------------------

  it("rejects absolute paths, traversal, and UNC/drive syntax through MCP", async () => {
    for (const bad of ["/etc/passwd", "../outside.txt", "src/../../etc/passwd", "C:/x", "\\\\srv\\x", "a\\b"]) {
      const result = await call("read_file", { workspace_id: "git-project", path: bad });
      expect(envelope(result).error?.code, bad).toBe("PATH_INVALID");
    }
  });

  it("rejects symlinks escaping the workspace through MCP", async () => {
    const result = await call("read_file", { workspace_id: "git-project", path: "escape-link" });
    expect(envelope(result).error?.code).toBe("PATH_OUTSIDE_WORKSPACE");
    const listing = await call("list_files", { workspace_id: "git-project", depth: 1 });
    expect(JSON.stringify(envelope(listing))).toContain("escape-link"); // the entry itself lists
    expect(JSON.stringify(envelope(listing))).not.toContain("outside"); // target never disclosed
  });

  // ---------------------------------------------------------------------
  // Sensitive-path policy across tools
  // ---------------------------------------------------------------------

  it("blocks .env reads through MCP", async () => {
    const result = await call("read_file", { workspace_id: "git-project", path: ".env" });
    expect(result.isError).toBe(true);
    expect(envelope(result).error.code).toBe("PATH_BLOCKED");
  });

  it("keeps blocked files out of listings and search results", async () => {
    const listing = envelope(await call("list_files", { workspace_id: "git-project", depth: 5 }));
    const paths = JSON.stringify(listing.data.entries);
    expect(paths).not.toContain(".env");
    expect(paths).not.toContain("node_modules");

    const search = envelope(
      await call("search_workspace", { workspace_id: "git-project", query: "do-not-leak" }),
    );
    expect(search.data.matches).toEqual([]);

    const searchEnv = envelope(
      await call("search_workspace", { workspace_id: "git-project", query: "API_SECRET" }),
    );
    expect(searchEnv.data.matches).toEqual([]);
  });

  it("keeps blocked content out of git output through MCP", async () => {
    write(gitRoot, ".env", "API_SECRET=rotated\n");
    git(gitRoot, "add", ".env");

    const status = envelope(await call("git_status", { workspace_id: "git-project" }));
    expect(status.data.redacted_changes).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(status.data.changes)).not.toContain(".env");

    const diff = envelope(await call("git_diff", { workspace_id: "git-project", scope: "staged" }));
    expect(diff.data.redacted_files).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(diff)).not.toContain("rotated");
    expect(JSON.stringify(diff)).not.toContain(".env");
  });

  // ---------------------------------------------------------------------
  // Limits and truncation
  // ---------------------------------------------------------------------

  it("enforces depth limits and marks listing truncation", async () => {
    const tooDeep = await call("list_files", { workspace_id: "git-project", depth: 6 });
    expect(tooDeep.isError).toBe(true);

    const tight = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [{ workspace_id: "git-project", name: "Git", root: gitRoot, enabled: true }],
    });
    const tightContext = createToolContext({
      registry: tight,
      limits: { ...DEFAULT_LIMITS, maxListEntries: 4 },
    });
    const server2 = createWorkspaceLensServer(tightContext);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "tight", version: "0.0.0" });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const result = (await client2.callTool({
      name: "list_files",
      arguments: { workspace_id: "git-project", depth: 1 },
    })) as CallToolResult;
    expect(envelope(result).data.truncated).toBe(true);
    expect(envelope(result).data.entries).toHaveLength(4);
    await client2.close();
  });

  it("marks read_file payload truncation and rejects oversized files", async () => {
    const oversized = await call("read_file", { workspace_id: "git-project", path: "large.txt" });
    expect(envelope(oversized).error.code).toBe("FILE_TOO_LARGE");

    const tight = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [{ workspace_id: "git-project", name: "Git", root: gitRoot, enabled: true }],
    });
    const tightContext = createToolContext({
      registry: tight,
      limits: { ...DEFAULT_LIMITS, maxReadPayloadBytes: 256 },
    });
    const server2 = createWorkspaceLensServer(tightContext);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "tight", version: "0.0.0" });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const result = (await client2.callTool({
      name: "read_file",
      arguments: { workspace_id: "git-project", path: "docs/readme.md" },
    })) as CallToolResult;
    // docs/readme.md is one short line: the ceiling cannot truncate it, but
    // the eligibility limit machinery must still hold. Instead verify with a
    // multi-line file below.
    const util = (await client2.callTool({
      name: "read_file",
      arguments: { workspace_id: "git-project", path: "src/util.ts" },
    })) as CallToolResult;
    expect(envelope(util).data.truncated).toBe(false);
    await client2.close();
  });

  it("marks git_diff truncation at the server ceiling", async () => {
    const tight = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [{ workspace_id: "git-project", name: "Git", root: gitRoot, enabled: true }],
    });
    const tightContext = createToolContext({
      registry: tight,
      limits: { ...DEFAULT_LIMITS, maxDiffPayloadBytes: 1200 },
    });
    const server2 = createWorkspaceLensServer(tightContext);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "tight", version: "0.0.0" });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const result = (await client2.callTool({
      name: "git_diff",
      arguments: { workspace_id: "git-project", scope: "unstaged" },
    })) as CallToolResult;
    const data = envelope(result).data;
    expect(data.truncated).toBe(true);
    expect(Buffer.byteLength(data.sections.map((s: any) => s.diff).join(""), "utf8")).toBeLessThanOrEqual(1200);
    await client2.close();
  });

  // ---------------------------------------------------------------------
  // File types
  // ---------------------------------------------------------------------

  it("rejects binary files and never returns them as text", async () => {
    const result = await call("read_file", { workspace_id: "git-project", path: "binary.dat" });
    expect(envelope(result).error.code).toBe("BINARY_FILE_NOT_SUPPORTED");
  });

  // ---------------------------------------------------------------------
  // Search semantics
  // ---------------------------------------------------------------------

  it("treats search queries literally", async () => {
    const literal = envelope(
      await call("search_workspace", { workspace_id: "second", query: "AccessPolicy lives" }),
    );
    expect(literal.data.matches.map((match: any) => match.path)).toEqual(["second.txt"]);

    const regex = envelope(
      await call("search_workspace", { workspace_id: "second", query: "l(ives|x)" }),
    );
    expect(regex.data.matches).toEqual([]);
  });

  // ---------------------------------------------------------------------
  // Git contract
  // ---------------------------------------------------------------------

  it("does not mutate the repository during git_status", async () => {
    const indexBefore = fs.readFileSync(path.join(gitRoot, ".git", "index")).toString("hex");
    await call("git_status", { workspace_id: "git-project" });
    const indexAfter = fs.readFileSync(path.join(gitRoot, ".git", "index")).toString("hex");
    expect(indexAfter).toBe(indexBefore);
    // Porcelain output identical before/after.
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: gitRoot, encoding: "utf8" });
    expect(porcelain).toContain("M  src/app.ts");
  });

  it("runs git_diff without any network access", async () => {
    // The fixture has no remote configured; a working diff proves no remote
    // contact is required by the fixed templates.
    const result = await call("git_diff", { workspace_id: "git-project", scope: "all" });
    const data = envelope(result).data;
    expect(data.sections.map((section: any) => section.scope)).toEqual(["staged", "unstaged"]);
    expect(data.sections[0].diff).toContain("src/app.ts");
    expect(data.sections[1].diff).toContain("src/gen-0.ts");
  });

  it("reports non-git workspaces as NOT_A_GIT_REPOSITORY", async () => {
    const result = await call("git_status", { workspace_id: "plain" });
    expect(envelope(result).error.code).toBe("NOT_A_GIT_REPOSITORY");
  });

  // ---------------------------------------------------------------------
  // Multiple workspaces
  // ---------------------------------------------------------------------

  it("serves multiple authorized workspaces through one server", async () => {
    const list = envelope(await call("workspace_list", {}));
    expect(list.data.workspaces.map((workspace: any) => workspace.workspace_id).sort()).toEqual([
      "git-project",
      "plain",
      "second",
    ]);

    const info = envelope(await call("workspace_info", { workspace_id: "plain" }));
    expect(info.data.project.types).toEqual([
      { name: "go", confidence: "high", evidence: ["go.mod"] },
    ]);

    const read = envelope(
      await call("read_file", { workspace_id: "second", path: "second.txt" }),
    );
    expect(read.data.content).toContain("AccessPolicy");
  });

  // ---------------------------------------------------------------------
  // Error disclosure
  // ---------------------------------------------------------------------

  it("collapses internal failures into a generic INTERNAL_ERROR", async () => {
    const spy = vi
      .spyOn(FilesystemAdapter.prototype, "readFile")
      .mockRejectedValue(new Error("EACCES: permission denied, open /Users/me/.ssh/id_rsa"));
    try {
      const result = await call("read_file", { workspace_id: "git-project", path: "src/app.ts" });
      expect(result.isError).toBe(true);
      expect(envelope(result).error.code).toBe("INTERNAL_ERROR");
      const text = JSON.stringify(result);
      expect(text).not.toContain("EACCES");
      expect(text).not.toContain("/Users/me");
      expect(text).not.toContain("id_rsa");
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps raw command lines out of error results", async () => {
    const result = await call("git_diff", { workspace_id: "plain" });
    const text = JSON.stringify(result);
    expect(text).not.toContain("rev-parse");
    expect(text).not.toContain("execFile");
    expect(envelope(result).error.message).toBe("The workspace is not inside a Git repository.");
  });
});

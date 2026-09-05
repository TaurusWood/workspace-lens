import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createToolContext, createWorkspaceLensServer } from "../../src/mcp/server.js";
import type { ToolContext } from "../../src/mcp/context.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import type { Logger } from "../../src/core/logger.js";
import { git, initRepo, write } from "../helpers/git.js";
import { makeTempDir } from "../helpers/fixtures.js";

describe("git tools over MCP", () => {
  let scratch: string;
  let root: string;
  let plainRoot: string;
  let context: ToolContext;
  let client: Client;

  beforeEach(async () => {
    scratch = makeTempDir("wl-mcp-git-");
    root = path.join(scratch, "repo");
    initRepo(root, { "src/app.ts": "const a = 1;\n", ".env": "TOKEN=hush\n" });
    write(root, "src/app.ts", "const a = 2;\n");
    plainRoot = path.join(scratch, "plain");
    fs.mkdirSync(plainRoot);

    const logger: Logger = {
      toolCall: () => undefined,
      event: () => undefined,
      error: () => undefined,
    };
    const registry = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [
        { workspace_id: "repo", name: "Repo", root, enabled: true },
        { workspace_id: "plain", name: "Plain", root: plainRoot, enabled: true },
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

  it("git_status returns the structured working-tree state", async () => {
    const result = await call("git_status", { workspace_id: "repo" });
    expect(result.isError).toBeFalsy();
    const envelope = result.structuredContent as any;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.workspace_id).toBe("repo");
    expect(envelope.data.branch).toMatchObject({ name: "main", detached: false });
    expect(envelope.data.changes).toEqual([
      { path: "src/app.ts", staged: null, unstaged: "modified" },
    ]);
    expect(envelope.data.redacted_changes).toBe(0);
    expect(envelope.data.clean).toBe(false);
  });

  it("git_diff returns bounded diffs and never blocked content", async () => {
    const result = await call("git_diff", { workspace_id: "repo", scope: "unstaged" });
    const envelope = result.structuredContent as any;
    expect(envelope.ok).toBe(true);
    expect(envelope.data.sections).toHaveLength(1);
    expect(envelope.data.sections[0].scope).toBe("unstaged");
    expect(envelope.data.sections[0].diff).toContain("const a = 2;");
    expect(envelope.data.sections[0].truncated).toBe(false);
    expect(JSON.stringify(envelope)).not.toContain("TOKEN");
    expect(JSON.stringify(envelope)).not.toContain(".env");
  });

  it("redacts blocked changes through MCP", async () => {
    write(root, ".env", "TOKEN=rotated\n");
    git(root, "add", ".env");
    const status = await call("git_status", { workspace_id: "repo" });
    const statusEnvelope = status.structuredContent as any;
    expect(statusEnvelope.data.redacted_changes).toBe(1);
    expect(JSON.stringify(statusEnvelope.data.changes)).not.toContain(".env");

    const diff = await call("git_diff", { workspace_id: "repo", scope: "staged" });
    const diffEnvelope = diff.structuredContent as any;
    expect(diffEnvelope.data.redacted_files).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(diffEnvelope)).not.toContain("rotated");
  });

  it("rejects non-git workspaces with a stable error", async () => {
    const result = await call("git_status", { workspace_id: "plain" });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe("NOT_A_GIT_REPOSITORY");
  });

  it("makes arbitrary git arguments impossible at the schema level", async () => {
    const withArgs = await call("git_diff", {
      workspace_id: "repo",
      args: ["push", "origin", "main"],
    } as Record<string, unknown>);
    expect(withArgs.isError).toBe(true);
    expect(JSON.stringify(withArgs)).toContain("Unrecognized key");

    const withCommand = await call("git_status", {
      workspace_id: "repo",
      command: "push origin main",
    } as Record<string, unknown>);
    expect(withCommand.isError).toBe(true);

    const badScope = await call("git_diff", { workspace_id: "repo", scope: "--all-flags" });
    expect(badScope.isError).toBe(true);

    const badPath = await call("git_diff", {
      workspace_id: "repo",
      scope: "unstaged",
      path: "../../etc",
    });
    expect((badPath.structuredContent as any).error.code).toBe("PATH_INVALID");
  });
});

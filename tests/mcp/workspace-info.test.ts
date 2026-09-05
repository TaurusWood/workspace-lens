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
import { git, initRepo } from "../helpers/git.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

describe("workspace_info over MCP", () => {
  let scratch: string;
  let root: string;
  let missingRoot: string;
  let context: ToolContext;
  let client: Client;

  beforeEach(async () => {
    scratch = makeTempDir("wl-mcp-info-");
    root = path.join(scratch, "proj");
    writeTree(root, { "package.json": "{}\n", "tsconfig.json": "{}\n" });
    initRepo(root);
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "init");
    missingRoot = path.join(scratch, "vanished");
    fs.mkdirSync(missingRoot);
    fs.rmSync(missingRoot, { recursive: true });

    const logger: Logger = {
      toolCall: () => undefined,
      event: () => undefined,
      error: () => undefined,
    };
    const registry = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [
        { workspace_id: "proj", name: "Proj", root, enabled: true },
        { workspace_id: "gone", name: "Gone", root: missingRoot, enabled: true },
        { workspace_id: "off", name: "Off", root, enabled: false },
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

  async function call(args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name: "workspace_info", arguments: args })) as CallToolResult;
  }

  it("returns identity, git state, and inferred project metadata", async () => {
    const result = await call({ workspace_id: "proj" });
    expect(result.isError).toBeFalsy();
    const envelope = result.structuredContent as any;
    expect(envelope.ok).toBe(true);
    expect(envelope.data).toMatchObject({
      workspace_id: "proj",
      name: "Proj",
      root_path: null,
      git: { detected: true, branch: "main", detached: false },
      project: { inferred: true },
    });
    expect(envelope.data.git.head).toMatch(/^[0-9a-f]{7,12}$/);
    expect(envelope.data.project.types).toEqual([
      { name: "node", confidence: "high", evidence: ["package.json"] },
    ]);
    // The absolute root never leaks by default.
    expect(JSON.stringify(envelope)).not.toContain(scratch);
  });

  it("exposes the root path only when expose_absolute_paths is enabled", async () => {
    const exposed = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: true,
      workspaces: [{ workspace_id: "proj", name: "Proj", root, enabled: true }],
    });
    const context2 = createToolContext({ registry: exposed });
    const server2 = createWorkspaceLensServer(context2);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const result = (await client2.callTool({
      name: "workspace_info",
      arguments: { workspace_id: "proj" },
    })) as CallToolResult;
    const envelope = result.structuredContent as any;
    expect(envelope.data.root_path).toBe(root);
    await client2.close();
  });

  it("reports non-git workspaces without erroring", async () => {
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    writeTree(plain, { "go.mod": "module x\n" });
    const registry = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [{ workspace_id: "plain", name: "Plain", root: plain, enabled: true }],
    });
    const context2 = createToolContext({ registry });
    const server2 = createWorkspaceLensServer(context2);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client2 = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server2.connect(st), client2.connect(ct)]);
    const result = (await client2.callTool({
      name: "workspace_info",
      arguments: { workspace_id: "plain" },
    })) as CallToolResult;
    const envelope = result.structuredContent as any;
    expect(envelope.data.git).toEqual({ detected: false, branch: null, detached: false, head: null });
    expect(envelope.data.project.types).toEqual([{ name: "go", confidence: "high", evidence: ["go.mod"] }]);
    await client2.close();
  });

  it("maps workspace errors per contract", async () => {
    await expect(call({ workspace_id: "ghost" })).resolves.toMatchObject({
      isError: true,
    });
    const notFound = await call({ workspace_id: "ghost" });
    expect((notFound.structuredContent as any).error.code).toBe("WORKSPACE_NOT_FOUND");

    const disabled = await call({ workspace_id: "off" });
    expect((disabled.structuredContent as any).error.code).toBe("WORKSPACE_DISABLED");

    const unavailable = await call({ workspace_id: "gone" });
    expect((unavailable.structuredContent as any).error.code).toBe("WORKSPACE_UNAVAILABLE");
  });
});

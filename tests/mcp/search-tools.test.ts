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
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

describe("search_workspace over MCP", () => {
  let scratch: string;
  let root: string;
  let context: ToolContext;
  let client: Client;

  beforeEach(async () => {
    scratch = makeTempDir("wl-mcp-search-");
    root = path.join(scratch, "proj");
    writeTree(root, {
      "src/access-policy.ts": "export class AccessPolicy {}\n",
      "src/.env": "SUPER_SECRET_TOKEN=hush\n",
    });

    const logger: Logger = {
      toolCall: () => undefined,
      event: () => undefined,
      error: () => undefined,
    };
    const registry = new WorkspaceRegistry({
      version: 1,
      expose_absolute_paths: false,
      workspaces: [{ workspace_id: "proj", name: "Proj", root, enabled: true }],
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
    return (await client.callTool({ name: "search_workspace", arguments: args })) as CallToolResult;
  }

  it("searches literally through the MCP boundary", async () => {
    const result = await call({ workspace_id: "proj", query: "AccessPolicy" });
    expect(result.isError).toBeFalsy();
    const envelope = result.structuredContent as {
      ok: boolean;
      data: { workspace_id: string; query: string; matches: unknown[]; truncated: boolean };
    };
    expect(envelope).toMatchObject({
      ok: true,
      data: { workspace_id: "proj", query: "AccessPolicy", truncated: false },
    });
    expect(envelope.data.matches).toEqual([
      { path: "src/access-policy.ts", line: 1, column: 14, preview: "export class AccessPolicy {}" },
    ]);
  });

  it("proves the cross-tool leak invariant: blocked files stay invisible", async () => {
    // The blocked file cannot be read...
    const read = (await client.callTool({
      name: "read_file",
      arguments: { workspace_id: "proj", path: "src/.env" },
    })) as CallToolResult;
    expect(read.isError).toBe(true);

    // ...and its content cannot be discovered through search either. The
    // result envelope echoes the query, so inspect matches only.
    const secret = await call({ workspace_id: "proj", query: "SUPER_SECRET_TOKEN" });
    const secretEnvelope = secret.structuredContent as { data: { matches: unknown[] } };
    expect(secretEnvelope.data.matches).toEqual([]);
    expect(JSON.stringify(secretEnvelope.data.matches)).not.toContain("SUPER_SECRET_TOKEN");

    const byName = await call({ workspace_id: "proj", query: "hush" });
    const byNameEnvelope = byName.structuredContent as { data: { matches: unknown[] } };
    expect(byNameEnvelope.data.matches).toEqual([]);
    expect(JSON.stringify(byNameEnvelope.data.matches)).not.toContain(".env");
  });

  it("rejects invalid arguments with stable error codes", async () => {
    const unknown = await call({ workspace_id: "ghost", query: "x" });
    expect(unknown.isError).toBe(true);
    expect((unknown.structuredContent as any).error.code).toBe("WORKSPACE_NOT_FOUND");

    const blockedRoot = await call({ workspace_id: "proj", query: "x", path: "src/.env" });
    expect((blockedRoot.structuredContent as any).error.code).toBe("PATH_BLOCKED");

    // Schema-level rejection (caller ceiling is 100).
    const oversized = await call({ workspace_id: "proj", query: "x", max_results: 101 });
    expect(oversized.isError).toBe(true);
  });
});

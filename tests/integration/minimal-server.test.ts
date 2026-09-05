import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolContext, createWorkspaceLensServer } from "../../src/mcp/server.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import { SERVER_NAME, SERVER_VERSION } from "../../src/version.js";

async function connectClient() {
  const registry = new WorkspaceRegistry({
    version: 1,
    expose_absolute_paths: false,
    workspaces: [],
  });
  const server = createWorkspaceLensServer(createToolContext({ registry }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("WorkspaceLens MCP server", () => {
  it("starts and identifies itself", async () => {
    const { client } = await connectClient();
    const serverInfo = client.getServerVersion();
    expect(serverInfo?.name).toBe(SERVER_NAME);
    expect(serverInfo?.version).toBe(SERVER_VERSION);
    await client.close();
  });

  it("responds to ping", async () => {
    const { client } = await connectClient();
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });

  it("exposes tools with a strict additionalProperties: false schema", async () => {
    const { client } = await connectClient();
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual([
      "git_diff",
      "git_status",
      "list_files",
      "read_file",
      "search_workspace",
      "workspace_list",
    ]);
    for (const tool of tools.tools) {
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(
        false,
      );
      expect(tool.description).toBeTruthy();
    }
    await client.close();
  });

  it("returns an error result for an unregistered tool", async () => {
    const { client } = await connectClient();
    const result = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });
});

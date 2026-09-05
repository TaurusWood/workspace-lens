import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createToolContext, createWorkspaceLensServer } from "../../src/mcp/server.js";
import { SERVER_NAME, SERVER_VERSION } from "../../src/version.js";

async function connectClient() {
  const server = createWorkspaceLensServer(createToolContext());
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

describe("minimal WorkspaceLens MCP server", () => {
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

  it("rejects an unregistered tool with a method-not-found protocol error (zero-tool server)", async () => {
    const { client } = await connectClient();
    // With no tools registered the SDK installs no tool handlers at all, so
    // the protocol answers CallTool with Method not found.
    await expect(client.callTool({ name: "no_such_tool", arguments: {} })).rejects.toThrow(
      /Method not found/,
    );
    await client.close();
  });
});

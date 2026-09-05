import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createConnectionTestServer } from "../../src/gate0/connection-test-server.js";

/** Gate 0 disposable server contract (implementation-plan.md §7). */
describe("gate0 connection-test server", () => {
  async function connectClient() {
    const server = createConnectionTestServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  it("exposes exactly one harmless tool: workspace_list", async () => {
    const client = await connectClient();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(["workspace_list"]);
    await client.close();
  });

  it("returns a single dummy connection-test workspace", async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: "workspace_list",
      arguments: {},
    })) as CallToolResult;
    expect(result.isError).toBeFalsy();
    const first = result.content[0];
    const envelope = JSON.parse(
      first !== undefined && first.type === "text" ? first.text : "{}",
    ) as {
      ok: boolean;
      data: { workspaces: Array<{ name: string; available: boolean }> };
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.data.workspaces).toEqual([
      { workspace_id: "connection-test", name: "connection-test", available: true, git: false },
    ]);
    await client.close();
  });

  it("rejects unknown properties on the empty input schema", async () => {
    const client = await connectClient();
    const result = (await client.callTool({
      name: "workspace_list",
      arguments: { root: "/etc/passwd" } as Record<string, unknown>,
    })) as CallToolResult;
    expect(result.isError).toBe(true);
    await client.close();
  });
});

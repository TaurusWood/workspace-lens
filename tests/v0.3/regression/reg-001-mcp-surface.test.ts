import { describe, expect, it } from "vitest";
import { connectClient, EMPTY_CONFIG, listToolNames } from "../helpers/mcp.js";

/**
 * REG-001 — MCP tool surface unchanged
 * (`docs/v0.3-test-contract.md` §4).
 *
 * v0.3 must not accidentally alter the public read-only tool contract:
 * exactly the accepted ten-tool surface, no Control API operation appears as
 * an MCP tool, and the input envelope stays strictly validated
 * (`additionalProperties: false`).
 */
const ACCEPTED_TEN_TOOL_SURFACE = [
  "git_commit",
  "git_compare",
  "git_diff",
  "git_history",
  "git_status",
  "list_files",
  "read_file",
  "search_workspace",
  "workspace_info",
  "workspace_list",
] as const;

const ADMIN_CAPABILITY_PROBES = [
  "workspace_add",
  "workspace_remove",
  "workspace_enable",
  "workspace_disable",
  "settings_update",
  "secret_get",
  "secret_set",
  "tunnel_connect",
  "tunnel_stop",
  "autostart_enable",
  "run_command",
  "config_replace",
] as const;

describe("REG-001 MCP tool surface unchanged", () => {
  it("exposes exactly the accepted ten-tool surface", async () => {
    const { client } = await connectClient(EMPTY_CONFIG);
    const names = await listToolNames(client);
    expect(names).toEqual([...ACCEPTED_TEN_TOOL_SURFACE]);
    await client.close();
  });

  it("keeps strict envelope semantics: unknown tool is an error result", async () => {
    const { client } = await connectClient(EMPTY_CONFIG);
    const result = await client.callTool({ name: "no_such_tool", arguments: {} });
    expect(result.isError).toBe(true);
    await client.close();
  });

  it("keeps strict envelope semantics: unknown input properties are rejected", async () => {
    const { client, server } = await connectClient(EMPTY_CONFIG);
    const result = await client.callTool({
      name: "workspace_list",
      arguments: { unknown_property: true },
    });
    expect(result.isError).toBe(true);
    await server.close();
  });

  it("exposes no Control API operation as an MCP tool, resource, or prompt", async () => {
    const { client } = await connectClient(EMPTY_CONFIG);
    const names = await listToolNames(client);
    for (const probe of ADMIN_CAPABILITY_PROBES) {
      expect(names).not.toContain(probe);
    }
    // The server does not advertise resources/prompts capability surfaces at
    // all: listing them is a protocol-level "Method not found".
    await expect(client.listResources()).rejects.toThrow(/-32601|Method not found/);
    await expect(client.listPrompts()).rejects.toThrow(/-32601|Method not found/);
    await client.close();
  });
});

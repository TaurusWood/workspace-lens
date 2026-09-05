import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FilesystemAdapter } from "../../src/adapters/filesystem.js";
import { createToolContext, createWorkspaceLensServer } from "../../src/mcp/server.js";
import type { ToolContext } from "../../src/mcp/context.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import type { Logger } from "../../src/core/logger.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

/**
 * Phase 4 MCP-level tests: schema validation happens before adapter access,
 * and the contract envelope is visible through the MCP boundary.
 */
describe("filesystem read tools over MCP", () => {
  let scratch: string;
  let root: string;
  let missingRoot: string;
  let context: ToolContext;
  let client: Client;
  let logLines: string[];

  beforeEach(async () => {
    scratch = makeTempDir("wl-mcp-fs-");
    root = path.join(scratch, "proj");
    writeTree(root, {
      "README.md": "# proj\n",
      "src/index.ts": "export const a = 1;\n",
      "src/.env": "TOKEN=x\n",
    });
    missingRoot = path.join(scratch, "vanished");
    fs.mkdirSync(missingRoot);
    fs.rmSync(missingRoot, { recursive: true });

    logLines = [];
    const logger: Logger = {
      toolCall: (fields) => logLines.push(JSON.stringify(fields)),
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

  async function call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    return (await client.callTool({ name, arguments: args })) as CallToolResult;
  }

  function envelopeOf(result: CallToolResult): any {
    return result.structuredContent;
  }

  it("advertises the phase-4 tools with strict input schemas", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["list_files", "read_file", "workspace_list"]);
    const listSchema = tools.tools.find((tool) => tool.name === "workspace_list")?.inputSchema as {
      additionalProperties?: boolean;
    };
    expect(listSchema.additionalProperties).toBe(false);
  });

  it("workspace_list reports availability and git detection without roots", async () => {
    const result = await call("workspace_list", {});
    expect(result.isError).toBeFalsy();
    const envelope = envelopeOf(result);
    expect(envelope.ok).toBe(true);
    const byId = new Map(envelope.data.workspaces.map((ws: any) => [ws.workspace_id, ws]));
    expect(byId.get("proj")).toEqual({
      workspace_id: "proj",
      name: "Proj",
      available: true,
      git: false,
    });
    expect(byId.get("gone")).toMatchObject({ available: false });
    // Disabled workspaces are not listed at all.
    expect(byId.has("off")).toBe(false);
    // Roots never cross the MCP boundary.
    expect(JSON.stringify(envelope)).not.toContain(root);
  });

  it("list_files lists workspace content through MCP", async () => {
    const result = await call("list_files", { workspace_id: "proj", path: "src", depth: 1 });
    expect(result.isError).toBeFalsy();
    const envelope = envelopeOf(result);
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        workspace_id: "proj",
        path: "src",
        truncated: false,
      },
    });
    expect(envelope.data.entries.map((entry: any) => entry.path)).toEqual(["src/index.ts"]);
  });

  it("read_file returns bounded content through MCP", async () => {
    const result = await call("read_file", {
      workspace_id: "proj",
      path: "src/index.ts",
      start_line: 1,
      end_line: 1,
    });
    expect(result.isError).toBeFalsy();
    expect(envelopeOf(result)).toMatchObject({
      ok: true,
      data: { path: "src/index.ts", content: "export const a = 1;", truncated: false },
    });
  });

  it("rejects unknown workspaces with a stable error envelope", async () => {
    const result = await call("list_files", { workspace_id: "nope" });
    expect(result.isError).toBe(true);
    expect(envelopeOf(result)).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_NOT_FOUND", retryable: false },
    });
  });

  it("reports disabled workspaces as WORKSPACE_DISABLED", async () => {
    const result = await call("list_files", { workspace_id: "off" });
    expect(envelopeOf(result)).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_DISABLED" },
    });
  });

  it("reports unavailable roots as WORKSPACE_UNAVAILABLE", async () => {
    const result = await call("read_file", { workspace_id: "gone", path: "x.txt" });
    expect(envelopeOf(result)).toMatchObject({
      ok: false,
      error: { code: "WORKSPACE_UNAVAILABLE" },
    });
  });

  it("rejects schema violations before the adapter runs", async () => {
    const listSpy = vi.spyOn(FilesystemAdapter.prototype, "listTree");
    const readSpy = vi.spyOn(FilesystemAdapter.prototype, "readFile");

    const withUnknownProp = await call("list_files", {
      workspace_id: "proj",
      root: "/etc",
    } as Record<string, unknown>);
    expect(withUnknownProp.isError).toBe(true);
    expect(JSON.stringify(withUnknownProp)).toContain("Unrecognized key");

    const badTypes = await call("read_file", { workspace_id: "proj", path: 42 });
    expect(badTypes.isError).toBe(true);

    expect(listSpy).not.toHaveBeenCalled();
    expect(readSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
    readSpy.mockRestore();
  });

  it("enforces path security through the MCP boundary", async () => {
    const traversal = await call("read_file", { workspace_id: "proj", path: "../outside.txt" });
    expect(envelopeOf(traversal)).toMatchObject({
      ok: false,
      error: { code: "PATH_INVALID" },
    });

    const blocked = await call("read_file", { workspace_id: "proj", path: "src/.env" });
    expect(envelopeOf(blocked)).toMatchObject({
      ok: false,
      error: { code: "PATH_BLOCKED" },
    });

    // Blocked content never appears anywhere in the result.
    expect(JSON.stringify(blocked)).not.toContain("TOKEN");
  });

  it("logs metadata only, never file content", async () => {
    await call("read_file", { workspace_id: "proj", path: "src/index.ts" });
    await call("read_file", { workspace_id: "proj", path: "../escape" });

    const combined = logLines.join("\n");
    expect(combined).toContain('"tool":"read_file"');
    expect(combined).toContain('"workspace_id":"proj"');
    expect(combined).not.toContain("export const a");
    expect(combined).not.toContain("/private/var");
    expect(combined).not.toContain(scratch);
  });
});

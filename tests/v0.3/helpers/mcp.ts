/**
 * Shared fixtures for the v0.3 contract suite (`docs/v0.3-test-contract.md` §3).
 *
 * Helpers build real in-process WorkspaceLens MCP servers through the public
 * `createWorkspaceLensServer` factory so contracts exercise the public
 * application boundary, not private internals (§17 review checklist).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import path from "node:path";
import { makeTempRoot, writeTree } from "../../helpers/fixtures.js";
import { initRepo } from "../../helpers/git.js";
import type { WorkspaceLensConfig } from "../../../src/config/config-schema.js";
import { WorkspaceRegistry } from "../../../src/core/workspace-registry.js";
import { createToolContext, createWorkspaceLensServer } from "../../../src/mcp/server.js";

export const EMPTY_CONFIG: WorkspaceLensConfig = {
  version: 1,
  expose_absolute_paths: false,
  workspaces: [],
};

export function makeConfig(workspaces: Partial<{ id: string; name: string; root: string; enabled: boolean }>[] = []): WorkspaceLensConfig {
  return {
    version: 1,
    expose_absolute_paths: false,
    workspaces: workspaces.map((ws) => ({
      workspace_id: ws.id ?? "ws",
      name: ws.name ?? ws.id ?? "ws",
      root: ws.root ?? "/nonexistent",
      enabled: ws.enabled ?? true,
    })),
  };
}

export interface WorkspaceFixture {
  root: string;
  sentinelFile: string;
  sentinelContent: string;
}

/** A readable non-Git directory with sentinel content unique to the workspace. */
export function makePlainWorkspace(tag: string): WorkspaceFixture {
  const root = makeTempRoot(`wl-v03-${tag}-`);
  const sentinelFile = path.join("docs", `${tag}-sentinel.txt`);
  const sentinelContent = `${tag}-SENTINEL-CONTENT-7f3a91`;
  writeTree(root, { [sentinelFile]: sentinelContent });
  return { root, sentinelFile, sentinelContent };
}

export interface GitWorkspaceFixture extends WorkspaceFixture {
  branch: string;
  commitMessage: string;
}

/** A separate Git repository with its own branch/commit identity. */
export function makeGitWorkspace(tag: string): GitWorkspaceFixture {
  const root = makeTempRoot(`wl-v03-git-${tag}-`);
  const branch = `${tag}-feature-branch`;
  const commitMessage = `${tag} unique commit ${Date.now()}-${Math.random().toString(36).slice(2)}`;
  initRepo(root, { [`${tag}-tracked.txt`]: `${tag} tracked content` });
  const sentinelFile = path.join(`${tag}-workspace-file.txt`);
  writeTree(root, { [sentinelFile]: `${tag}-SENTINEL-CONTENT-7f3a91` });
  return { root, sentinelFile, sentinelContent: `${tag}-SENTINEL-CONTENT-7f3a91`, branch, commitMessage };
}

export function cleanupWorkspace(fixture: WorkspaceFixture): void {
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

/** Connect an MCP client to a real WorkspaceLens server over in-memory transport. */
export async function connectClient(config: WorkspaceLensConfig): Promise<{
  client: Client;
  server: McpServer;
}> {
  const registry = new WorkspaceRegistry(config);
  const server = createWorkspaceLensServer(createToolContext({ registry }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "v0.3-contract-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

export async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  return client.callTool({ name, arguments: args });
}

export async function listToolNames(client: Client): Promise<string[]> {
  const tools = await client.listTools();
  return tools.tools.map((tool) => tool.name).sort();
}

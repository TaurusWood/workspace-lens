/**
 * Spawn helpers for the real packaged CLI entry point (`dist/cli/index.js`).
 *
 * REG-003 and the E2E contracts require the actual stdio MCP process path,
 * not an in-process shortcut, so these helpers launch the built CLI as a
 * child process with an isolated WORKSPACE_LENS_CONFIG.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import type { WorkspaceLensConfig } from "../../../src/config/config-schema.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const REPO_ROOT_V03 = REPO_ROOT;
export const CLI_ENTRY = path.join(REPO_ROOT, "dist", "cli", "index.js");

export function writeConfigFile(directory: string, config: WorkspaceLensConfig): string {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const filePath = path.join(directory, "config.json");
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return filePath;
}

export interface SpawnedServe {
  client: Client;
  transport: StdioClientTransport;
  /** Absolute path of the isolated config file given to the child process. */
  configPath: string;
  close(): Promise<void>;
}

/** Start `workspace-lens serve` as a real child process and connect an MCP stdio client. */
export async function spawnServe(config: WorkspaceLensConfig): Promise<SpawnedServe> {
  if (!fs.existsSync(CLI_ENTRY)) {
    throw new Error(
      `REG-003 BLOCKED: built CLI entry missing at ${CLI_ENTRY}; run \`npm run build\` before the v0.3 contract suite.`,
    );
  }
  const configDir = fs.mkdtempSync(path.join(REPO_ROOT, "node_modules/.tmp-wl-v03-"));
  const configPath = writeConfigFile(configDir, config);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI_ENTRY, "serve"],
    env: {
      ...process.env,
      WORKSPACE_LENS_CONFIG: configPath,
    } as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "v0.3-stdio-contract-client", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    transport,
    configPath,
    async close(): Promise<void> {
      await client.close();
      fs.rmSync(configDir, { recursive: true, force: true });
    },
  };
}

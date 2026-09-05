#!/usr/bin/env node
/**
 * Gate 0 disposable connection-test MCP server (`implementation-plan.md` §7).
 *
 * Exposes one harmless tool (`workspace_list`) that returns a single dummy
 * entry. It performs no filesystem access and needs no configuration.
 *
 * Run with: node dist/gate0/connection-test-server.js
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { pathToFileURL } from "node:url";
import { SERVER_VERSION } from "../version.js";

export function createConnectionTestServer(): McpServer {
  const server = new McpServer({
    name: "workspace-lens-connection-test",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "workspace_list",
    {
      description:
        "Connection test tool. Lists a single dummy workspace entry. This disposable server validates the ChatGPT connection path only.",
      inputSchema: z.strictObject({}),
    },
    async () => {
      const envelope = {
        ok: true,
        data: {
          workspaces: [
            {
              workspace_id: "connection-test",
              name: "connection-test",
              available: true,
              git: false,
            },
          ],
        },
      };
      return {
        content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  return server;
}

async function main(): Promise<void> {
  const server = createConnectionTestServer();
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${JSON.stringify({ event: "gate0_server_started", name: "workspace-lens-connection-test", version: SERVER_VERSION })}\n`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`${JSON.stringify({ event: "gate0_shutdown", detail: signal })}\n`);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  server.server.onclose = () => process.exit(0);
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  await main();
}

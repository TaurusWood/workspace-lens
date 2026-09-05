import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore, describeError } from "../../config/config-store.js";
import { ConfigError } from "../../config/config-schema.js";
import { WorkspaceRegistry } from "../../core/workspace-registry.js";
import { StderrLogger } from "../../core/logger.js";
import { createToolContext, createWorkspaceLensServer } from "../../mcp/server.js";

/**
 * Run the WorkspaceLens MCP server in the foreground on stdio transport.
 * The process stays alive until the client closes the stream or a signal
 * is received.
 */
export async function runServe(): Promise<void> {
  const logger = new StderrLogger();

  let registry: WorkspaceRegistry;
  try {
    const store = new ConfigStore();
    registry = new WorkspaceRegistry(store.load());
  } catch (error) {
    if (error instanceof ConfigError) {
      // Fail safely: never run against a partially interpreted config.
      process.stderr.write(`error: ${describeError(error)}\n`);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const context = createToolContext({ registry, logger });
  const server = createWorkspaceLensServer(context);

  const shutdown = async (signal: string): Promise<void> => {
    logger.event("shutdown", signal);
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  const transport = new StdioServerTransport();
  await server.connect(transport);
  server.server.onclose = () => {
    logger.event("shutdown", "client closed the connection");
    process.exit(0);
  };

  logger.event("server_started", "WorkspaceLens MCP server listening on stdio");
}

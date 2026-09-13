import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigStore, describeError } from "../../config/config-store.js";
import { ConfigError } from "../../config/config-schema.js";
import { LiveWorkspaceRegistry } from "../../core/live-workspace-registry.js";
import type { WorkspaceRegistry } from "../../core/workspace-registry.js";
import { StderrLogger } from "../../core/logger.js";
import { createToolContext, createWorkspaceLensServer } from "../../mcp/server.js";

/**
 * Run the WorkspaceLens MCP server in the foreground on stdio transport.
 * The process stays alive until the client closes the stream or a signal
 * is received. Returns 0 once serving, or 1 when startup failed.
 */
export async function runServe(): Promise<number> {
  const logger = new StderrLogger();

  let registry: WorkspaceRegistry;
  try {
    // Live authorization: every request resolves the current validated
    // config, so administration changes apply without a restart. The
    // construction-time load still fails fast on a malformed config.
    const store = new ConfigStore();
    registry = new LiveWorkspaceRegistry(() => store.load());
  } catch (error) {
    if (error instanceof ConfigError) {
      // Fail safely: never run against a partially interpreted config.
      process.stderr.write(`error: ${describeError(error)}\n`);
      return 1;
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
  return 0;
}

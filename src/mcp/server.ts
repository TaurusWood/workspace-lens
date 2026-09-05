import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_LIMITS, type ServerLimits } from "../core/limits.js";
import { type Logger, StderrLogger } from "../core/logger.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";

/**
 * Shared context handed to every MCP tool handler. Tool handlers use this
 * context for orchestration only; filesystem security decisions live in the
 * core security kernel (`security-model.md` §4.5, `implementation-plan.md` §5).
 */
export interface ToolContext {
  limits: ServerLimits;
  logger: Logger;
}

export interface ServerOptions {
  limits?: Partial<ServerLimits>;
  logger?: Logger;
}

export function createToolContext(options: ServerOptions = {}): ToolContext {
  return {
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    logger: options.logger ?? new StderrLogger(),
  };
}

/**
 * Create the WorkspaceLens MCP server. Tools are registered by phase modules
 * so each capability stays independently testable.
 */
export function createWorkspaceLensServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerTools(server, context);
  return server;
}

function registerTools(_server: McpServer, _context: ToolContext): void {
  // Phase 4+ registers workspace_list, list_files, read_file, search_workspace,
  // git_status, git_diff, and workspace_info here.
}

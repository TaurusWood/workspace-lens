import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AccessPolicy } from "../core/access-policy.js";
import { DEFAULT_LIMITS, type ServerLimits } from "../core/limits.js";
import { type Logger, StderrLogger } from "../core/logger.js";
import type { WorkspaceRegistry } from "../core/workspace-registry.js";
import { SERVER_NAME, SERVER_VERSION } from "../version.js";
import type { ToolContext } from "./context.js";
import { createToolHandler } from "./tool-runner.js";
import { gitDiffTool } from "./tools/git-diff.js";
import { gitStatusTool } from "./tools/git-status.js";
import { listFilesTool } from "./tools/list-files.js";
import { readFileTool } from "./tools/read-file.js";
import { searchWorkspaceTool } from "./tools/search-workspace.js";
import { workspaceListTool } from "./tools/workspace-list.js";

export interface ServerOptions {
  limits?: Partial<ServerLimits>;
  logger?: Logger;
  policy?: AccessPolicy;
}

export function createToolContext(
  options: ServerOptions & { registry: WorkspaceRegistry },
): ToolContext {
  return {
    limits: { ...DEFAULT_LIMITS, ...options.limits },
    logger: options.logger ?? new StderrLogger(),
    registry: options.registry,
    policy: options.policy ?? new AccessPolicy(),
  };
}

/**
 * Create the WorkspaceLens MCP server. The tool list is the public contract
 * surface: exactly the tools defined by `mcp-tools-spec.md`, no more.
 */
export function createWorkspaceLensServer(context: ToolContext): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const tools = [
    workspaceListTool,
    listFilesTool,
    readFileTool,
    searchWorkspaceTool,
    gitStatusTool,
    gitDiffTool,
  ] as const;
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.inputSchema },
      createToolHandler(tool, context),
    );
  }
  return server;
}

import type { AccessPolicy } from "../core/access-policy.js";
import type { ServerLimits } from "../core/limits.js";
import type { Logger } from "../core/logger.js";
import type { WorkspaceRegistry, WorkspaceRegistrySource } from "../core/workspace-registry.js";

/**
 * Context handed to the MCP server. `registry` is a SOURCE, not a snapshot:
 * the tool runner resolves it exactly once at the start of every MCP
 * request (live authorization, `docs/v0.3-technical-architecture-rfc.md` §9).
 */
export interface ToolContext {
  limits: ServerLimits;
  logger: Logger;
  registry: WorkspaceRegistrySource;
  /** The one shared access policy used by every content-bearing tool. */
  policy: AccessPolicy;
}

/**
 * The request-scoped context each tool handler executes against. `registry`
 * is the immutable snapshot resolved at request start; the whole request —
 * including every later registry read — uses this one snapshot, so a config
 * change can never split a running request across two configurations.
 */
export interface ToolRequestContext extends Omit<ToolContext, "registry"> {
  registry: WorkspaceRegistry;
}

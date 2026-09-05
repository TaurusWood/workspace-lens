import type { AccessPolicy } from "../core/access-policy.js";
import type { ServerLimits } from "../core/limits.js";
import type { Logger } from "../core/logger.js";
import type { WorkspaceRegistry } from "../core/workspace-registry.js";

/**
 * Shared context handed to every MCP tool handler. Handlers use it for
 * orchestration only; filesystem security decisions live in the security
 * kernel (`security-model.md` §4.5, `implementation-plan.md` §5).
 */
export interface ToolContext {
  limits: ServerLimits;
  logger: Logger;
  registry: WorkspaceRegistry;
  /** The one shared access policy used by every content-bearing tool. */
  policy: AccessPolicy;
}

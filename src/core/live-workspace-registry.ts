/**
 * Request-scoped live workspace registry (`docs/v0.3-implementation-plan.md` §6,
 * `docs/v0.3-technical-architecture-rfc.md` §9).
 *
 * Every authorization decision resolves the CURRENT validated config through
 * the injected loader, so workspace add/disable/remove performed through the
 * shared administration service is visible to the next MCP request without
 * restarting WorkspaceLens or the tunnel.
 *
 * Fail closed: if the current config is malformed or unreadable, the loader
 * throws a `ConfigError` which propagates to the tool boundary — the request
 * never falls back to a stale (potentially broader) authorization snapshot.
 *
 * No global current-workspace state exists here: workspaces are resolved per
 * request from the explicit `workspace_id` argument, and each resolution is
 * an immutable snapshot.
 */
import { type WorkspaceLensConfig } from "../config/config-schema.js";
import { WorkspaceRegistry } from "./workspace-registry.js";

export class LiveWorkspaceRegistry extends WorkspaceRegistry {
  constructor(private readonly loadConfig: () => WorkspaceLensConfig) {
    // The construction-time load doubles as the startup fail-fast check:
    // a malformed config must prevent startup entirely (v0.2 behavior).
    super(loadConfig());
  }

  protected override get snapshot(): WorkspaceLensConfig {
    return this.loadConfig();
  }
}

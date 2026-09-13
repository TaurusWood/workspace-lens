/**
 * Live workspace registry source (`docs/v0.3-implementation-plan.md` §6,
 * `docs/v0.3-technical-architecture-rfc.md` §9).
 *
 * `currentRegistry()` loads the CURRENT validated config and wraps it in an
 * immutable `WorkspaceRegistry` snapshot. The tool runner calls it exactly
 * once per MCP request, so:
 *
 * - administration changes (add/disable/remove through the shared service)
 *   are visible to the next request without restarting WorkspaceLens or
 *   the tunnel;
 * - a running request never observes a mid-flight config change — it
 *   executes entirely against the snapshot resolved at its start;
 * - no global current-workspace state exists: workspaces resolve per
 *   request from the explicit `workspace_id`.
 *
 * Fail closed: if the current config is malformed or unreadable, the
 * loader throws a `ConfigError` at request resolution time — the request
 * never falls back to a stale (potentially broader) authorization snapshot.
 */
import { type WorkspaceLensConfig } from "../config/config-schema.js";
import { WorkspaceRegistry, type WorkspaceRegistrySource } from "./workspace-registry.js";

export class LiveWorkspaceRegistry implements WorkspaceRegistrySource {
  constructor(private readonly loadConfig: () => WorkspaceLensConfig) {}

  currentRegistry(): WorkspaceRegistry {
    return new WorkspaceRegistry(this.loadConfig());
  }
}

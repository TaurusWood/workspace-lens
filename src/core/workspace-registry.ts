/**
 * Runtime view over the locally authorized workspace registry
 * (`architecture.md` §3, Workspace Manager).
 *
 * The registry is the only source of workspace identity for MCP tools:
 * access always resolves from a configured `workspace_id`, never from a
 * caller-supplied root path (`security-model.md` §4.2).
 */
import fs from "node:fs";
import { AppError } from "./errors.js";
import type { WorkspaceLensConfig, WorkspaceConfig } from "../config/config-schema.js";

export interface RegisteredWorkspace {
  workspace_id: string;
  name: string;
  /** Canonical absolute root path. Internal use; never returned to MCP clients by default. */
  root: string;
  enabled: boolean;
}

function toRegistered(ws: WorkspaceConfig): RegisteredWorkspace {
  return { workspace_id: ws.workspace_id, name: ws.name, root: ws.root, enabled: ws.enabled };
}

export class WorkspaceRegistry {
  constructor(private readonly config: WorkspaceLensConfig) {}

  /**
   * Local-only option: when enabled, workspace_info may return the
   * canonical absolute root path (`mcp-tools-spec.md` §7).
   */
  get exposeAbsolutePaths(): boolean {
    return this.config.expose_absolute_paths;
  }

  /** All registered workspaces, including disabled ones. */
  listAll(): RegisteredWorkspace[] {
    return this.config.workspaces.map(toRegistered);
  }

  /** Workspaces visible to MCP callers: explicitly authorized and enabled. */
  listEnabled(): RegisteredWorkspace[] {
    return this.config.workspaces.filter((ws) => ws.enabled).map(toRegistered);
  }

  findById(workspaceId: string): RegisteredWorkspace | undefined {
    const ws = this.config.workspaces.find((entry) => entry.workspace_id === workspaceId);
    return ws ? toRegistered(ws) : undefined;
  }

  /**
   * Whether the configured root is currently an accessible directory.
   * A missing root never falls back to a parent directory.
   */
  isAvailable(workspace: RegisteredWorkspace): boolean {
    try {
      return fs.statSync(workspace.root).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Resolve a workspace for a tool call, enforcing the error order defined
   * by the tool contract: NOT_FOUND, then DISABLED.
   */
  requireEnabled(workspaceId: string): RegisteredWorkspace {
    const ws = this.findById(workspaceId);
    if (ws === undefined) {
      throw new AppError("WORKSPACE_NOT_FOUND", `Unknown workspace_id: ${workspaceId}`);
    }
    if (!ws.enabled) {
      throw new AppError("WORKSPACE_DISABLED", `Workspace "${ws.name}" is disabled.`);
    }
    return ws;
  }

  /** Throw WORKSPACE_UNAVAILABLE when the configured root is inaccessible. */
  requireAvailable(workspace: RegisteredWorkspace): void {
    if (!this.isAvailable(workspace)) {
      throw new AppError(
        "WORKSPACE_UNAVAILABLE",
        `Workspace "${workspace.name}" is currently unavailable.`,
      );
    }
  }
}

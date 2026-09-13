/**
 * Shared workspace administration application service
 * (`docs/v0.3-implementation-plan.md` §4, `docs/v0.3-technical-architecture-rfc.md` §6).
 *
 * CLI and (later) the Control API/WebUI both call this service so product
 * rules exist once. Storage mechanics stay in the injected `ConfigStore`;
 * authorization semantics are inherited unchanged: roots are canonicalized,
 * duplicate/overlapping roots are rejected, `workspace_id` and root are
 * immutable after creation, enabling revalidates the root, and removing a
 * workspace affects WorkspaceLens authorization only — never user files.
 *
 * Slice 0 boundary note: mutations still go through the store's unlocked
 * load/modify/save path. Slice 1 moves them onto the locked
 * `ConfigStore.mutate()` layer without changing this service's surface.
 */
import fs from "node:fs";
import {
  ConfigError,
  WORKSPACE_NAME_MAX_LENGTH,
  type WorkspaceConfig,
} from "../config/config-schema.js";
import { ConfigStore, expandTilde } from "../config/config-store.js";

export interface AddWorkspaceInput {
  root: string;
  /** Display name. Also the identity base when `id` is absent. */
  name?: string;
  /** Explicit stable identity; must be valid and unused. */
  id?: string;
}

/** Product view of one authorized workspace, including validation state. */
export interface WorkspaceListItem {
  workspace_id: string;
  name: string;
  root: string;
  enabled: boolean;
  /** Whether the configured root is currently an accessible directory. */
  available: boolean;
}

export interface RootValidation {
  ok: boolean;
  canonicalRoot?: string;
  reason?: string;
}

/** Constructor dependencies: injected stores/adapters (implementation plan §4). */
export interface WorkspaceAdminServiceDependencies {
  configStore: ConfigStore;
}

export class WorkspaceAdminService {
  private readonly configStore: ConfigStore;

  constructor(dependencies: WorkspaceAdminServiceDependencies) {
    this.configStore = dependencies.configStore;
  }

  /** All authorized workspaces with their current validation state. */
  list(): WorkspaceListItem[] {
    return this.configStore.load().workspaces.map((ws) => ({
      ...ws,
      available: isAvailableRoot(ws.root),
    }));
  }

  /**
   * Authorize a new workspace root. The root must currently exist as a
   * directory; duplicate and overlapping roots are rejected. When `id` is
   * absent the identity derives from the display name (falling back to the
   * path base when no name is given).
   */
  async add(input: AddWorkspaceInput): Promise<WorkspaceConfig> {
    return this.configStore.add(input.root, { name: input.name, id: input.id, idBasis: "name" });
  }

  /** Rename the display name; identity, root, and enabled state are untouched. */
  async rename(workspaceId: string, displayName: string): Promise<WorkspaceConfig> {
    const name = displayName.trim();
    if (name.length < 1 || name.length > WORKSPACE_NAME_MAX_LENGTH) {
      throw new ConfigError(
        `Workspace name must be a string of length 1..${WORKSPACE_NAME_MAX_LENGTH}.`,
      );
    }
    return this.updateWorkspace(workspaceId, (ws) => {
      ws.name = name;
    });
  }

  /** Disable authorization; the workspace behaves as unavailable to MCP. */
  async disable(workspaceId: string): Promise<WorkspaceConfig> {
    return this.updateWorkspace(workspaceId, (ws) => {
      ws.enabled = false;
    });
  }

  /**
   * Re-enable authorization. The existing root is revalidated first: a
   * missing or inaccessible root is never silently re-enabled.
   */
  async enable(workspaceId: string): Promise<WorkspaceConfig> {
    return this.updateWorkspace(workspaceId, (ws) => {
      if (!isAvailableRoot(ws.root)) {
        throw new ConfigError(
          `Cannot enable workspace "${ws.workspace_id}": root is missing or inaccessible: ${ws.root}`,
        );
      }
      ws.enabled = true;
    });
  }

  /** Remove authorization by workspace_id (or unambiguous name). Files are untouched. */
  async remove(idOrName: string): Promise<WorkspaceConfig> {
    return this.configStore.remove(idOrName);
  }

  /** Validate a root candidate without authorizing it. */
  validateRoot(rootPath: string): RootValidation {
    const expanded = expandTilde(rootPath);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(expanded);
    } catch {
      return { ok: false, reason: `Path does not exist or is inaccessible: ${rootPath}` };
    }
    if (!stats.isDirectory()) {
      return { ok: false, reason: `Not a directory: ${rootPath}` };
    }
    return { ok: true, canonicalRoot: fs.realpathSync(expanded) };
  }

  private updateWorkspace(
    workspaceId: string,
    update: (ws: WorkspaceConfig) => void,
  ): WorkspaceConfig {
    const config = this.configStore.load();
    const workspace = config.workspaces.find((ws) => ws.workspace_id === workspaceId);
    if (workspace === undefined) {
      throw new ConfigError(`No authorized workspace matches "${workspaceId}".`);
    }
    update(workspace);
    this.configStore.save(config);
    return { ...workspace };
  }
}

/** Whether the root is currently an accessible directory (no parent fallback). */
function isAvailableRoot(root: string): boolean {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

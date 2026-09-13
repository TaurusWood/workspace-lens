/**
 * Shared workspace administration application service
 * (`docs/v0.3-implementation-plan.md` §4/§5, `docs/v0.3-technical-architecture-rfc.md` §6).
 *
 * CLI and (later) the Control API/WebUI both call this service so product
 * rules exist once. Every mutation goes through the locked
 * `ConfigStore.mutate()` read-modify-write layer, so concurrent CLI/WebUI
 * shaped mutations cannot lose accepted changes. Authorization semantics are
 * inherited unchanged: roots are canonicalized, duplicate/overlapping roots
 * are rejected, `workspace_id` and root are immutable after creation,
 * enabling revalidates the root, and removing a workspace affects
 * WorkspaceLens authorization only — never user files.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ConfigError,
  WORKSPACE_ID_MAX_LENGTH,
  WORKSPACE_ID_PATTERN,
  WORKSPACE_NAME_MAX_LENGTH,
  type WorkspaceConfig,
  type WorkspaceLensConfig,
} from "../config/config-schema.js";
import {
  ConfigStore,
  expandTilde,
  sanitizeWorkspaceIdBase,
  type ConfigMutationSyncPoints,
} from "../config/config-store.js";
import { ConfigLockBusyError } from "../config/config-lock.js";

export interface AddWorkspaceInput {
  root: string;
  /** Display name. Also the identity base when `id` and `idBasis` are absent. */
  name?: string;
  /** Explicit stable identity; must be valid and unused. */
  id?: string;
  /**
   * Identity basis when `id` is absent: the display name (application
   * default) or the canonical path base. The CLI passes `"path"` to preserve
   * its v0.2 identity contract where `--name` is display-only.
   */
  idBasis?: "path" | "name";
}

/** Constructor dependencies: injected stores/adapters (implementation plan §4). */
export interface WorkspaceAdminServiceDependencies {
  configStore: ConfigStore;
  /**
   * Deterministic mutation seam (CFG-004): forwarded to every config
   * mutation, invoked in-lock after the latest config is loaded.
   */
  syncPoints?: ConfigMutationSyncPoints;
  /**
   * Total budget for waiting on a lock held by another live process. The
   * wait yields the event loop (sleep/retry), it never spins. Default 2000.
   */
  lockTimeoutMs?: number;
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

export interface IdentityValidation {
  ok: boolean;
  reason?: string;
}

export class WorkspaceAdminService {
  private static readonly DEFAULT_LOCK_TIMEOUT_MS = 2000;
  private static readonly LOCK_RETRY_DELAY_MS = 10;

  private readonly configStore: ConfigStore;
  private readonly syncPoints: ConfigMutationSyncPoints | undefined;
  private readonly lockTimeoutMs: number;

  constructor(dependencies: WorkspaceAdminServiceDependencies) {
    this.configStore = dependencies.configStore;
    this.syncPoints = dependencies.syncPoints;
    this.lockTimeoutMs = dependencies.lockTimeoutMs ?? WorkspaceAdminService.DEFAULT_LOCK_TIMEOUT_MS;
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
    return this.withLockRetry(() =>
      this.configStore.add(input.root, {
        name: input.name,
        id: input.id,
        idBasis: input.idBasis ?? "name",
      }),
    );
  }

  /** Rename the display name; identity, root, and enabled state are untouched. */
  async rename(workspaceId: string, displayName: string): Promise<WorkspaceConfig> {
    const name = displayName.trim();
    if (name.length < 1 || name.length > WORKSPACE_NAME_MAX_LENGTH) {
      throw new ConfigError(
        `Workspace name must be a string of length 1..${WORKSPACE_NAME_MAX_LENGTH}.`,
      );
    }
    return this.mutateWorkspace((config) => {
      const ws = requireWorkspace(config, workspaceId);
      ws.name = name;
      return { next: config, result: { ...ws } };
    });
  }

  /** Disable authorization; the workspace behaves as unavailable to MCP. */
  async disable(workspaceId: string): Promise<WorkspaceConfig> {
    return this.mutateWorkspace((config) => {
      const ws = requireWorkspace(config, workspaceId);
      ws.enabled = false;
      return { next: config, result: { ...ws } };
    });
  }

  /**
   * Re-enable authorization. The existing root is revalidated first: a
   * missing or inaccessible root is never silently re-enabled.
   */
  async enable(workspaceId: string): Promise<WorkspaceConfig> {
    return this.mutateWorkspace((config) => {
      const ws = requireWorkspace(config, workspaceId);
      if (!isAvailableRoot(ws.root)) {
        throw new ConfigError(
          `Cannot enable workspace "${ws.workspace_id}": root is missing or inaccessible: ${ws.root}`,
        );
      }
      ws.enabled = true;
      return { next: config, result: { ...ws } };
    });
  }

  /** Remove authorization by workspace_id (or unambiguous name). Files are untouched. */
  async remove(idOrName: string): Promise<WorkspaceConfig> {
    return this.withLockRetry(() => this.configStore.remove(idOrName));
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

  /** Suggest an identity for a root candidate: sanitized canonical path base. */
  suggestIdentity(rootPath: string): string {
    const validation = this.validateRoot(rootPath);
    if (!validation.ok || validation.canonicalRoot === undefined) {
      throw new ConfigError(validation.reason ?? `Invalid root: ${rootPath}`);
    }
    return sanitizeWorkspaceIdBase(path.basename(validation.canonicalRoot));
  }

  /**
   * Validate a candidate identity for a NEW workspace: pattern, length, and
   * uniqueness against the current configuration.
   */
  validateNewWorkspaceId(candidate: string): IdentityValidation {
    if (!WORKSPACE_ID_PATTERN.test(candidate) || candidate.length > WORKSPACE_ID_MAX_LENGTH) {
      return {
        ok: false,
        reason: `workspace_id must match ${WORKSPACE_ID_PATTERN} with length 1..${WORKSPACE_ID_MAX_LENGTH}.`,
      };
    }
    if (this.configStore.load().workspaces.some((ws) => ws.workspace_id === candidate)) {
      return { ok: false, reason: `workspace_id "${candidate}" is already in use.` };
    }
    return { ok: true };
  }

  private mutateWorkspace<T>(
    mutation: (config: WorkspaceLensConfig) => { next: WorkspaceLensConfig; result: T },
  ): Promise<T> {
    return this.withLockRetry(() =>
      this.configStore.mutate(mutation, { syncPoints: this.syncPoints }),
    );
  }

  /**
   * Run one config mutation, waiting out a lock held by another live
   * process. The wait yields the event loop (sleep/retry) instead of
   * spinning, so a concurrent CLI/WebUI mutation delays — but never blocks
   * — the caller, and a long-held lock fails explicitly after the budget.
   */
  private withLockRetry<T>(operation: () => T): Promise<T> {
    const deadline = Date.now() + this.lockTimeoutMs;
    const attempt = async (): Promise<T> => {
      try {
        return operation();
      } catch (error) {
        if (error instanceof ConfigLockBusyError && Date.now() < deadline) {
          await sleep(WorkspaceAdminService.LOCK_RETRY_DELAY_MS);
          return attempt();
        }
        throw error;
      }
    };
    return attempt();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether the root is currently an accessible directory (no parent fallback). */
function isAvailableRoot(root: string): boolean {
  try {
    return fs.statSync(root).isDirectory();
  } catch {
    return false;
  }
}

function requireWorkspace(config: WorkspaceLensConfig, workspaceId: string): WorkspaceConfig {
  const workspace = config.workspaces.find((ws) => ws.workspace_id === workspaceId);
  if (workspace === undefined) {
    throw new ConfigError(`No authorized workspace matches "${workspaceId}".`);
  }
  return workspace;
}

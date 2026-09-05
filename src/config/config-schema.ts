/**
 * Local configuration schema (`security-model.md` §5).
 *
 * The on-disk format is a private implementation detail; the authorization
 * semantics enforced here are contractual: stable workspace ids, canonical
 * absolute roots, explicit enabled flag, and fail-closed parsing.
 */
import path from "node:path";

export const CONFIG_VERSION = 1;

/** `workspace_id` contract (`mcp-tools-spec.md` §3.1). */
export const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const WORKSPACE_ID_MAX_LENGTH = 64;
export const WORKSPACE_NAME_MAX_LENGTH = 100;

export interface WorkspaceConfig {
  /** Stable local identifier used by all MCP tools. */
  workspace_id: string;
  /** Human-readable display name, separate from the id. */
  name: string;
  /** Canonical absolute root path. */
  root: string;
  /** Disabled workspaces behave as unavailable. */
  enabled: boolean;
}

export interface WorkspaceLensConfig {
  version: typeof CONFIG_VERSION;
  /**
   * Local-only option (`mcp-tools-spec.md` §7): when true, workspace_info
   * may return the canonical absolute root path. Defaults to false.
   */
  expose_absolute_paths: boolean;
  workspaces: WorkspaceConfig[];
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function emptyConfig(): WorkspaceLensConfig {
  return { version: CONFIG_VERSION, expose_absolute_paths: false, workspaces: [] };
}

/**
 * Parse and validate raw configuration. Any structural problem fails safely:
 * the caller must never partially interpret a malformed config file.
 */
export function parseConfig(raw: unknown): WorkspaceLensConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("Configuration must be a JSON object.");
  }
  const obj = raw as Record<string, unknown>;

  if (obj.version !== CONFIG_VERSION) {
    throw new ConfigError(
      `Unsupported config version: ${JSON.stringify(obj.version) ?? String(obj.version)}. Expected ${CONFIG_VERSION}.`,
    );
  }

  const expose = obj.expose_absolute_paths ?? false;
  if (typeof expose !== "boolean") {
    throw new ConfigError("`expose_absolute_paths` must be a boolean.");
  }

  const workspacesRaw = obj.workspaces ?? [];
  if (!Array.isArray(workspacesRaw)) {
    throw new ConfigError("`workspaces` must be an array.");
  }

  const workspaces: WorkspaceConfig[] = [];
  const seenIds = new Set<string>();
  const seenRoots = new Set<string>();
  for (const entry of workspacesRaw) {
    const ws = parseWorkspace(entry);
    if (seenIds.has(ws.workspace_id)) {
      throw new ConfigError(`Duplicate workspace_id: ${ws.workspace_id}`);
    }
    const rootKey = path.normalize(ws.root);
    if (seenRoots.has(rootKey)) {
      throw new ConfigError(
        `Duplicate workspace root configured for workspace_id: ${ws.workspace_id}`,
      );
    }
    seenIds.add(ws.workspace_id);
    seenRoots.add(rootKey);
    workspaces.push(ws);
  }

  return { version: CONFIG_VERSION, expose_absolute_paths: expose, workspaces };
}

function parseWorkspace(raw: unknown): WorkspaceConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ConfigError("Each workspace entry must be an object.");
  }
  const obj = raw as Record<string, unknown>;

  const id = obj.workspace_id;
  if (typeof id !== "string" || !WORKSPACE_ID_PATTERN.test(id) || id.length > WORKSPACE_ID_MAX_LENGTH) {
    throw new ConfigError(
      `workspace_id must match ${WORKSPACE_ID_PATTERN} with length 1..${WORKSPACE_ID_MAX_LENGTH}.`,
    );
  }

  const name = obj.name;
  if (typeof name !== "string" || name.length < 1 || name.length > WORKSPACE_NAME_MAX_LENGTH) {
    throw new ConfigError(`workspace ${id}: name must be a string of length 1..${WORKSPACE_NAME_MAX_LENGTH}.`);
  }

  const root = obj.root;
  if (typeof root !== "string" || root.length === 0 || !path.isAbsolute(root)) {
    throw new ConfigError(`workspace ${id}: root must be an absolute path.`);
  }

  if (typeof obj.enabled !== "boolean") {
    throw new ConfigError(`workspace ${id}: enabled must be a boolean.`);
  }

  return { workspace_id: id, name, root, enabled: obj.enabled };
}

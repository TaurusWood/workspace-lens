/**
 * File-backed store for locally authorized workspaces.
 *
 * These are local administrative operations (`implementation-plan.md` §9):
 * they modify WorkspaceLens's own configuration, never user workspace
 * content. MCP callers have no access to this store.
 *
 * Authorization semantics (`security-model.md` §5):
 * - roots are canonicalized before saving;
 * - duplicate and overlapping roots are rejected;
 * - a missing root never falls back to a parent directory;
 * - workspace ids are stable after registration.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ConfigError,
  WORKSPACE_ID_MAX_LENGTH,
  WORKSPACE_ID_PATTERN,
  emptyConfig,
  parseConfig,
  type WorkspaceConfig,
  type WorkspaceLensConfig,
} from "./config-schema.js";

/** Expand a leading `~/` so quoted shell arguments still resolve to home. */
export function expandTilde(inputPath: string): string {
  if (inputPath === "~") return os.homedir();
  if (inputPath.startsWith("~/")) return path.join(os.homedir(), inputPath.slice(2));
  return inputPath;
}

/**
 * Canonical form of a root for comparison and storage: the real path when it
 * exists, otherwise the lexically-resolved absolute path. There is never a
 * fallback to a parent directory.
 */
export function canonicalizeRootCandidate(rootPath: string): string {
  try {
    return fs.realpathSync(rootPath);
  } catch {
    return path.resolve(rootPath);
  }
}

export function defaultConfigPath(): string {
  const fromEnv = process.env.WORKSPACE_LENS_CONFIG;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return path.join(os.homedir(), ".config", "workspace-lens", "config.json");
}

export function isPathContained(ancestor: string, candidate: string): boolean {
  const rel = path.relative(ancestor, candidate);
  return rel === "" || (!rel.startsWith(`..${path.sep}`) && rel !== ".." && !path.isAbsolute(rel));
}

export interface AddWorkspaceOptions {
  name?: string;
  id?: string;
}

export class ConfigStore {
  readonly filePath: string;

  constructor(filePath: string = defaultConfigPath()) {
    this.filePath = filePath;
  }

  load(): WorkspaceLensConfig {
    let rawText: string;
    try {
      rawText = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyConfig();
      }
      throw new ConfigError(`Cannot read config file ${this.filePath}: ${describeError(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ConfigError(`Config file ${this.filePath} is not valid JSON.`);
    }
    return parseConfig(parsed);
  }

  save(config: WorkspaceLensConfig): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // rename already moved the temp file
      }
    }
  }

  /**
   * Authorize a new workspace root. The root must currently exist as a
   * directory; it is canonicalized before saving. Duplicate and overlapping
   * roots are rejected.
   */
  add(rootPath: string, options: AddWorkspaceOptions = {}): WorkspaceConfig {
    const canonical = this.canonicalizeExistingRoot(rootPath);
    const config = this.load();

    for (const existing of config.workspaces) {
      const existingCanonical = canonicalizeRootCandidate(existing.root);
      if (existingCanonical === canonical) {
        throw new ConfigError(
          `This root is already authorized as workspace "${existing.workspace_id}".`,
        );
      }
      if (isPathContained(existingCanonical, canonical) || isPathContained(canonical, existingCanonical)) {
        throw new ConfigError(
          `This root overlaps the already-authorized workspace "${existing.workspace_id}".`,
        );
      }
    }

    const workspace_id = options.id !== undefined
      ? validatedExplicitId(options.id, config)
      : deriveUniqueId(path.basename(canonical), config);
    const name = options.name?.trim() || path.basename(canonical);

    const workspace: WorkspaceConfig = {
      workspace_id,
      name,
      root: canonical,
      enabled: true,
    };
    config.workspaces.push(workspace);
    this.save(config);
    return workspace;
  }

  /** Remove by workspace_id, or by exact name when the name is unambiguous. */
  remove(idOrName: string): WorkspaceConfig {
    const config = this.load();
    let index = config.workspaces.findIndex((ws) => ws.workspace_id === idOrName);
    if (index === -1) {
      const byName = config.workspaces.filter((ws) => ws.name === idOrName);
      if (byName.length === 1) {
        index = config.workspaces.indexOf(byName[0]!);
      } else if (byName.length > 1) {
        throw new ConfigError(
          `Workspace name "${idOrName}" is ambiguous; remove by workspace_id instead.`,
        );
      }
    }
    if (index === -1) {
      throw new ConfigError(`No authorized workspace matches "${idOrName}".`);
    }
    const [removed] = config.workspaces.splice(index, 1);
    this.save(config);
    return removed!;
  }

  private canonicalizeExistingRoot(rootPath: string): string {
    const expanded = expandTilde(rootPath);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(expanded);
    } catch {
      throw new ConfigError(`Path does not exist or is inaccessible: ${rootPath}`);
    }
    if (!stats.isDirectory()) {
      throw new ConfigError(`Not a directory: ${rootPath}`);
    }
    return fs.realpathSync(expanded);
  }
}

function validatedExplicitId(id: string, config: WorkspaceLensConfig): string {
  if (!WORKSPACE_ID_PATTERN.test(id) || id.length > WORKSPACE_ID_MAX_LENGTH) {
    throw new ConfigError(
      `workspace_id must match ${WORKSPACE_ID_PATTERN} with length 1..${WORKSPACE_ID_MAX_LENGTH}.`,
    );
  }
  if (config.workspaces.some((ws) => ws.workspace_id === id)) {
    throw new ConfigError(`workspace_id "${id}" is already in use.`);
  }
  return id;
}

function sanitizeIdBase(base: string): string {
  const sanitized = base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, WORKSPACE_ID_MAX_LENGTH);
  return sanitized === "" ? "workspace" : sanitized;
}

function deriveUniqueId(base: string, config: WorkspaceLensConfig): string {
  const first = sanitizeIdBase(base);
  if (!config.workspaces.some((ws) => ws.workspace_id === first)) {
    return first;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = first.slice(0, WORKSPACE_ID_MAX_LENGTH - suffix.length) + suffix;
    if (!config.workspaces.some((ws) => ws.workspace_id === candidate)) {
      return candidate;
    }
  }
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

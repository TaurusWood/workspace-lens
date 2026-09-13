/**
 * Inter-process config mutation lock (`docs/v0.3-implementation-plan.md` §5).
 *
 * Mechanism: an atomic `mkdir` on `<configPath>.lock`. Directory creation is
 * atomic across processes, so exactly one contender owns the lock; release
 * removes the directory. A lock whose directory mtime is older than
 * `staleMs` is recovered (removed and retried), bounding the wait after a
 * crashed holder. Contention waits a bounded `timeoutMs` and then fails
 * explicitly — it never falls back to writing unlocked.
 *
 * The acquisition is synchronous by design: config mutations are short
 * (read + rewrite of a tiny file) and callers such as `ConfigStore.mutate`
 * must be able to complete an uncontended mutation within one synchronous
 * call (the multi-process CFG-004 contract depends on it). The contended
 * path busy-waits at most `timeoutMs` (default 500ms) before failing.
 */
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./config-schema.js";

export interface ConfigLockOptions {
  /** Bounded contention wait in ms; <= 0 makes the first attempt final. Default 500. */
  timeoutMs?: number;
  /** Age in ms after which an unreleased lock is recovered as stale. Default 10000. */
  staleMs?: number;
}

export interface ConfigLockHandle {
  release(): void;
}

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_STALE_MS = 10000;

export function configLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/** Acquire the config lock or fail explicitly with a stable config error. */
export function acquireConfigLock(configPath: string, options: ConfigLockOptions = {}): ConfigLockHandle {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const lockDir = configLockPath(configPath);
  const deadline = Date.now() + timeoutMs;

  // The lock directory lives next to the config file; its parent may not
  // exist yet (first mutation creates the config). This creates only
  // directories — never the config file itself.
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return { release(): void { fs.rmSync(lockDir, { recursive: true, force: true }); } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ConfigError(
          `Cannot create the config lock ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    // The lock is held. Recover it only after a bounded stale age; a live
    // holder refreshes nothing but holds for far less than `staleMs`.
    if (isStale(lockDir, staleMs)) {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
      } catch {
        // Another contender recovered it first; retry the mkdir below.
      }
      continue;
    }

    if (Date.now() >= deadline) {
      throw new ConfigError(
        `Could not acquire the config lock for ${configPath}: the lock is held by another process ` +
          `(timeout after ${timeoutMs}ms). No changes were written.`,
      );
    }
  }
}

function isStale(lockDir: string, staleMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > staleMs;
  } catch {
    // Vanished between mkdir and stat: treat as free and retry the mkdir.
    return false;
  }
}

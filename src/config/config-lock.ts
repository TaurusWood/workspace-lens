/**
 * Inter-process config mutation lock (`docs/v0.3-implementation-plan.md` §5).
 *
 * Mechanism: an atomic `mkdir` on `<configPath>.lock` plus an owner-token
 * file inside the lock directory. The token is the acquisition identity and
 * is what makes stale recovery safe:
 *
 * - release() removes ONLY its own token file, then the directory ONLY if
 *   it is empty. A stale holder that resumes after a successor took over
 *   therefore cannot delete the successor's lock — it finds no token of its
 *   own and no empty directory to remove.
 * - stale recovery moves the abandoned directory aside with one atomic
 *   rename before creating a new lock, so two concurrent recovery attempts
 *   cannot both win, and the recovery itself is bounded by `staleMs`.
 *
 * Contention waits belong to the caller: `acquireConfigLock` makes a single
 * acquisition attempt (plus immediate stale recovery) and fails with
 * `ConfigLockBusyError` while a live owner holds the lock. The application
 * service retries without blocking the event loop; `timeoutMs > 0` opts
 * into a synchronous busy-wait and exists only for short-lived low-level
 * uses (tests), never for the product mutation path.
 *
 * A crash between `mkdir` and the token write leaves an owner-less
 * directory; it holds nothing back and is recovered after `staleMs`.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./config-schema.js";

export interface ConfigLockOptions {
  /**
   * Bounded synchronous contention wait in ms; 0 (the default) makes the
   * first failed attempt final.
   */
  timeoutMs?: number;
  /** Age in ms after which an unreleased lock is recovered as stale. Default 10000. */
  staleMs?: number;
}

export interface ConfigLockHandle {
  release(): void;
}

/** The lock is currently held by a live owner; safe to retry against. */
export class ConfigLockBusyError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLockBusyError";
  }
}

const DEFAULT_STALE_MS = 10000;

export function configLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/** Acquire the config lock or fail explicitly; never writes unlocked. */
export function acquireConfigLock(configPath: string, options: ConfigLockOptions = {}): ConfigLockHandle {
  const timeoutMs = options.timeoutMs ?? 0;
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const lockDir = configLockPath(configPath);
  const deadline = Date.now() + timeoutMs;

  // The lock directory lives next to the config file; its parent may not
  // exist yet (first mutation creates the config). This creates only
  // directories — never the config file itself.
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });

  const token = `${process.pid}-${randomUUID()}`;
  for (;;) {
    if (tryAcquire(lockDir, token)) {
      return createHandle(lockDir, token);
    }

    // The lock is held. Recover it only after a bounded stale age; a live
    // holder holds for far less than `staleMs`.
    if (isStale(lockDir, staleMs)) {
      recoverStale(lockDir, token);
      continue;
    }

    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(
        `The config lock for ${configPath} is held by another process ` +
          `(not stale after ${timeoutMs}ms). No changes were written.`,
      );
    }
  }
}

function tryAcquire(lockDir: string, token: string): boolean {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw new ConfigError(
      `Cannot create the config lock ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.writeFileSync(path.join(lockDir, ownerFileName(token)), token, { mode: 0o600 });
    return true;
  } catch (error) {
    // Never leave an unusable lock behind; stale recovery is the backstop.
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw new ConfigError(
      `Cannot write the config lock owner token in ${lockDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Move an abandoned lock directory aside atomically, then delete it. If
 * another actor recovered it first, the rename fails with ENOENT and the
 * caller simply retries the acquisition against whatever is there now.
 */
function recoverStale(lockDir: string, token: string): void {
  const stalePath = `${lockDir}.stale-${token}`;
  try {
    fs.renameSync(lockDir, stalePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new ConfigError(
      `Cannot recover the stale config lock ${lockDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.rmSync(stalePath, { recursive: true, force: true });
  } catch {
    // Best effort; the uniquely-named leftover is inert.
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

/**
 * The owner file NAME carries the acquisition token, which is what makes
 * release structurally safe: `unlink` targets a path only our acquisition
 * ever created, so it cannot delete a successor's owner file no matter how
 * the directory's contents changed while we were suspended. The directory
 * itself is removed only when empty — an empty lock directory holds no
 * owner file, so it proves no live ownership.
 */
function ownerFileName(token: string): string {
  return `owner-${token}`;
}

function createHandle(lockDir: string, token: string): ConfigLockHandle {
  const ownerFile = path.join(lockDir, ownerFileName(token));
  return {
    release(): void {
      // Remove only OUR owner file (the name embeds our token), then the
      // directory only when empty. If a successor took over (stale
      // recovery), its owner file has a different name, the directory is
      // non-empty, and nothing of theirs is deleted.
      try {
        fs.unlinkSync(ownerFile);
      } catch {
        // Already gone (taken over or double release).
      }
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // ENOENT: taken over or already released. ENOTEMPTY: a successor
        // owns the directory now. Never remove someone else's lock.
      }
    },
  };
}

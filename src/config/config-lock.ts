/**
 * Inter-process config mutation lock (`docs/v0.3-implementation-plan.md` §5).
 *
 * Ownership protocol:
 *
 * - Ownership is one atomic `mkdir` of `<configPath>.lock` plus an
 *   `owner-<token>` file inside it whose NAME carries the acquisition token
 *   and whose content records `{ token, pid }`.
 * - release() unlinks ONLY the file named with our own token and then
 *   removes the directory ONLY if it is empty (empty = no owner file = no
 *   live ownership). Structurally it can never delete another holder's
 *   lock, whatever happened meanwhile.
 * - Stale recovery is bound to OWNER DEATH, not to lock age: a directory
 *   whose recorded owner process is still alive is never taken over, no
 *   matter how old its mtime is. A suspended or sleeping holder therefore
 *   keeps exclusive ownership and its in-flight mutation cannot lose a
 *   successor's accepted change, because no successor can exist. Only a
 *   DEAD owner's owner-file is unlinked, and the unlink target name is the
 *   observed dead token, so concurrent recovery attempts race on atomic
 *   mkdir afterwards instead of stealing from each other.
 * - A lock directory WITHOUT any owner file holds no proof of ownership
 *   (initialization window or crash remnant), and neither does one whose
 *   owner file is unreadable. Both are removed only once the directory is
 *   older than `staleMs` — by then a live writer's microsecond-scale write
 *   has long completed, so the remnant provably belongs to a dead writer.
 *   Removal itself is conditional (rmdir on empty / unlink by exact name),
 *   so it can never destroy ownership that appeared meanwhile.
 *
 * PID reuse is handled fail-safe: a recycled pid makes a dead owner look
 * alive, so recovery is skipped and callers see an explicit lock timeout —
 * never a wrong takeover.
 *
 * Contention waits belong to the caller: acquisition is a single attempt
 * (`timeoutMs <= 0`, the default) and fails with `ConfigLockBusyError`
 * while a live owner holds the lock. The application service retries by
 * yielding; `timeoutMs > 0` opts into a synchronous busy-wait and exists
 * only for short-lived low-level uses (tests), never the product path.
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
  /**
   * Age in ms after which an owner-LESS (no readable owner file) lock
   * directory counts as a crash remnant and may be removed. Recovery of a
   * directory WITH an owner file is driven by owner-process death instead.
   * Default 10000. Kept for API compatibility with previous releases.
   */
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
const OWNER_PREFIX = "owner-";

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

    // The lock directory exists. Reclaim it only when ownership provably
    // ended (dead owner, aged-out remnant); otherwise it is held.
    if (reclaimIfRecoverable(lockDir, staleMs)) {
      continue;
    }

    if (Date.now() >= deadline) {
      throw new ConfigLockBusyError(
        `The config lock for ${configPath} is held by another process ` +
          `(its recorded owner process is alive; waited ${timeoutMs}ms). No changes were written.`,
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
    fs.writeFileSync(
      path.join(lockDir, ownerFileName(token)),
      JSON.stringify({ token, pid: process.pid }),
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    // Ownership-conditioned cleanup, like release(): remove only our own
    // owner file (the name embeds our token — this directory was created by
    // THIS acquisition, so nothing inside it can belong to anyone else) and
    // then the directory only if empty. No recursive delete. If cleanup
    // cannot finish, owner-less recovery is the bounded backstop.
    try {
      fs.unlinkSync(path.join(lockDir, ownerFileName(token)));
    } catch {
      // Nothing of ours to remove.
    }
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Non-empty or gone; the age-out rules handle any remnant.
    }
    throw new ConfigError(
      `Cannot write the config lock owner token in ${lockDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

interface OwnerFile {
  file: string;
  /** Parsed owner pid; undefined when the file is unreadable/corrupt. */
  pid: number | undefined;
}

/**
 * Every deletion in the recovery protocol is conditional, so it can never
 * destroy live ownership:
 *
 * - an owner file whose recorded process is DEAD is unlinked by its exact
 *   name — a dead process cannot resurrect or rewrite it, and a successor's
 *   file has a different token in its name;
 * - a CORRUPT (unreadable) owner file is only removed once the directory is
 *   older than `staleMs`: by then a live writer's microsecond-scale write
 *   has long completed (a complete file parses and is judged by pid), so an
 *   aged corrupt file is provably a dead writer's remnant;
 * - an EMPTY directory holds no owner file, hence no proof of ownership;
 *   it is removed with rmdir, which fails atomically if any owner file
 *   appeared meanwhile.
 *
 * A live owner is never taken over, no matter how old its lock is: PID reuse
 * makes dead owners look alive instead (explicit timeout, never a wrong
 * takeover).
 */
function reclaimIfRecoverable(lockDir: string, staleMs: number): boolean {
  let files: string[];
  try {
    files = fs.readdirSync(lockDir).filter((name) => name.startsWith(OWNER_PREFIX));
  } catch {
    return false; // vanished; retry the acquisition
  }

  if (files.length === 0) {
    if (!isOldEnough(lockDir, staleMs)) {
      return false; // likely an initialization window; do not touch it
    }
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // ENOTEMPTY: an owner file appeared (they keep the lock); ENOENT:
      // gone. Either way, retry the acquisition.
    }
    return true;
  }

  const deadOwnerFiles: string[] = [];
  const corruptFiles: string[] = [];
  for (const file of files) {
    let pid: unknown;
    try {
      pid = (JSON.parse(fs.readFileSync(path.join(lockDir, file), "utf8")) as { pid?: unknown }).pid;
    } catch {
      corruptFiles.push(file);
      continue;
    }
    if (typeof pid === "number" && processAlive(pid)) {
      return false; // a live owner holds this lock: never take over
    }
    if (typeof pid === "number") {
      deadOwnerFiles.push(file);
    } else {
      corruptFiles.push(file);
    }
  }
  if (deadOwnerFiles.length === 0 && corruptFiles.length === 0) {
    return false; // unreachable in practice; treat as held
  }
  let progressed = false;
  for (const file of deadOwnerFiles) {
    try {
      fs.unlinkSync(path.join(lockDir, file));
      progressed = true;
    } catch {
      // Another recovery actor got there first; that state change also
      // warrants one immediate retry.
      progressed = true;
    }
  }
  // A corrupt owner file proves no live ownership but is only removed once
  // the directory ages out (a live writer completes in microseconds). While
  // it is fresh, NOTHING can be reclaimed here: returning false makes the
  // acquisition fail busy so the application layer can yield and retry —
  // returning true would spin this synchronous loop until the age-out.
  if (corruptFiles.length > 0 && isOldEnough(lockDir, staleMs)) {
    for (const file of corruptFiles) {
      try {
        fs.unlinkSync(path.join(lockDir, file));
        progressed = true;
      } catch {
        // Gone already.
        progressed = true;
      }
    }
  }
  if (!progressed) {
    return false; // held: nothing was reclaimed, let the caller yield/timeout
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // ENOTEMPTY: something owns it now; ENOENT: gone. Retry acquisition.
  }
  return true;
}

function isOldEnough(lockDir: string, staleMs: number): boolean {
  try {
    return Date.now() - fs.statSync(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}

/** EPERM means the process exists but is not ours: treat it as alive. */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
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
  return `${OWNER_PREFIX}${token}`;
}

function createHandle(lockDir: string, token: string): ConfigLockHandle {
  const ownerFile = path.join(lockDir, ownerFileName(token));
  return {
    release(): void {
      // Remove only OUR owner file (the name embeds our token), then the
      // directory only when empty. If a successor owns the directory, its
      // owner file has a different name, the directory is non-empty, and
      // nothing of theirs is deleted.
      try {
        fs.unlinkSync(ownerFile);
      } catch {
        // Already gone (double release).
      }
      try {
        fs.rmdirSync(lockDir);
      } catch {
        // ENOENT: already released. ENOTEMPTY: a successor owns the
        // directory now. Never remove someone else's lock.
      }
    },
  };
}

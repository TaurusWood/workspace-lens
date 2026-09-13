/**
 * Shared owner-token lock primitive.
 *
 * The single implementation of the inter-process ownership protocol used by
 * BOTH the config-write lock (`config/config-lock.ts`) and the runtime
 * singleton lock (`control/runtime-lock.ts`), so the two abstractions cannot
 * drift apart again:
 *
 * - Ownership = one atomic `mkdir` of `lockDir` plus an `owner-<token>` file
 *   inside it whose NAME carries the acquisition token and whose content
 *   records `{ token, pid }`.
 * - release() unlinks ONLY the file named with our own token and removes the
 *   directory ONLY if it is empty — structurally unable to delete a
 *   successor's lock.
 * - Recovery is bound to OWNER DEATH, not lock age: a recorded owner process
 *   that is still alive is never taken over. A DEAD owner's owner files are
 *   unlinked by their exact observed names and the directory is removed only
 *   when empty; concurrent recovery attempts race on the atomic mkdir.
 * - Owner-LESS or CORRUPT directories (crash between mkdir and the owner
 *   write, or mid-JSON) prove no live ownership; they are reclaimed only
 *   after `staleMs` — by then a live writer's microsecond-scale write has
 *   long completed. A fresh corrupt remnant FAILS BUSY instead of spinning:
 *   every reclaim call that performs no state change returns "held".
 * - PID reuse fails safe: a recycled pid makes a dead owner look alive, so
 *   recovery is skipped and callers see an explicit busy/timeout.
 *
 * Waiting belongs to the caller: `tryAcquireOwnerLock` makes ONE attempt and
 * reports `held` (with the live owner pid) instead of blocking.
 * `acquireOwnerLock` additionally offers an opt-in synchronous spin
 * (`timeoutMs > 0`) for short-lived low-level uses; the product mutation
 * path never uses it (the application service yields and retries).
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface OwnerLockOptions {
  lockDir: string;
  /** Age in ms after which owner-LESS/corrupt remnants may be reclaimed. Default 10000. */
  staleMs?: number;
  /**
   * Bounded synchronous contention wait in ms; 0 (the default) makes the
   * first failed attempt final.
   */
  timeoutMs?: number;
}

export interface OwnerLockHandle {
  release(): void;
}

export type OwnerLockAttempt =
  | { acquired: true; handle: OwnerLockHandle }
  | { acquired: false; ownerPid: number | undefined };

/** The lock is held by a live owner; safe to retry against. */
export class OwnerLockBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerLockBusyError";
  }
}

/** Acquire without waiting: one attempt, `held` (with owner pid) when busy. */
export function tryAcquireOwnerLock(options: OwnerLockOptions): OwnerLockAttempt {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
  const lockDir = options.lockDir;
  fs.mkdirSync(path.dirname(lockDir), { recursive: true, mode: 0o700 });
  const token = `${process.pid}-${randomUUID()}`;

  for (;;) {
    if (tryAcquire(lockDir, token)) {
      const ownerFile = path.join(lockDir, ownerFileName(token));
      return {
        acquired: true,
        handle: {
          release(): void {
            try {
              fs.unlinkSync(ownerFile);
            } catch {
              // Already gone (double release).
            }
            try {
              fs.rmdirSync(lockDir);
            } catch {
              // ENOTEMPTY: someone else owns it now; ENOENT: gone.
            }
          },
        },
      };
    }
    if (!reclaimIfRecoverable(lockDir, staleMs)) {
      return { acquired: false, ownerPid: readLiveOwnerPid(lockDir) };
    }
  }
}

/** Acquire, optionally waiting synchronously; busy becomes an explicit error. */
export function acquireOwnerLock(options: OwnerLockOptions): OwnerLockHandle {
  const deadline = Date.now() + (options.timeoutMs ?? 0);
  for (;;) {
    const attempt = tryAcquireOwnerLock(options);
    if (attempt.acquired) {
      return attempt.handle;
    }
    if (Date.now() >= deadline) {
      throw new OwnerLockBusyError(
        `The lock ${options.lockDir} is held by another process ` +
          `(its recorded owner process is alive; waited ${options.timeoutMs ?? 0}ms). No changes were written.`,
      );
    }
  }
}

const DEFAULT_STALE_MS = 10000;
const OWNER_PREFIX = "owner-";

export function ownerFileName(token: string): string {
  return `${OWNER_PREFIX}${token}`;
}

function tryAcquire(lockDir: string, token: string): boolean {
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      return false;
    }
    throw new Error(
      `Cannot create the lock directory ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.writeFileSync(path.join(lockDir, ownerFileName(token)), JSON.stringify({ token, pid: process.pid }), {
      mode: 0o600,
    });
    return true;
  } catch (error) {
    // Ownership-conditioned cleanup, like release(): remove only our own
    // owner file (the name embeds our token — this directory was created by
    // THIS acquisition, so nothing inside it can belong to anyone else) and
    // then the directory only if empty. No recursive delete. If cleanup
    // cannot finish, the age-out rules handle any remnant.
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
    throw new Error(
      `Cannot write the lock owner token in ${lockDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reclaim the lock directory when ownership provably ended. Returns whether
 * state actually changed (true → the caller may immediately retry the
 * mkdir); a held lock returns false WITHOUT any deletion, so a fresh corrupt
 * remnant can never turn into a synchronous spin.
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
      // ENOTEMPTY: an owner file appeared (they keep the lock); ENOENT: gone.
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
    } catch {
      // Another recovery actor got there first; that state change also
      // warrants one immediate retry.
    }
    progressed = true;
  }
  // A corrupt owner file proves no live ownership but is only removed once
  // the directory ages out (a live writer completes in microseconds). While
  // it is fresh, NOTHING is reclaimed here: returning held makes the
  // acquisition fail busy so the application layer can yield and retry.
  if (corruptFiles.length > 0 && isOldEnough(lockDir, staleMs)) {
    for (const file of corruptFiles) {
      try {
        fs.unlinkSync(path.join(lockDir, file));
      } catch {
        // Gone already.
      }
      progressed = true;
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

function listOwnerFiles(lockDir: string): string[] {
  try {
    return fs.readdirSync(lockDir).filter((name) => name.startsWith(OWNER_PREFIX));
  } catch {
    return [];
  }
}

function readLiveOwnerPid(lockDir: string): number | undefined {
  for (const file of listOwnerFiles(lockDir)) {
    try {
      const pid = (JSON.parse(fs.readFileSync(path.join(lockDir, file), "utf8")) as { pid?: unknown }).pid;
      if (typeof pid === "number" && processAlive(pid)) {
        return pid;
      }
    } catch {
      // Unreadable entry: no pid to report.
    }
  }
  return undefined;
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

/**
 * Runtime singleton lock (`docs/v0.3-implementation-plan.md` §7).
 *
 * Separate abstraction from the config-write lock: it guards the ONE
 * long-lived Control Runtime per state root and is held for the runtime's
 * whole lifetime, while the config lock only spans one mutation. The
 * ownership protocol is the same proven scheme as `config/config-lock.ts`
 * (atomic mkdir + `owner-<token>` file recording `{ token, pid }`):
 *
 * - a live owner is never taken over — the second `workspace-lens control`
 *   reuses or rejects instead of starting a duplicate runtime;
 * - a DEAD owner (crashed runtime) is recovered after bounded proof
 *   (process-death check), with all deletions conditioned on observed
 *   ownership (exact owner-file names, empty-only rmdir);
 * - no synchronous waiting: one acquisition attempt, then busy.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "../config/config-schema.js";

export interface RuntimeLockHandle {
  release(): void;
}

export type RuntimeLockOutcome =
  | { acquired: true; handle: RuntimeLockHandle }
  | { acquired: false; ownerPid: number | undefined };

/** Directory that holds the runtime lock and runtime state artifacts. */
export function runtimeLockPath(runtimeStatePath: string): string {
  return path.join(runtimeStatePath, "control.lock");
}

/** Acquire the singleton runtime lock for one state root, or report the live owner. */
export function acquireRuntimeLock(runtimeStatePath: string): RuntimeLockOutcome {
  fs.mkdirSync(runtimeStatePath, { recursive: true, mode: 0o700 });
  const lockDir = runtimeLockPath(runtimeStatePath);
  const token = `${process.pid}-${randomUUID()}`;

  for (;;) {
    if (tryAcquire(lockDir, token)) {
      const ownerFile = path.join(lockDir, `owner-${token}`);
      return {
        acquired: true,
        handle: {
          release(): void {
            // Ownership-conditioned cleanup, identical to the config lock:
            // only our own owner file, then the directory only when empty.
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

    // Held. Reclaim only when the recorded owner provably no longer exists;
    // otherwise report the live owner for reuse/rejection.
    if (!reclaimIfOwnerDead(lockDir)) {
      return { acquired: false, ownerPid: readLiveOwnerPid(lockDir) };
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
      `Cannot create the runtime lock ${lockDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    fs.writeFileSync(
      path.join(lockDir, `owner-${token}`),
      JSON.stringify({ token, pid: process.pid }),
      { mode: 0o600 },
    );
    return true;
  } catch (error) {
    // Ownership-conditioned cleanup of THIS acquisition's artifacts.
    try {
      fs.unlinkSync(path.join(lockDir, `owner-${token}`));
    } catch {
      // Nothing of ours to remove.
    }
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Non-empty or gone; the dead-owner/age rules handle remnants.
    }
    throw new ConfigError(
      `Cannot write the runtime lock owner token in ${lockDir}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Reclaim the lock only when every recorded owner process is dead. Deletes
 * are conditioned on the exact observed owner-file names; the directory is
 * removed only when empty. Returns true when state changed so the caller
 * can immediately retry the mkdir.
 */
function reclaimIfOwnerDead(lockDir: string): boolean {
  const files = listOwnerFiles(lockDir);
  if (files.length === 0) {
    // Owner-less remnant (crash between mkdir and the owner write): age it
    // out like the config lock does before removing it.
    if (!isOldEnough(lockDir, 10_000)) {
      return false;
    }
    try {
      fs.rmdirSync(lockDir);
    } catch {
      // Non-empty or gone; retry acquisition either way.
    }
    return true;
  }
  let dead = false;
  for (const file of files) {
    let pid: unknown;
    try {
      pid = (JSON.parse(fs.readFileSync(path.join(lockDir, file), "utf8")) as { pid?: unknown }).pid;
    } catch {
      return false; // unreadable: treat as held until it ages out
    }
    if (typeof pid === "number" && processAlive(pid)) {
      return false; // live owner: never take over
    }
    dead = true;
  }
  if (!dead) {
    return false;
  }
  for (const file of files) {
    try {
      fs.unlinkSync(path.join(lockDir, file));
    } catch {
      // Another recovery actor got there first.
    }
  }
  try {
    fs.rmdirSync(lockDir);
  } catch {
    // ENOTEMPTY/ENOENT: retry the acquisition either way.
  }
  return true;
}

function listOwnerFiles(lockDir: string): string[] {
  try {
    return fs.readdirSync(lockDir).filter((name) => name.startsWith("owner-"));
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

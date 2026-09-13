/**
 * Runtime singleton lock (`docs/v0.3-implementation-plan.md` §7).
 *
 * Separate abstraction from the config-write lock: it guards the ONE
 * long-lived Control Runtime per state root and is held for the runtime's
 * whole lifetime (released only after the listener is fully stopped), while
 * the config lock only spans one mutation. Both wrap the same shared
 * owner-token primitive (`core/owner-lock.ts`), which owns the complete
 * ownership protocol — live owners are never taken over regardless of lock
 * age, dead owners are reclaimed after process-death proof, and owner-less
 * or corrupt remnants are reclaimed only once they age out (a fresh corrupt
 * remnant fails busy instead of spinning).
 */
import fs from "node:fs";
import path from "node:path";
import {
  tryAcquireOwnerLock,
  type OwnerLockOptions,
} from "../core/owner-lock.js";
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
  try {
    fs.mkdirSync(runtimeStatePath, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ConfigError(
      `Cannot create the runtime state directory ${runtimeStatePath}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const ownerOptions: OwnerLockOptions = {
    lockDir: runtimeLockPath(runtimeStatePath),
    staleMs: 10_000,
  };
  const attempt = tryAcquireOwnerLock(ownerOptions);
  if (attempt.acquired) {
    return { acquired: true, handle: attempt.handle };
  }
  return { acquired: false, ownerPid: attempt.ownerPid };
}

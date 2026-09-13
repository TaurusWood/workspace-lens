/**
 * Config-write lock (`docs/v0.3-implementation-plan.md` §5): inter-process
 * mutual exclusion for ONE locked read-modify-write mutation.
 *
 * This is a thin config-shaped wrapper over the shared owner-token primitive
 * (`core/owner-lock.ts`), which owns the full ownership protocol (live owner
 * never taken over, dead-owner recovery, age-out of owner-less/corrupt
 * remnants, ownership-conditioned deletions). See that module for the
 * protocol invariants; `control/runtime-lock.ts` wraps the same primitive for
 * the runtime singleton, so the two abstractions cannot drift.
 */
import { ConfigError } from "./config-schema.js";
import {
  acquireOwnerLock,
  OwnerLockBusyError,
  type OwnerLockOptions,
} from "../core/owner-lock.js";

export interface ConfigLockOptions {
  /**
   * Bounded synchronous contention wait in ms; 0 (the default) makes the
   * first failed attempt final. Product callers do not wait here — the
   * application service yields and retries instead.
   */
  timeoutMs?: number;
  /**
   * Age in ms after which an owner-LESS/corrupt lock remnant may be
   * reclaimed. Recovery of a directory WITH a readable owner file is driven
   * by owner-process death instead. Default 10000.
   */
  staleMs?: number;
}

export interface ConfigLockHandle {
  release(): void;
}

/** The config lock is held by a live owner; safe to retry against. */
export class ConfigLockBusyError extends ConfigError {
  constructor(message: string) {
    super(message);
    this.name = "ConfigLockBusyError";
  }
}

/** Lock directory for a config file: `<configPath>.lock`. */
export function configLockPath(configPath: string): string {
  return `${configPath}.lock`;
}

/** Acquire the config lock or fail explicitly with a stable config error. */
export function acquireConfigLock(configPath: string, options: ConfigLockOptions = {}): ConfigLockHandle {
  const ownerOptions: OwnerLockOptions = {
    lockDir: configLockPath(configPath),
    staleMs: options.staleMs,
    timeoutMs: options.timeoutMs,
  };
  try {
    return acquireOwnerLock(ownerOptions);
  } catch (error) {
    if (error instanceof OwnerLockBusyError) {
      throw new ConfigLockBusyError(
        `The config lock for ${configPath} is held by another process ` +
          `(its recorded owner process is alive; waited ${options.timeoutMs ?? 0}ms). No changes were written.`,
      );
    }
    throw new ConfigError(error instanceof Error ? error.message : String(error));
  }
}

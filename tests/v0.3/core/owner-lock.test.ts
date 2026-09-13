import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireOwnerLock,
  OwnerLockBusyError,
  tryAcquireOwnerLock,
} from "../../../src/core/owner-lock.js";
import { makeTempRoot } from "../../helpers/fixtures.js";

/**
 * Shared owner-token lock primitive — R2 contract tests
 * (Review finding: `control/runtime-lock.ts` had re-introduced a corrupt-
 * owner stall by drifting from `config/config-lock.ts`). These tests pin the
 * ONE protocol both locks now share:
 *
 * 1. a live owner is never taken over, no matter how old the lock looks;
 * 2. a DEAD owner is reclaimed after process-death proof;
 * 3. a FRESH corrupt owner file (crash mid-JSON) fails BUSY promptly —
 *    no synchronous spin — and is reclaimed once it ages out;
 * 4. release removes only its own owner file and never a directory it no
 *    longer owns.
 */

function newLockDir(): { root: string; lockDir: string } {
  const root = makeTempRoot("wl-v03-ownerlock-");
  return { root, lockDir: path.join(root, "control.lock") };
}

function writeOwnerFile(lockDir: string, name: string, pid: number): void {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, name), JSON.stringify({ token: name, pid }), { mode: 0o600 });
}

function ageOut(lockDir: string): void {
  const past = new Date(Date.now() - 60_000);
  fs.utimesSync(lockDir, past, past);
}

describe("Owner lock primitive — shared ownership protocol", () => {
  it("never takes over a live owner, no matter how old the lock directory looks", () => {
    const { root, lockDir } = newLockDir();
    try {
      const holder = acquireOwnerLock({ lockDir, staleMs: 1 });
      try {
        // Age the directory far beyond any stale window: the recorded owner
        // process (this test process) is ALIVE, so this must stay busy.
        ageOut(lockDir);
        expect(() => acquireOwnerLock({ lockDir, staleMs: 1, timeoutMs: 0 })).toThrow(
          OwnerLockBusyError,
        );
      } finally {
        holder.release();
      }
      // Release frees the lock for the next acquirer.
      const next = acquireOwnerLock({ lockDir, staleMs: 1, timeoutMs: 0 });
      next.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reclaims the lock once the recorded owner process is dead", () => {
    const { root, lockDir } = newLockDir();
    try {
      // Simulate a crashed holder: an owner file whose pid cannot exist.
      writeOwnerFile(lockDir, "owner-dead-token", 999_999_999);
      const recovered = acquireOwnerLock({ lockDir, staleMs: 60_000, timeoutMs: 0 });
      recovered.release();
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails BUSY promptly on a fresh corrupt owner file and reclaims it after the age-out", () => {
    const { root, lockDir } = newLockDir();
    try {
      // Crash between mkdir and a complete owner write: fresh corrupt JSON.
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, "owner-fresh-corrupt"), "{ crashed mid-wri", { mode: 0o600 });

      // Nothing is reclaimable yet: busy must come back PROMPTLY (no
      // synchronous spin until the age-out).
      const startedAt = Date.now();
      expect(() => acquireOwnerLock({ lockDir, staleMs: 10_000, timeoutMs: 0 })).toThrow(
        OwnerLockBusyError,
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      // The same remnant becomes recoverable once it ages out.
      ageOut(lockDir);
      const recovered = acquireOwnerLock({ lockDir, staleMs: 10_000, timeoutMs: 0 });
      recovered.release();
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("release removes only its own owner file and never a directory it no longer owns", () => {
    const { root, lockDir } = newLockDir();
    try {
      const handle = acquireOwnerLock({ lockDir, staleMs: 10_000, timeoutMs: 0 });
      const foreignFile = path.join(lockDir, "owner-foreign-token");
      fs.writeFileSync(foreignFile, JSON.stringify({ token: "foreign", pid: 1 }), { mode: 0o600 });

      handle.release();

      // The foreign owner artifact survives; the directory stays (not empty).
      expect(fs.existsSync(foreignFile)).toBe(true);
      expect(fs.existsSync(lockDir)).toBe(true);

      // Once the foreign artifact is gone, the aged-out empty remnant is
      // reclaimable through normal acquisition.
      fs.rmSync(foreignFile);
      ageOut(lockDir);
      const next = acquireOwnerLock({ lockDir, staleMs: 1000, timeoutMs: 0 });
      next.release();
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the live owner pid when held", () => {
    const { root, lockDir } = newLockDir();
    try {
      const holder = acquireOwnerLock({ lockDir, staleMs: 10_000, timeoutMs: 0 });
      const attempt = tryAcquireOwnerLock({ lockDir, staleMs: 10_000 });
      expect(attempt.acquired).toBe(false);
      if (!attempt.acquired) {
        expect(attempt.ownerPid).toBe(process.pid);
      }
      holder.release();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

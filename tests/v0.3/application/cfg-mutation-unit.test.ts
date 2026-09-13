import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ConfigError, emptyConfig } from "../../../src/config/config-schema.js";
import { ConfigStore } from "../../../src/config/config-store.js";
import {
  acquireConfigLock,
  ConfigLockBusyError,
  configLockPath,
} from "../../../src/config/config-lock.js";
import { WorkspaceAdminService } from "../../../src/application/workspace-admin-service.js";
import { makeTempRoot, writeTree } from "../../helpers/fixtures.js";

/**
 * Slice 1 focused unit evidence for the safe mutation layer
 * (`docs/v0.3-implementation-plan.md` §5 Tests). The multi-process CFG
 * contracts in `cfg-config-mutation.test.ts` prove cross-process behavior;
 * these tests pin the unit-level mechanics: permissions, atomic replace,
 * explicit lock failure, bounded stale recovery, the CFG-004 seam, and the
 * identity immutability/suggestion rules.
 */

function newConfigFile(): string {
  const dir = makeTempRoot("wl-v03-cfg-unit-");
  return path.join(dir, "config.json");
}

function newWorkspace(tag: string): string {
  const root = makeTempRoot(`wl-v03-cfgu-${tag}-`);
  writeTree(root, { [`${tag}.txt`]: `${tag} content` });
  return root;
}

describe("CFG unit — locked mutation mechanics", () => {
  it("persists an uncontended mutation with 0600 file permissions and no temp leftovers", () => {
    const configPath = newConfigFile();
    try {
      const store = new ConfigStore(configPath);
      const result = store.mutate((config) => {
        config.workspaces.push({ workspace_id: "unit-a", name: "unit-a", root: "/tmp/unit-a", enabled: true });
        return { next: config, result: config.workspaces.length };
      });

      expect(result).toBe(1);
      // Restrictive permissions on the created file and directory.
      const mode = fs.statSync(configPath).mode & 0o777;
      expect(mode).toBe(0o600);
      const dirMode = fs.statSync(path.dirname(configPath)).mode & 0o777;
      // 0700-style directory: no group/other access at all.
      expect(dirMode & 0o077).toBe(0);
      // No temp/lock leftovers after the mutation completes.
      const siblings = fs.readdirSync(path.dirname(configPath));
      expect(siblings).toEqual(["config.json"]);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("fails closed when the mutation result is invalid; previous config stays untouched", () => {
    const configPath = newConfigFile();
    const root = newWorkspace("keep");
    try {
      const store = new ConfigStore(configPath);
      store.add(root, { id: "keep-me" });
      const before = fs.readFileSync(configPath, "utf8");

      expect(() =>
        store.mutate((config) => {
          // Corrupt the config: an invalid workspace id must fail validation.
          config.workspaces.push({
            workspace_id: "bad id with spaces",
            name: "bad",
            root: "/tmp/whatever",
            enabled: true,
          });
          return { next: config, result: undefined };
        }),
      ).toThrow(ConfigError);

      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("invokes the afterLoad seam with the in-lock latest config before applying", () => {
    const configPath = newConfigFile();
    try {
      const store = new ConfigStore(configPath);
      const seen: string[] = [];
      store.mutate(
        (config) => {
          // The seam observes the PRE-mutation state, synchronously in-lock.
          expect(seen).toEqual(["base"]);
          return { next: config, result: undefined };
        },
        {
          syncPoints: {
            afterLoad: (config) => {
              seen.push("base");
              expect(config).toEqual(emptyConfig());
            },
          },
        },
      );
      expect(seen).toEqual(["base"]);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

describe("CFG unit — config lock", () => {
  it("fails explicitly under contention and releases cleanly afterwards", () => {
    const configPath = newConfigFile();
    try {
      const holder = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      try {
        expect(() => acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 })).toThrow(
          /lock/i,
        );
      } finally {
        holder.release();
      }
      // Release removes the lock directory; acquisition succeeds again.
      expect(fs.existsSync(configLockPath(configPath))).toBe(false);
      const second = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      second.release();
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("never steals a live-but-old lock merely because its mtime aged past the window", async () => {
    const configPath = newConfigFile();
    try {
      // A child process acquires the lock and artificially ages its lock
      // directory far beyond any stale window while staying ALIVE.
      const readyFile = path.join(makeTempRoot("wl-v03-cfg-ready-"), "ready");
      const child = spawn(
        process.execPath,
        ["-e", LIVE_OLD_HOLDER_SCRIPT(configPath, readyFile)],
        { stdio: "ignore" },
      );
      const childDone = exitOf(child);
      try {
        await waitForFile(readyFile, 10_000);
        // The lock mtime is an hour old, but the recorded owner process is
        // alive: recovery is FORBIDDEN regardless of staleness settings.
        expect(() => acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 1 })).toThrow(
          ConfigLockBusyError,
        );
      } finally {
        await childDone;
      }
      // After the live owner releases, acquisition succeeds normally.
      const next = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 1 });
      next.release();
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("recovers the lock once the recorded owner process is dead", async () => {
    const configPath = newConfigFile();
    try {
      // A child process acquires the lock and CRASHES without releasing.
      const readyFile = path.join(makeTempRoot("wl-v03-cfg-ready-"), "ready");
      const child = spawn(
        process.execPath,
        ["-e", CRASHED_HOLDER_SCRIPT(configPath, readyFile)],
        { stdio: "ignore" },
      );
      const childDone = exitOf(child);
      await waitForFile(readyFile, 10_000);
      await childDone; // the owner pid is dead (and reaped) from here on

      // Recovery now succeeds without any mtime manipulation.
      const recovered = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      recovered.release();
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("fails busy promptly on a fresh corrupt owner file; recovers it after the age-out", () => {
    const configPath = newConfigFile();
    try {
      // Simulate a writer that crashed mid-JSON: a FRESH corrupt owner file.
      const lockDir = configLockPath(configPath);
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, "owner-fresh-corrupt"), "{ crashed mid-wri", {
        mode: 0o600,
      });

      // Nothing is reclaimable yet, so acquisition must fail BUSY promptly —
      // never synchronously spinning until the age-out.
      const startedAt = Date.now();
      expect(() => acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 10_000 })).toThrow(
        ConfigLockBusyError,
      );
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      // Once the remnant ages out, recovery succeeds unconditionally.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(lockDir, past, past);
      const recovered = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 10_000 });
      recovered.release();
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("release removes only its own owner file and never a directory it no longer owns", () => {    const configPath = newConfigFile();
    try {
      const handle = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      // Simulate any foreign owner artifact inside the lock directory.
      const foreignFile = path.join(configLockPath(configPath), "owner-foreign-token");
      fs.writeFileSync(foreignFile, "foreign", { mode: 0o600 });

      handle.release();

      // The foreign owner file survives; the directory stays because it is
      // not empty (release cannot delete what it does not own).
      expect(fs.existsSync(foreignFile)).toBe(true);
      expect(fs.existsSync(configLockPath(configPath))).toBe(true);

      // Cleaning the foreign artifact leaves an EMPTY lock directory: the
      // ownership protocol treats it as an owner-less remnant that ages out
      // (simulated here by backdating), after which acquisition succeeds.
      fs.rmSync(foreignFile);
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(configLockPath(configPath), past, past);
      const next = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 1000 });
      next.release();
      expect(fs.existsSync(configLockPath(configPath))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("keeps both accepted mutations when a slow holder commits while another waits", async () => {
    const configPath = newConfigFile();
    const rootSlow = newWorkspace("slow");
    const rootWaiter = newWorkspace("waiter");
    try {
      // The slow holder acquires the lock, stays alive for a while, and
      // commits from its (older) view while holding the lock. A waiting
      // mutation must NOT be able to interleave — after the holder
      // releases, the waiter re-enters and commits on the latest config.
      const readyFile = path.join(makeTempRoot("wl-v03-cfg-ready-"), "ready");
      const child = spawn(
        process.execPath,
        ["-e", SLOW_HOLDER_SCRIPT(configPath, readyFile, rootSlow, "slow-a")],
        { stdio: "ignore" },
      );
      const childDone = exitOf(child);
      await waitForFile(readyFile, 10_000);

      const service = new WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
      const waiter = await service.add({ root: rootWaiter, id: "waiter-b" });

      await childDone; // the slow holder committed slow-a and released

      // Business-level no-lost-update: BOTH accepted mutations exist,
      // exactly once, regardless of who held the lock longer.
      const config = new ConfigStore(configPath).load();
      const ids = config.workspaces.map((ws) => ws.workspace_id);
      expect(ids).toContain("slow-a");
      expect(ids).toContain(waiter.workspace_id);
      expect(ids.filter((id) => id === "slow-a")).toHaveLength(1);
      expect(ids.filter((id) => id === "waiter-b")).toHaveLength(1);
    } finally {
      fs.rmSync(rootSlow, { recursive: true, force: true });
      fs.rmSync(rootWaiter, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist");

/** Child holding the lock with an artificially aged (but ALIVE) ownership. */
const LIVE_OLD_HOLDER_SCRIPT = (configPath: string, readyFile: string): string => `
import fs from "node:fs";
const { acquireConfigLock, configLockPath } = await import(${JSON.stringify(path.join(DIST_ROOT, "config/config-lock.js"))});
const handle = acquireConfigLock(${JSON.stringify(configPath)}, { timeoutMs: 0, staleMs: 60000 });
const past = new Date(Date.now() - 3600_000);
fs.utimesSync(configLockPath(${JSON.stringify(configPath)}), past, past);
fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
setTimeout(() => { handle.release(); process.exit(0); }, 300);
`;

/** Child acquiring the lock and crashing without releasing. */
const CRASHED_HOLDER_SCRIPT = (configPath: string, readyFile: string): string => `
import fs from "node:fs";
const { acquireConfigLock } = await import(${JSON.stringify(path.join(DIST_ROOT, "config/config-lock.js"))});
acquireConfigLock(${JSON.stringify(configPath)}, { timeoutMs: 0 });
fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
process.exit(0);
`;

/**
 * Child committing through the REAL mutation path while holding the lock
 * longer than a waiter's first attempts: the afterLoad seam (in-lock,
 * after load, before apply) parks the mutation, so it commits from its
 * older in-lock view exactly like a slow holder would.
 */
const SLOW_HOLDER_SCRIPT = (configPath: string, readyFile: string, root: string, id: string): string => `
import fs from "node:fs";
const { ConfigStore } = await import(${JSON.stringify(path.join(DIST_ROOT, "config/config-store.js"))});
const { WorkspaceAdminService } = await import(${JSON.stringify(path.join(DIST_ROOT, "application/workspace-admin-service.js"))});
const service = new WorkspaceAdminService({
  configStore: new ConfigStore(${JSON.stringify(configPath)}),
  syncPoints: {
    afterLoad: () => {
      fs.writeFileSync(${JSON.stringify(readyFile)}, String(process.pid));
      const end = Date.now() + 300;
      while (Date.now() < end) { /* hold the lock from the in-lock view */ }
    },
  },
});
service.add({ root: ${JSON.stringify(root)}, id: ${JSON.stringify(id)} })
  .then(() => process.exit(0), (error) => { console.error(String(error && error.message)); process.exit(1); });
`;

function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (fs.existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${file}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

/**
 * Exit promise created IMMEDIATELY after spawn: a child that exits before
 * the test starts awaiting would otherwise emit its exit event without a
 * listener and the await would hang forever.
 */
function exitOf(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exit ${code}`))));
    child.on("error", reject);
  });
}

describe("CFG unit — yielding lock waits (no event-loop spinning)", () => {
  it("fails explicitly after the yielding budget when a live holder keeps the lock", async () => {
    const configPath = newConfigFile();
    const root = newWorkspace("yield-busy");
    try {
      const holder = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      try {
        const service = new WorkspaceAdminService({
          configStore: new ConfigStore(configPath),
          lockTimeoutMs: 150,
        });
        const startedAt = Date.now();
        await expect(service.add({ root, id: "yield-busy-ws" })).rejects.toThrow(
          /lock|timeout/i,
        );
        // The budget was actually observed (yielding wait, not instant fail).
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(140);
        // Nothing was written while the lock was held by someone else.
        expect(fs.existsSync(configPath)).toBe(false);
      } finally {
        holder.release();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("acquires the lock as soon as the current holder releases", async () => {
    const configPath = newConfigFile();
    const root = newWorkspace("yield-success");
    try {
      const holder = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      // The holder releases shortly after; the service's yielding wait must
      // then complete the mutation instead of failing.
      setTimeout(() => holder.release(), 30);
      const service = new WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
      const added = await service.add({ root, id: "yield-success-ws" });
      expect(added.workspace_id).toBe("yield-success-ws");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

describe("CFG unit — identity rules through the service", () => {
  it("suggests a sanitized identity from the canonical path and validates candidates", async () => {
    const root = newWorkspace("ident");
    const configPath = newConfigFile();
    try {
      const service = new WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
      // Path segments that need sanitizing collapse to valid id characters.
      const subDir = path.join(root, "sub dir");
      fs.mkdirSync(subDir);
      expect(service.suggestIdentity(subDir)).toBe("sub-dir");

      expect(service.validateNewWorkspaceId("good.id-1")).toEqual({ ok: true });
      expect(service.validateNewWorkspaceId("bad id").ok).toBe(false);
      expect(service.validateNewWorkspaceId("x".repeat(65)).ok).toBe(false);

      await service.add({ root, id: "ident-ws" });
      expect(service.validateNewWorkspaceId("ident-ws")).toEqual({
        ok: false,
        reason: expect.stringContaining("already in use"),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("keeps workspace_id and root immutable across rename/enable/disable", async () => {
    const root = newWorkspace("immutable");
    const configPath = newConfigFile();
    try {
      const service = new WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
      const added = await service.add({ root, id: "immutable-ws", name: "original" });

      await service.rename("immutable-ws", "renamed");
      await service.disable("immutable-ws");
      await service.enable("immutable-ws");

      const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(persisted.workspaces).toHaveLength(1);
      const entry = persisted.workspaces[0];
      expect(entry.workspace_id).toBe(added.workspace_id);
      expect(entry.root).toBe(added.root);
      expect(entry.name).toBe("renamed");
      expect(entry.enabled).toBe(true);

      // Mutations of unknown identities fail without writing.
      await expect(service.rename("ghost", "nope")).rejects.toThrow(/No authorized workspace/);
      await expect(service.enable("ghost")).rejects.toThrow(/No authorized workspace/);
      await expect(service.disable("ghost")).rejects.toThrow(/No authorized workspace/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("rejects an invalid rename without persisting anything", async () => {
    const root = newWorkspace("rename-invalid");
    const configPath = newConfigFile();
    try {
      const service = new WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
      await service.add({ root, id: "rename-invalid-ws" });
      const before = fs.readFileSync(configPath, "utf8");

      await expect(service.rename("rename-invalid-ws", "")).rejects.toThrow(ConfigError);
      await expect(service.rename("rename-invalid-ws", "x".repeat(101))).rejects.toThrow(ConfigError);
      expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

describe("CFG unit — no unlocked product mutation path", () => {
  it("keeps the whole-config replacement out of the service surface", () => {
    const service = new WorkspaceAdminService({ configStore: new ConfigStore("/tmp/unused.json") });
    const prototype = Object.getPrototypeOf(service) as Record<string, unknown>;
    const methods = Object.getOwnPropertyNames(prototype);
    // Intent-level operations only: no save/replace/import-style capability.
    for (const forbidden of ["save", "replace", "import", "load"]) {
      expect(methods).not.toContain(forbidden);
    }
    expect(methods).toEqual(
      expect.arrayContaining(["list", "add", "rename", "enable", "disable", "remove", "validateRoot"]),
    );
  });
});

import fs from "node:fs";
import path from "node:path";
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

  it("recovers a stale lock within a bounded age and never a fresh one", () => {
    const configPath = newConfigFile();
    try {
      const holder = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 50 });
      // Fresh lock: not recoverable.
      expect(() => acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 50 })).toThrow(
        ConfigLockBusyError,
      );
      // Backdate beyond the stale window: bounded recovery takes over.
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(configLockPath(configPath), past, past);
      const stolen = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 50 });
      stolen.release();
      holder.release();
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("keeps successor ownership when a stale holder resumes after a takeover", () => {
    const configPath = newConfigFile();
    try {
      // Holder A acquires, then goes away for longer than the stale window.
      const holderA = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 50 });
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(configLockPath(configPath), past, past);
      // B recovers the abandoned lock and is now the rightful owner.
      const holderB = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 50 });

      // A resumes and releases: it must NOT delete B's lock.
      holderA.release();
      expect(fs.existsSync(configLockPath(configPath))).toBe(true);

      // While B still owns the lock, C must not acquire it.
      expect(() => acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 })).toThrow(
        ConfigLockBusyError,
      );

      // After B releases normally, C acquires cleanly.
      holderB.release();
      const holderC = acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      holderC.release();
      expect(fs.existsSync(configLockPath(configPath))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

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

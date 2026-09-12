import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../../../src/config/config-schema.js";
import { ConfigStore } from "../../../src/config/config-store.js";
import { makeTempRoot } from "../../helpers/fixtures.js";
import { makePlainWorkspace } from "../helpers/mcp.js";
import { CHILD_EXIT_MODULE_MISSING, releaseChildren, spawnMutationChild } from "../helpers/spawn-mutation.js";
import { importExpected } from "../helpers/expected-module.js";

/**
 * L1 — Configuration mutation contracts: CFG-001..005
 * (`docs/v0.3-test-contract.md` §5).
 *
 * CFG-001..004 bind the locked read-modify-write mutation layer (Slice 1:
 * `config-lock.ts` + `WorkspaceAdminService.mutate()`); they are RED until
 * those modules exist. CFG-005 (malformed config fails closed) is already
 * proven by the existing v0.2 `ConfigStore` load path and stays GREEN.
 */

function newConfigFile(): string {
  const dir = makeTempRoot("wl-v03-cfg-config-");
  return path.join(dir, "config.json");
}

describe("CFG — safe concurrent configuration mutation", () => {
  it("CFG-001 survives two independent processes mutating concurrently without lost update", async () => {
    // RED gate first: the locked application mutation layer does not exist yet.
    await importExpected("workspaceAdminService");
    const configPath = newConfigFile();
    const gateDir = makeTempRoot("wl-v03-cfg-gate-");
    const workspaceA = makePlainWorkspace("cfg001a");
    const workspaceB = makePlainWorkspace("cfg001b");
    try {
      // Two genuinely independent processes, synchronized to overlap.
      const childA = spawnMutationChild(configPath, { tag: "proc-a", root: workspaceA.root, id: "cfg001-a" }, gateDir);
      const childB = spawnMutationChild(configPath, { tag: "proc-b", root: workspaceB.root, id: "cfg001-b" }, gateDir);
      await releaseChildren([childA, childB]);
      const [exitA, exitB] = await Promise.all([childA.exitCode, childB.exitCode]);

      // RED: the v0.3 application service is not built yet.
      if (exitA === CHILD_EXIT_MODULE_MISSING || exitB === CHILD_EXIT_MODULE_MISSING) {
        await importExpected("workspaceAdminService");
        // If the module existed but children still reported missing, fail loudly.
        throw new Error("Child reported missing module but importExpected passed");
      }
      expect(exitA).toBe(0);
      expect(exitB).toBe(0);

      // Final valid config contains both accepted mutations exactly once.
      const config = new ConfigStore(configPath).load();
      const ids = config.workspaces.map((ws) => ws.workspace_id);
      expect(ids).toContain("cfg001-a");
      expect(ids).toContain("cfg001-b");
      expect(ids.filter((id) => id === "cfg001-a")).toHaveLength(1);
      expect(ids.filter((id) => id === "cfg001-b")).toHaveLength(1);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
      fs.rmSync(workspaceA.root, { recursive: true, force: true });
      fs.rmSync(workspaceB.root, { recursive: true, force: true });
    }
  });

  it("CFG-002 never exposes partial JSON to readers during concurrent writes", async () => {
    // RED gate first: the locked application mutation layer does not exist yet.
    await importExpected("workspaceAdminService");
    const configPath = newConfigFile();
    const gateDir = makeTempRoot("wl-v03-cfg-gate2-");
    const workspaceA = makePlainWorkspace("cfg002a");
    const workspaceB = makePlainWorkspace("cfg002b");
    try {
      // Writer processes run against the real mutation layer while an
      // independent reader loop re-loads the config file.
      const childA = spawnMutationChild(configPath, { tag: "w-a", root: workspaceA.root, id: "cfg002-a" }, gateDir);
      const childB = spawnMutationChild(configPath, { tag: "w-b", root: workspaceB.root, id: "cfg002-b" }, gateDir);
      const readerScript = path.join(gateDir, "reader.mjs");
      const readerOut = path.join(gateDir, "reader.out");
      fs.writeFileSync(
        readerScript,
        `
import fs from "node:fs";
const configPath = ${JSON.stringify(configPath)};
const outFile = ${JSON.stringify(readerOut)};
const deadline = Date.now() + 15000;
let reads = 0; let parseFailures = 0;
while (Date.now() < deadline && reads < 5000) {
  try {
    if (fs.existsSync(configPath)) {
      JSON.parse(fs.readFileSync(configPath, "utf8"));
      reads += 1;
    }
  } catch {
    parseFailures += 1;
  }
}
fs.writeFileSync(outFile, JSON.stringify({ reads, parseFailures }));
`,
      );
      const reader = spawn(process.execPath, [readerScript], { stdio: "ignore" });

      await releaseChildren([childA, childB]);
      const [exitA, exitB] = await Promise.all([childA.exitCode, childB.exitCode]);
      if (exitA === CHILD_EXIT_MODULE_MISSING || exitB === CHILD_EXIT_MODULE_MISSING) {
        reader.kill();
        await importExpected("workspaceAdminService");
        throw new Error("Child reported missing module but importExpected passed");
      }
      expect(exitA).toBe(0);
      expect(exitB).toBe(0);
      await new Promise<void>((resolve, reject) => {
        reader.on("exit", (code: number | null) => (code === 0 ? resolve() : reject(new Error(`reader exit ${code}`))));
      });
      const readerResult = JSON.parse(fs.readFileSync(readerOut, "utf8")) as {
        reads: number;
        parseFailures: number;
      };
      // Readers always observed a previous or next complete config.
      expect(readerResult.parseFailures).toBe(0);
      expect(readerResult.reads).toBeGreaterThan(0);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
      fs.rmSync(workspaceA.root, { recursive: true, force: true });
      fs.rmSync(workspaceB.root, { recursive: true, force: true });
    }
  });

  it("CFG-003 fails explicitly when the lock cannot be acquired; never writes unlocked", async () => {
    const configPath = newConfigFile();
    const lock = await importExpected("configLock");
    const workspace = makePlainWorkspace("cfg003");
    try {
      // Force lock contention: another holder owns the lock with a long TTL.
      const holder = await lock.acquireConfigLock(configPath, { timeoutMs: 0, staleMs: 60000 });
      try {
        const service = (await importExpected("workspaceAdminService")).WorkspaceAdminService;
        const mutation = new service({ configStore: new ConfigStore(configPath) }).add({
          root: workspace.root,
          id: "cfg003-ws",
        });
        // The mutation must fail explicitly, not silently continue unlocked.
        await expect(mutation).rejects.toThrow(/lock|busy|timeout/i);
        // And it must not have written anything.
        expect(fs.existsSync(configPath)).toBe(false);
      } finally {
        await holder.release();
      }
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      fs.rmSync(workspace.root, { recursive: true, force: true });
    }
  });

  it("CFG-004 applies mutations to the latest config; a newer change is preserved", async () => {
    // RED gate first: the locked application mutation layer does not exist yet.
    await importExpected("workspaceAdminService");
    const configPath = newConfigFile();
    const gateDir = makeTempRoot("wl-v03-cfg-gate4-");
    const workspaceA = makePlainWorkspace("cfg004a");
    const workspaceB = makePlainWorkspace("cfg004b");
    try {
      // Actor A (child process) reads the config into a stale in-memory view
      // and signals readiness (read completes BEFORE the gate, see
      // spawn-mutation.ts)...
      const childA = spawnMutationChild(configPath, { tag: "stale-a", root: workspaceA.root, id: "cfg004-a" }, gateDir);
      await childA.ready;
      // ...while actor B (this process) completes a newer accepted change.
      const store = new ConfigStore(configPath);
      store.add(workspaceB.root, { id: "cfg004-b" });
      // ...then actor A proceeds. Its mutation must operate on the latest
      // config after lock acquisition, preserving B's change.
      fs.writeFileSync(childA.goFile, "go");
      const exitA = await childA.exitCode;
      if (exitA === CHILD_EXIT_MODULE_MISSING) {
        await importExpected("workspaceAdminService");
        throw new Error("Child reported missing module but importExpected passed");
      }
      expect(exitA).toBe(0);
      const config = store.load();
      const ids = config.workspaces.map((ws) => ws.workspace_id);
      expect(ids).toEqual(expect.arrayContaining(["cfg004-a", "cfg004-b"]));
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
      fs.rmSync(gateDir, { recursive: true, force: true });
      fs.rmSync(workspaceA.root, { recursive: true, force: true });
      fs.rmSync(workspaceB.root, { recursive: true, force: true });
    }
  });

  it("CFG-005 fails closed on a malformed current config (existing v0.2 load path)", () => {
    const configPath = newConfigFile();
    try {
      fs.writeFileSync(configPath, "{ not valid json");
      const store = new ConfigStore(configPath);
      // The load path throws a stable configuration error...
      expect(() => store.load()).toThrow(ConfigError);
      // ...so no registry (and therefore no authorization snapshot) can be
      // constructed from the malformed file, and nothing is written back.
      expect(() => new ConfigStore(configPath).load()).toThrow(ConfigError);
      expect(fs.readFileSync(configPath, "utf8")).toBe("{ not valid json");
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";
import { assertNoRealUserState, createIsolatedProductEnv, isolatedProductOptions } from "../helpers/isolated-env.js";

/**
 * Secret, Startup, and Folder Picker Adapter Contracts
 * (`docs/v0.3-test-contract.md` §11): SECRET-001..002, AUTO-001..003,
 * PICK-001..004. All RED until Slices 10/16/17 exist.
 */

const SENTINEL = "SECRET_AUTO_SENTINEL_pl48xw";

describe("SECRET — secret store contracts", () => {
  it("SECRET-001 stores the credential outside ordinary config and control state", async () => {
    // Full credential setup through the real product path (Control API) in
    // an isolated product environment, then inspect EVERY artifact the
    // product persisted — not files the test invented.
    const { createControlRuntime } = await importExpected("controlServer");
    const env = createIsolatedProductEnv("secret001");
    let runtime: any;
    try {
      runtime = await createControlRuntime({
        ...isolatedProductOptions(env),
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
      });
      const { establishSession, apiRequest } = await import("../helpers/control-api.js");
      const session = await establishSession(runtime.baseUrl);
      const setup = await apiRequest(
        runtime.baseUrl,
        "/api/v1/credentials",
        { runtimeApiKey: SENTINEL },
        { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl },
      );
      expect([200, 201]).toContain(setup.status);
      const setupBody = JSON.stringify(await setup.json());
      expect(setupBody).not.toContain(SENTINEL);

      // The isolated state root is the product's real persistence location
      // for this run: no artifact inside it may contain the literal secret.
      assertNoRealUserState(env);
      const persisted = env.listStateRootFiles();
      expect(persisted.length).toBeGreaterThan(0);
      for (const relative of persisted) {
        expect(env.readStateFile(relative) ?? "").not.toContain(SENTINEL);
      }
    } finally {
      await runtime?.stop?.().catch(() => {});
      env.cleanup();
    }
  });

  it("SECRET-002 reports an unavailable store as action-required without plaintext fallback", async () => {
    const { SecretStore } = await importExpected("secretStore");
    // Deterministically unavailable platform seam; never the host keychain.
    const failingPlatform = {
      available: async () => false,
      get: async () => {
        throw new Error("credential store unavailable");
      },
      set: async () => {
        throw new Error("credential store unavailable");
      },
      delete: async () => {
        throw new Error("credential store unavailable");
      },
    };
    const store = new SecretStore({
      namespace: "workspace-lens-v0.3-secret002",
      platform: failingPlatform,
    });
    const available = await store.available();
    expect(available).toBe(false);
    // The operation must fail rather than create a plaintext fallback file.
    await expect(store.set("runtime-key", SENTINEL)).rejects.toThrow();
    expect(await store.get("runtime-key")).toBeUndefined();
  });
});

describe("AUTO — login startup contracts", () => {
  it("AUTO-001 generates a startup definition with fixed command and no secret", async () => {
    const { StartupManager } = await importExpected("startupManager");
    const manager = new StartupManager({ platformAdapter: "test" });
    const definition = await manager.buildDefinition({
      executable: "/usr/local/bin/workspace-lens",
      args: ["start"],
    });
    const serialized = JSON.stringify(definition);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toMatch(/runtime-api-key|api[-_]?key/i);
    expect(definition.args).toEqual(["start"]);
  });

  it("AUTO-002 enables/disables idempotently without duplicate entries", async () => {
    const { StartupManager } = await importExpected("startupManager");
    const manager = new StartupManager({ platformAdapter: "test" });
    await manager.enable({ executable: "/usr/local/bin/workspace-lens", args: ["start"] });
    await manager.enable({ executable: "/usr/local/bin/workspace-lens", args: ["start"] });
    const afterDoubleEnable = await manager.status();
    expect(afterDoubleEnable.entries.filter((entry: any) => entry.id === afterDoubleEnable.desiredId)).toHaveLength(1);
    await manager.disable();
    await manager.disable();
    const afterDoubleDisable = await manager.status();
    expect(afterDoubleDisable.enabled).toBe(false);
  });

  it("AUTO-003 keeps the Control Runtime startable when startup prerequisites are missing", async () => {
    const { StartupManager } = await importExpected("startupManager");
    const manager = new StartupManager({ platformAdapter: "test", simulateMissingCredential: true });
    const reconciliation = await manager.reconcileStartup({});
    // Startup reconciliation surfaces actionable status rather than exiting
    // the product; the Control Runtime itself is unaffected.
    expect(reconciliation).toMatchObject({
      state: expect.stringMatching(/action-required|problem|degraded/),
      runtimeCanStart: true,
    });
  });
});

describe("PICK — folder picker adapter contracts", () => {
  it("PICK-001 validates any picker-returned path through the same authorization rules", async () => {
    const { FolderPicker } = await importExpected("folderPicker");
    const picker = new FolderPicker({ platformAdapter: "test" });
    // A selected path must pass the same canonicalization/authorization
    // checks as CLI paths: non-existent paths are rejected server-side.
    await expect(
      picker.authorizeSelectedDirectory("/nonexistent/wl-pick-001"),
    ).rejects.toThrow();
  });

  it("PICK-002 treats picker cancellation as a no-op", async () => {
    const { FolderPicker } = await importExpected("folderPicker");
    const picker = new FolderPicker({ platformAdapter: "test" });
    const result = await picker.pickDirectory({ simulate: "cancel" });
    expect(result).toMatchObject({ canceled: true });
    expect(result).not.toHaveProperty("directory");
  });

  it("PICK-003 authorizes a valid manually supplied path when the picker is unavailable", async () => {
    const { FolderPicker } = await importExpected("folderPicker");
    const picker = new FolderPicker({ platformAdapter: "none" });
    const result = await picker.pickDirectory({ simulate: "unavailable" });
    expect(result).toMatchObject({ available: false });
    // Manual path fallback remains: the caller is expected to authorize a
    // valid directory through the shared WorkspaceAdminService; the picker
    // absence must not remove that path.
    expect(result.fallback).toBe("manual-path");
  });

  it("PICK-004 introduces no general filesystem browser API", async () => {
    const mod = await importExpected("folderPicker");
    // The picker surface is narrow: only the fixed selection operation and
    // its validation exist. No enumeration/browse/preview capability.
    const exportedNames = Object.keys(mod).sort();
    expect(exportedNames).toEqual(
      expect.arrayContaining(["FolderPicker"]),
    );
    const picker = new mod.FolderPicker({ platformAdapter: "test" });
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(picker)).sort();
    const forbidden = surface.filter((name) => /list|browse|enumerate|read|preview|walk/i.test(name));
    expect(forbidden).toEqual([]);
  });
});

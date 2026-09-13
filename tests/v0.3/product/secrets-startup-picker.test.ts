import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";
import { assertNoRealUserState, createIsolatedProductEnv, isolatedProductOptions } from "../helpers/isolated-env.js";

/**
 * Secret, Startup, and Folder Picker Adapter Contracts
 * (`docs/v0.3-test-contract.md` §11): SECRET-001..002, AUTO-001..003,
 * PICK-001..004. All RED until Slices 10/16/17 exist.
 *
 * Platform integrations are injected as adapter OBJECTS from the tests.
 * Production code must not grow magic "test"/"none" mode strings or
 * simulation-only APIs merely to satisfy these contracts.
 */

const SENTINEL = "SECRET_AUTO_SENTINEL_pl48xw";

describe("SECRET — secret store contracts", () => {
  it("SECRET-001 stores the credential outside ordinary config and control state", async () => {
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
    await expect(store.set("runtime-key", SENTINEL)).rejects.toThrow();
    expect(await store.get("runtime-key")).toBeUndefined();
  });
});

describe("AUTO — login startup contracts", () => {
  it("AUTO-001 generates a startup definition with fixed command and no secret", async () => {
    const { StartupManager } = await importExpected("startupManager");
    const { inMemoryStartupAdapter } = await import("../helpers/test-adapters.js");
    const manager = new StartupManager({ adapter: inMemoryStartupAdapter() });
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
    const { inMemoryStartupAdapter } = await import("../helpers/test-adapters.js");
    const manager = new StartupManager({ adapter: inMemoryStartupAdapter() });
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
    const { inMemoryStartupAdapter, unavailableSecretAdapter, stubTunnelAdapter } = await import(
      "../helpers/test-adapters.js"
    );
    const manager = new StartupManager({ adapter: inMemoryStartupAdapter() });
    const reconciliation = await manager.reconcileStartup({
      secretAdapter: unavailableSecretAdapter(),
      tunnelAdapter: stubTunnelAdapter("stopped"),
    });
    expect(reconciliation).toMatchObject({
      state: expect.stringMatching(/action-required|problem|degraded/),
      runtimeCanStart: true,
    });
  });
});

type PickerResult = {
  available: boolean;
  canceled: boolean;
  directory?: string;
};

function pickerAdapter(result: PickerResult) {
  return {
    pickDirectory: async (): Promise<PickerResult> => ({ ...result }),
  };
}

describe("PICK — folder picker adapter contracts", () => {
  it("PICK-001 revalidates any picker-returned path through shared workspace authorization rules", async () => {
    const { FolderPicker } = await importExpected("folderPicker");
    const { WorkspaceAdminService } = await importExpected("workspaceAdminService");
    const { ConfigStore } = await import("../../../src/config/config-store.js");
    const { makeTempRoot } = await import("../../helpers/fixtures.js");
    const fs = await import("node:fs");
    const path = await import("node:path");

    const invalidPath = "/nonexistent/wl-pick-001";
    const picker = new FolderPicker({
      adapter: pickerAdapter({ available: true, canceled: false, directory: invalidPath }),
    });
    const selected = await picker.pickDirectory();
    expect(selected).toMatchObject({ available: true, canceled: false, directory: invalidPath });

    // The picker only selects a path. Authorization remains the shared
    // application service's responsibility, so picker output cannot bypass
    // canonicalization/existence/security rules.
    const configDir = makeTempRoot("wl-v03-picker-auth-");
    try {
      const service = new WorkspaceAdminService({
        configStore: new ConfigStore(path.join(configDir, "config.json")),
      });
      await expect(service.add({ root: selected.directory })).rejects.toThrow();
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("PICK-002 treats picker cancellation as a no-op", async () => {
    const { FolderPicker } = await importExpected("folderPicker");
    const picker = new FolderPicker({
      adapter: pickerAdapter({ available: true, canceled: true }),
    });
    const result = await picker.pickDirectory();
    expect(result).toMatchObject({ available: true, canceled: true });
    expect(result).not.toHaveProperty("directory");
  });

  it("PICK-003 reports picker unavailability while preserving manual path fallback", async () => {
    const { FolderPicker } = await importExpected("folderPicker");
    const picker = new FolderPicker({
      adapter: pickerAdapter({ available: false, canceled: false }),
    });
    const result = await picker.pickDirectory();
    expect(result).toMatchObject({ available: false });
    expect(result).not.toHaveProperty("directory");

    // Manual path entry is a separate product path handled by the shared
    // workspace authorization service; picker unavailability must not become
    // a requirement for a production "none"/simulation mode.
  });

  it("PICK-004 introduces no general filesystem browser API", async () => {
    const mod = await importExpected("folderPicker");
    const exportedNames = Object.keys(mod).sort();
    expect(exportedNames).toEqual(expect.arrayContaining(["FolderPicker"]));
    const picker = new mod.FolderPicker({
      adapter: pickerAdapter({ available: false, canceled: false }),
    });
    const surface = Object.getOwnPropertyNames(Object.getPrototypeOf(picker)).sort();
    const forbidden = surface.filter((name) => /list|browse|enumerate|read|preview|walk/i.test(name));
    expect(forbidden).toEqual([]);
  });
});

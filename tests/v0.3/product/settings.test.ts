import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ControlStateStore } from "../../../src/config/control-state-store.js";
import { makeTempRoot } from "../../helpers/fixtures.js";
import {
  assertNoRealUserState,
  createIsolatedProductEnv,
  type IsolatedProductEnv,
} from "../helpers/isolated-env.js";
import { spawnProductChild, type ProductChild } from "../helpers/spawn-product-child.js";
import { establishSession, apiRequest } from "../helpers/control-api.js";

/**
 * Slice 9 — Control state / settings (`docs/v0.3-implementation-plan.md` §12).
 *
 * Non-secret product state lives in its own versioned document, strictly
 * separated from the workspace authorization config. Evidence: versioned
 * schema failure is bounded, unknown/secret-shaped fields are rejected by
 * the strict schema, writes are atomic with restrictive permissions, GET
 * never mutates (even with mutation-shaped query parameters), and the
 * machine-derived connection state is never persisted as truth.
 */

function newStore(dir: string): ControlStateStore {
  return new ControlStateStore(path.join(dir, "control-state.json"));
}

async function withRuntime(
  tag: string,
  run: (child: any, env: IsolatedProductEnv) => Promise<void>,
): Promise<void> {
  const env = createIsolatedProductEnv(tag);
  let child: any;
  try {
    assertNoRealUserState(env);
    child = await spawnProductChild(env, { entry: "control" });
    await run(child, env);
  } finally {
    await child?.stop();
    env.cleanup();
  }
}

describe("CONTROL STATE — store", () => {
  it("defaults cleanly, persists atomically, and keeps restrictive permissions", () => {
    const dir = makeTempRoot("wl-v03-ctlstate-");
    try {
      const store = newStore(dir);
      const document = store.load();
      expect(document).toMatchObject({
        version: 1,
        preferences: {
          startAtLogin: false,
          autoConnect: false,
          providerSetupUserConfirmed: false,
          verificationUserConfirmed: false,
        },
      });

      document.preferences.startAtLogin = true;
      document.preferences.providerSetupUserConfirmed = true;
      document.preferences.verificationUserConfirmed = true;
      store.save(document);

      // Restrictive permissions, no temp leftovers.
      const filePath = store.filePath;
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir)).toEqual(["control-state.json"]);

      // Round trip.
      const reloaded = new ControlStateStore(filePath).load();
      expect(reloaded.preferences.startAtLogin).toBe(true);
      expect(reloaded.preferences.providerSetupUserConfirmed).toBe(true);
      expect(reloaded.preferences.verificationUserConfirmed).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed on an unsupported version or a corrupt document", () => {
    const dir = makeTempRoot("wl-v03-ctlstate-bad-");
    try {
      const filePath = path.join(dir, "control-state.json");
      fs.writeFileSync(filePath, JSON.stringify({ version: 99, preferences: {} }), { mode: 0o600 });
      expect(() => newStore(dir).load()).toThrow(/version|malformed/i);

      fs.writeFileSync(filePath, "{ not json", { mode: 0o600 });
      expect(() => newStore(dir).load()).toThrow(/JSON|malformed/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects unknown and secret-shaped fields through the strict schema", () => {
    const dir = makeTempRoot("wl-v03-ctlstate-secret-");
    try {
      const filePath = path.join(dir, "control-state.json");
      const store = newStore(dir);
      // Unknown fields cannot be persisted.
      expect(() =>
        store.save({
          version: 1,
          preferences: { startAtLogin: false, autoConnect: false },
          runtimeApiKey: "should-never-persist",
        } as never),
      ).toThrow();
      // And a hand-written document carrying a secret-shaped field fails
      // closed on load instead of being served.
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          version: 1,
          preferences: { startAtLogin: false, autoConnect: false },
          openaiApiKey: "sentinel-secret",
        }),
        { mode: 0o600 },
      );
      expect(() => store.load()).toThrow(/malformed|version/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CONTROL STATE — settings API", () => {
  it("reads and patches non-secret settings over the privileged API", async () => {
    await withRuntime("ctlsettings", async (child: ProductChild, env: IsolatedProductEnv) => {
      const session = await establishSession(child.url);
      const origin = child.url;

      const before = await fetch(`${child.url}/api/v1/settings`, { headers: { cookie: session.cookie } });
      expect(before.status).toBe(200);
      expect((await before.json()) as any).toMatchObject({
        startAtLogin: false,
        autoConnect: false,
        providerSetupUserConfirmed: false,
        verificationUserConfirmed: false,
      });

      const patched = await apiRequest(
        child.url,
        "/api/v1/settings",
        {
          startAtLogin: true,
          providerSetupUserConfirmed: true,
          verificationUserConfirmed: true,
        },
        { cookie: session.cookie, csrf: session.csrf, origin },
        "PATCH",
      );
      expect(patched.status).toBe(200);
      expect((await patched.json()) as any).toMatchObject({
        startAtLogin: true,
        providerSetupUserConfirmed: true,
        verificationUserConfirmed: true,
      });

      // Desired state persisted to the control state document (0600).
      const persisted = JSON.parse(
        fs.readFileSync(env.controlStatePath, "utf8"),
      ) as any;
      expect(persisted.preferences.startAtLogin).toBe(true);
      expect(persisted.preferences.providerSetupUserConfirmed).toBe(true);
      expect(persisted.preferences.verificationUserConfirmed).toBe(true);
      expect(fs.statSync(env.controlStatePath).mode & 0o777).toBe(0o600);

      // Unknown/secret-shaped fields are rejected with no partial mutation.
      const rejected = await apiRequest(
        child.url,
        "/api/v1/settings",
        { runtimeApiKey: "sentinel-never-persist" },
        { cookie: session.cookie, csrf: session.csrf, origin },
        "PATCH",
      );
      expect(rejected.status).toBe(400);
      expect(fs.readFileSync(env.controlStatePath, "utf8")).not.toContain("sentinel-never-persist");
    });
  });

  it("never mutates through GET, even with mutation-shaped query parameters", async () => {
    await withRuntime("ctlsettings-get", async (child, env) => {
      const session = await establishSession(child.url);
      const rejected = await fetch(`${child.url}/api/v1/settings?startAtLogin=true`, {
        headers: { cookie: session.cookie },
      });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      // State unchanged: the rejected GET never created or mutated the
      // control state document.
      expect(fs.existsSync(env.controlStatePath)).toBe(false);
    });
  });

  it("keeps machine-derived connection state out of persisted control state", async () => {
    await withRuntime("ctlsettings-machine", async (child, env) => {
      const session = await establishSession(child.url);
      // Observe the connection (machine-derived health) ...
      await fetch(`${child.url}/api/v1/connection`, { headers: { cookie: session.cookie } });
      // ... nothing connection-shaped was persisted as authoritative truth.
      const stateFiles = env.listStateRootFiles().filter((file) => file.endsWith("control-state.json"));
      for (const file of stateFiles) {
        const content = env.readStateFile(file) ?? "";
        expect(content).not.toContain('"state"');
        expect(content).not.toContain("healthy");
      }
    });
  });
});

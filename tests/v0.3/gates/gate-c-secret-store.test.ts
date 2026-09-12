import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MissingCapabilityError, importExpected, isModuleImplemented } from "../helpers/expected-module.js";

/**
 * GATE-C — SecretStore feasibility on Node 24
 * (`docs/v0.3-test-contract.md` §7; `docs/v0.3-implementation-plan.md` §3 Gate C).
 *
 * Question: can v0.3 store/retrieve the runtime credential through an
 * OS-backed secret store without plaintext fallback and without making
 * installation impractical?
 *
 * GATE-C-1 is BLOCKED in this phase: no candidate OS-credential dependency
 * has been accepted yet, and adding a native dependency (e.g. @github/keytar
 * or an alternative OS-backed adapter) requires the Gate C dependency review
 * before the harness may exercise it. The gate test records that evidence and
 * — once `src/integrations/secrets/secret-store.ts` exists (Slice 10) — runs
 * REAL feasibility assertions (declared dependency on Node 24, adapter
 * importable and instantiable) instead of auto-passing.
 *
 * GATE-C-2/3 are executable interface contracts: set/get/delete in an
 * isolated namespace without printing the secret, and a deterministically
 * injected unavailable-store platform (no reliance on the host OS state)
 * proving action-required behavior with no plaintext fallback.
 */

const GATE_C_BLOCKED_EVIDENCE =
  "GATE-C-1 BLOCKED: candidate secret-store dependency not yet selected. " +
  "Evidence: package.json dependencies/devDependencies contain no OS credential-store " +
  "library, and no SecretStore adapter module exists (Slice 10 not started). " +
  "Node 24 is the required engine (package.json engines.node >=24 <25). " +
  "Suggested options: (a) evaluate @github/keytar or an OS-backed alternative behind " +
  "the SecretStore interface after dependency review, then re-run this gate; " +
  "(b) narrow initial OS support explicitly. Plaintext automatic fallback remains forbidden.";

function assertNode24Engine(): void {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "../../../package.json"), "utf8"),
  ) as { engines?: { node?: string } };
  expect(pkg.engines?.node).toBe(">=24 <25");
  const [major] = process.versions.node.split(".").map((part) => Number.parseInt(part, 10));
  expect(major).toBe(24);
}

describe("GATE-C SecretStore feasibility on Node 24", () => {
  it("GATE-C-1 verifies candidate feasibility once a store adapter exists; records BLOCKED evidence before", async () => {
    if (!isModuleImplemented("secretStore")) {
      // BLOCKED with evidence — the gate fails until the dependency decision
      // is made and Slice 10 lands; it never silently passes.
      expect(GATE_C_BLOCKED_EVIDENCE).toContain("BLOCKED");
      expect(GATE_C_BLOCKED_EVIDENCE).toContain("no OS credential-store");
      throw new MissingCapabilityError(GATE_C_BLOCKED_EVIDENCE);
    }
    // Feasibility assertions that only run against the real adapter.
    assertNode24Engine();
    const pkg = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
    };
    // An OS-backed store implementation must be concretely declared: a bare
    // in-memory Map SecretStore with no OS credential dependency cannot pass
    // this gate. The allowlist holds the candidates named by the
    // implementation plan's Gate C; a different OS-backed selection requires
    // an owner decision and updating this allowlist.
    const dependencyNames = Object.keys(pkg.dependencies ?? {});
    const osStoreDependencies = dependencyNames.filter((name) =>
      /^(keytar|@github\/keytar)$/.test(name),
    );
    expect(osStoreDependencies).toEqual([expect.any(String)]);
    const mod = await importExpected("secretStore");
    const store = new mod.SecretStore({ namespace: "workspace-lens-v0.3-gate-c-feasibility" });
    // Instantiation and availability probing must not throw on Node 24; the
    // REAL set/get/delete feasibility round trip is GATE-C-2.
    await expect(store.available()).resolves.toEqual(expect.any(Boolean));
  });

  it("GATE-C-2 performs set/get/delete in an isolated test key without printing the secret", async () => {
    const { SecretStore } = await importExpected("secretStore");
    const store = new SecretStore({ namespace: "workspace-lens-v0.3-gate-c-test" });
    expect(await store.available()).toBe(true);
    const secretName = "workspace-lens-test-runtime-key";
    const secretValue = `GATE_C_SENTINEL_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    try {
      await store.set(secretName, secretValue);
      const retrieved = await store.get(secretName);
      // Compare equality without ever emitting the value.
      expect(retrieved).toBe(secretValue);
      await store.delete(secretName);
      expect(await store.get(secretName)).toBeUndefined();
    } finally {
      await store.delete(secretName).catch(() => {});
    }
  });

  it("GATE-C-3 reports a deterministically unavailable store as action-required, never plaintext fallback", async () => {
    const { SecretStore } = await importExpected("secretStore");
    // The unavailable platform is injected deterministically — the contract
    // must not depend on whether the host OS happens to have a keychain.
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
      namespace: "workspace-lens-v0.3-gate-c-unavailable",
      platform: failingPlatform,
    });
    expect(await store.available()).toBe(false);
    // Setting a secret must fail explicitly rather than silently storing
    // plaintext anywhere.
    await expect(
      store.set("workspace-lens-unavailable-probe", "GATE_C_SENTINEL_SHOULD_NOT_PERSIST"),
    ).rejects.toThrow();
    expect(await store.get("workspace-lens-unavailable-probe")).toBeUndefined();
  });
});

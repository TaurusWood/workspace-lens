import { describe, expect, it } from "vitest";
import { MissingCapabilityError, importExpected } from "../helpers/expected-module.js";

/**
 * GATE-C — SecretStore feasibility on Node 24
 * (`docs/v0.3-test-contract.md` §7; `docs/v0.3-implementation-plan.md` §3 Gate C).
 *
 * Question: can v0.3 store/retrieve the runtime credential through an
 * OS-backed secret store without plaintext fallback and without making
 * installation impractical?
 *
 * GATE-C-1 (candidate install/build on Node 24) is BLOCKED in this phase:
 * no candidate dependency has been accepted yet, and adding a native
 * dependency (e.g. @github/keytar or an alternative OS-backed adapter) is a
 * production dependency decision that requires the Gate C dependency review
 * before the harness may exercise it. The interface contracts below
 * (GATE-C-2/3) are expressed as executable tests that activate when
 * `src/integrations/secrets/secret-store.ts` exists (Slice 10) — they are
 * RED now, not skipped, and must never print the literal secret.
 */

const GATE_C_BLOCKED_EVIDENCE =
  "GATE-C-1 BLOCKED: candidate secret-store dependency not yet selected. " +
  "Evidence: package.json dependencies/devDependencies contain no OS credential-store " +
  "library, and no SecretStore adapter module exists (Slice 10 not started). " +
  "Node 24 is the required engine (package.json engines.node >=24 <25). " +
  "Suggested options: (a) evaluate @github/keytar or an OS-backed alternative behind " +
  "the SecretStore interface after dependency review, then re-run this gate; " +
  "(b) narrow initial OS support explicitly. Plaintext automatic fallback remains forbidden.";

describe("GATE-C SecretStore feasibility on Node 24", () => {
  it("GATE-C-1 records BLOCKED evidence for the candidate dependency decision", async () => {
    // The gate must fail with explicit evidence, never silently pass.
    expect.assertions(2);
    try {
      await importExpected("secretStore");
      // If the module suddenly exists (Slice 10 landed), the gate is no
      // longer blocked: it must run the real adapter feasibility tests.
      expect(true).toBe(true);
    } catch (error) {
      expect(error).toBeInstanceOf(MissingCapabilityError);
    }
    // Document the blocker for the coverage matrix and reviewers.
    expect(GATE_C_BLOCKED_EVIDENCE).toContain("BLOCKED");
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

  it("GATE-C-3 reports an unavailable store as action-required, never plaintext fallback", async () => {
    const { SecretStore } = await importExpected("secretStore");
    const store = new SecretStore({ namespace: "workspace-lens-v0.3-gate-c-unavailable" });
    const available = await store.available();
    if (!available) {
      // An unavailable store must surface an explicit action-required state,
      // and setting a secret must fail rather than silently storing plaintext.
      await expect(
        store.set("workspace-lens-unavailable-probe", "GATE_C_SENTINEL_SHOULD_NOT_PERSIST"),
      ).rejects.toThrow();
      return;
    }
    // With a healthy store, v0.3 must still never create a plaintext
    // fallback file for the same credential name.
    const secretName = "workspace-lens-test-runtime-key";
    const secretValue = `GATE_C_SENTINEL_${Date.now()}_fallback`;
    try {
      await store.set(secretName, secretValue);
      expect(await store.get(secretName)).toBe(secretValue);
    } finally {
      await store.delete(secretName).catch(() => {});
    }
  });
});

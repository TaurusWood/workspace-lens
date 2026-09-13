import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";
import { assertNoRealUserState, createIsolatedProductEnv } from "../helpers/isolated-env.js";
import { readRuntimeIdentity, spawnProductChild, type ProductChild } from "../helpers/spawn-product-child.js";

/**
 * Supplemental false-green guard for START-001 / E2E-003 runtime identity.
 *
 * Those contracts prove that runtime_instance_id stays stable while the SAME
 * Control Runtime remains alive. This test proves the complementary invariant:
 * a genuinely fresh Control Runtime MUST receive a different identity.
 *
 * Without this guard, an implementation could return a constant product id
 * such as "workspace-lens" from /healthz and incorrectly satisfy every
 * no-restart assertion.
 */
describe("Control Runtime identity", () => {
  it("generates a unique runtime_instance_id for distinct runtime instances", async () => {
    await importExpected("controlRuntime");

    const envA = createIsolatedProductEnv("runtime-id-a");
    const envB = createIsolatedProductEnv("runtime-id-b");
    let runtimeA: ProductChild | undefined;
    let runtimeB: ProductChild | undefined;

    try {
      assertNoRealUserState(envA);
      assertNoRealUserState(envB);

      runtimeA = await spawnProductChild(envA, { entry: "control" });
      const idA = await readRuntimeIdentity(runtimeA.url);
      expect(idA.length).toBeGreaterThan(0);

      // Stop the first runtime completely so this is a fresh start rather
      // than a reuse/singleton scenario.
      await runtimeA.stop();
      runtimeA = undefined;

      runtimeB = await spawnProductChild(envB, { entry: "control" });
      const idB = await readRuntimeIdentity(runtimeB.url);
      expect(idB.length).toBeGreaterThan(0);

      expect(idB).not.toBe(idA);
    } finally {
      await runtimeA?.stop().catch(() => {});
      await runtimeB?.stop().catch(() => {});
      envA.cleanup();
      envB.cleanup();
    }
  });
});

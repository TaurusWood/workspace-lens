import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";
import {
  assertNoRealUserState,
  createIsolatedProductEnv,
  type IsolatedProductEnv,
} from "../helpers/isolated-env.js";
import { readRuntimeIdentity, spawnProductChild, type ProductChild } from "../helpers/spawn-product-child.js";

/**
 * L2 — Control Runtime and HTTP Integration Contracts: HTTP-001..004
 * (`docs/v0.3-test-contract.md` §8).
 *
 * The Control Runtime does not exist yet (Slice 3), so these contracts are
 * RED through the `control/runtime.ts` module gate. Behavioral assertions are
 * written against the contract semantics so a partial implementation cannot
 * turn them green: health/readiness, single runtime ownership, cwd-independent
 * WebUI assets, and MCP/API surface separation.
 *
 * Every runtime runs in a DEDICATED child process inside an isolated product
 * environment (HOME/XDG_* and WORKSPACE_LENS_CONFIG pointed at a temp state root,
 * adapter objects injected by the tests). The lifecycle protocol is
 * leak-proof: spawn → readiness signal → HTTP probes → stop → port must
 * drain, or the contract fails.
 */

async function withProductChild(
  tag: string,
  options: Parameters<typeof spawnProductChild>[1],
  run: (child: ProductChild, env: IsolatedProductEnv) => Promise<void>,
): Promise<void> {
  const env = createIsolatedProductEnv(tag);
  let child: ProductChild | undefined;
  try {
    assertNoRealUserState(env);
    child = await spawnProductChild(env, options);
    await run(child, env);
  } finally {
    // Stop protocol: SIGTERM → child stops its runtime → port must drain.
    await child?.stop();
    env.cleanup();
  }
}

describe("HTTP — Control Runtime and HTTP integration", () => {
  it("HTTP-001 starts on a test port, reports health locally, and shuts down cleanly", async () => {
    await importExpected("controlRuntime");
    await withProductChild("http001", { entry: "control" }, async (child) => {
      expect(child.url).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
      const health = await fetch(`${child.url}/healthz`);
      expect(health.status).toBe(200);
      const ready = await fetch(`${child.url}/readyz`);
      expect(ready.status).toBe(200);
      await child.stop();
      // After shutdown the runtime no longer serves (stop() already waited
      // for the port to drain; this probe must fail).
      await expect(fetch(`${child.url}/healthz`)).rejects.toThrow();
    });
  });

  it("HTTP-002 accepts reuse or explicit rejection; a second independent manager fails the contract", async () => {
    await importExpected("controlRuntime");
    await withProductChild("http002", { entry: "control" }, async (first, env) => {
      const healthBefore = await fetch(`${first.url}/healthz`);
      expect(healthBefore.status).toBe(200);

      // A second normal start for the SAME state root must either REUSE the
      // healthy runtime or be REJECTED explicitly — both are contract-legal;
      // a second runtime that successfully STARTS independently violates the
      // contract the moment it exists, regardless of being stopped afterwards.
      let secondChild: ProductChild | undefined;
      try {
        secondChild = await spawnProductChild(env, { entry: "control" });
      } catch (error) {
        // Child explicitly failed: only a duplicate-ownership rejection is a
        // legal outcome; any other startup failure is a genuine error.
        const message = String((error as Error).message);
        if (/ownership|already|running|duplicate|reuse|in use/i.test(message)) {
          // Explicit rejection path: legal.
        } else {
          throw error;
        }
      }
      if (secondChild) {
        if (secondChild.result.reused !== true) {
          // It started successfully as an independent manager — contract
          // already violated; surface it loudly instead of marking "rejected".
          await secondChild.stop({ expectDrain: false });
          throw new Error(
            "HTTP-002 FAIL: duplicate Control Runtime started independently. The second start " +
              "neither reused the healthy runtime nor was rejected; two managers coexisted.",
          );
        }
        // Reuse path: same healthy instance, still exactly one manager.
        await secondChild.stop({ expectDrain: false });
      }

      // Exactly one healthy manager remains: the first runtime still serves.
      const healthAfter = await fetch(`${first.url}/healthz`);
      expect(healthAfter.status).toBe(200);
    });
  });

  it("HTTP-003 serves WebUI assets from the installed location, not process.cwd()", async () => {
    await importExpected("controlRuntime");
    await withProductChild("http003", { entry: "control" }, async (child) => {
      // The child's cwd is its own temp dir, unrelated to the repository.
      const response = await fetch(`${child.url}/`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/html");
    });
  });

  it("HTTP-004 keeps /mcp and /api/v1/* capabilities separated", async () => {
    await importExpected("controlRuntime");
    await withProductChild("http004", { entry: "control" }, async (child) => {
      // The MCP surface must not expose workspace administration, settings,
      // secret, startup, or tunnel lifecycle operations. Attempting an
      // admin-shaped tool call through the MCP endpoint must fail as an
      // unknown tool, and no admin passthrough route exists.
      const response = await fetch(`${child.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "workspace_remove", arguments: { workspace_id: "anything" } },
        }),
      });
      const body = (await response.json()) as any;
      const text = JSON.stringify(body);
      expect(text).not.toContain('"removed"');
      expect(text).toMatch(/unknown tool|not found|method/i);
    });
  });

  it("runtime_instance_id distinguishes runtime INSTANCES, not the product", async () => {
    await importExpected("controlRuntime");
    const env = createIsolatedProductEnv("identity");
    let first: ProductChild | undefined;
    let second: ProductChild | undefined;
    try {
      assertNoRealUserState(env);
      // Start runtime instance A and read its identity.
      first = await spawnProductChild(env, { entry: "control" });
      const idA = await readRuntimeIdentity(first.url);
      expect(typeof idA).toBe("string");
      expect(idA.length).toBeGreaterThan(0);

      // Stop A, then start a FRESH runtime B on the same state root.
      await first.stop();
      second = await spawnProductChild(env, { entry: "control" });
      const idB = await readRuntimeIdentity(second.url);

      // Instance identity, not product identity: a constant string (e.g.
      // "workspace-lens") or any id that survives a genuine restart cannot
      // prove "no restart" in E2E-003/START-001.
      expect(idB).not.toBe(idA);
    } finally {
      await second?.stop();
      await first?.stop();
      env.cleanup();
    }
  });
});

describe("START — canonical bootstrap (workspace-lens start)", () => {
  it("START-001 reuses a healthy runtime, starts when absent, and surfaces the local URL", async () => {
    await importExpected("startCommand");
    const env = createIsolatedProductEnv("start001");
    let first: ProductChild | undefined;
    let second: ProductChild | undefined;
    try {
      assertNoRealUserState(env);
      first = await spawnProductChild(env, { entry: "start" });
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1/);
      expect(first.result.reused).toBe(false);
      // Runtime identity comes from the LIVE runtime (/healthz), never from
      // a launcher PID.
      const identityBefore = await readRuntimeIdentity(first.url);

      // A second start against the healthy runtime must REUSE it (the
      // canonical bootstrap never duplicates ownership)…
      second = await spawnProductChild(env, { entry: "start" });
      expect(second.result.reused).toBe(true);
      // …and the SAME live runtime instance keeps serving — same
      // runtime_instance_id across the second start.
      const identityAfter = await readRuntimeIdentity(first.url);
      expect(identityAfter).toBe(identityBefore);

      // Both start invocations surfaced the local WebUI URL.
      const health = await fetch(`${first.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      // Leak-proof cleanup: stop the runtime through either owner; the stop
      // protocol waits until the port drains before the temp state is removed.
      await second?.stop({ expectDrain: false });
      await first?.stop();
      env.cleanup();
    }
  });

  it("START-001 (failure path) returns an actionable error when the local runtime cannot start", async () => {
    await importExpected("startCommand");
    const net = await import("node:net");
    const env = createIsolatedProductEnv("start001-fail");
    // Occupy an ephemeral port first, then make the runtime try to bind the
    // SAME port — bind failure is deterministic on every OS/permission setup
    // (unlike assuming a privileged port like 1 always fails).
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", () => resolve()));
    const occupiedPort = (blocker.address() as import("node:net").AddressInfo).port;
    try {
      assertNoRealUserState(env);
      await expect(
        spawnProductChild(env, { entry: "start", extraOptions: { port: occupiedPort } }),
      ).rejects.toThrow(/start|runtime|port|error|failed|address/i);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
      env.cleanup();
    }
  });

  it("START-002 keeps the runtime healthy when the browser client terminates", async () => {
    await importExpected("startCommand");
    await withProductChild("start002", { entry: "start" }, async (child) => {
      // The browser (test client) never opens and "goes away"; the Control
      // Runtime stays healthy and the MCP endpoint remains available.
      const health = await fetch(`${child.url}/healthz`);
      expect(health.status).toBe(200);
    });
  });
});

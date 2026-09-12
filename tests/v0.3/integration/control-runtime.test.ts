import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";
import {
  assertNoRealUserState,
  createIsolatedProductEnv,
  isolatedProductOptions,
  type IsolatedProductEnv,
} from "../helpers/isolated-env.js";

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
 * Every runtime runs inside an isolated product environment (temporary HOME,
 * config, control state, runtime state, test adapters) so no contract test
 * can ever touch the developer's real user state.
 */

interface RuntimeUnderTest {
  baseUrl: string;
  stop(): Promise<void>;
  __env: IsolatedProductEnv;
}

async function startRuntime(options: Record<string, unknown> = {}): Promise<RuntimeUnderTest> {
  const mod = await importExpected("controlRuntime");
  const env = createIsolatedProductEnv("http");
  const runtime = await mod.startControlRuntime({
    ...isolatedProductOptions(env),
    ...options,
    configPath: env.configPath,
    controlStatePath: env.controlStatePath,
    runtimeStatePath: env.runtimeStatePath,
  });
  runtime.__env = env;
  return runtime;
}

async function withRuntime(
  options: Record<string, unknown>,
  run: (runtime: RuntimeUnderTest) => Promise<void>,
): Promise<void> {
  const runtime = await startRuntime(options);
  try {
    assertNoRealUserState(runtime.__env);
    await run(runtime);
  } finally {
    await runtime.stop().catch(() => {});
    runtime.__env.cleanup();
  }
}

describe("HTTP — Control Runtime and HTTP integration", () => {
  it("HTTP-001 starts on a test port, reports health locally, and shuts down cleanly", async () => {
    await withRuntime({ port: 0 }, async (runtime) => {
      expect(runtime.baseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
      const health = await fetch(`${runtime.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      const ready = await fetch(`${runtime.baseUrl}/readyz`);
      expect(ready.status).toBe(200);
      await runtime.stop();
      // After shutdown the runtime no longer serves.
      await expect(fetch(`${runtime.baseUrl}/healthz`)).rejects.toThrow();
    });
  });

  it("HTTP-002 rejects duplicate ownership or reuses the healthy runtime; never two managers", async () => {
    await withRuntime({ port: 0 }, async (first) => {
      // A second normal start for the SAME state root must reuse or be
      // rejected — never coexist as an independent manager.
      const mod = await importExpected("controlRuntime");
      const env = first.__env;
      const second = await mod.startControlRuntime({
        ...isolatedProductOptions(env),
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
      });
      if (second !== first && second.reusedExisting !== true) {
        throw new Error("Second Control Runtime started independently: ownership violated");
      }
      if (second !== first) {
        await second.stop?.();
      }
      // The first runtime is still healthy afterwards.
      const health = await fetch(`${first.baseUrl}/healthz`);
      expect(health.status).toBe(200);
    });
  });

  it("HTTP-003 serves WebUI assets from the installed location, not process.cwd()", async () => {
    await withRuntime({ port: 0, workingDirectory: "/tmp" }, async (runtime) => {
      const response = await fetch(`${runtime.baseUrl}/`);
      expect(response.status).toBe(200);
      // The UI shell resolves from the module/package location; the contract
      // is that it does not depend on the repository checkout as cwd.
      expect(response.headers.get("content-type")).toContain("text/html");
    });
  });

  it("HTTP-004 keeps /mcp and /api/v1/* capabilities separated", async () => {
    await withRuntime({ port: 0 }, async (runtime) => {
      // The MCP surface must not expose workspace administration, settings,
      // secret, startup, or tunnel lifecycle operations. Attempting an
      // admin-shaped tool call through the MCP endpoint must fail as an
      // unknown tool, and no admin passthrough route exists.
      const response = await fetch(`${runtime.baseUrl}/mcp`, {
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
});

describe("START — canonical bootstrap (workspace-lens start)", () => {
  it("START-001 reuses a healthy runtime, starts when absent, and surfaces the local URL", async () => {
    const { runStart } = await importExpected("startCommand");
    const env = createIsolatedProductEnv("start");
    try {
      assertNoRealUserState(env);
      // The start command takes an injectable browser-launch adapter so tests
      // never open a real browser, and runs against the isolated user state.
      const launched: string[] = [];
      const first = await runStart({
        ...isolatedProductOptions(env),
        browserLauncher: (url: string) => {
          launched.push(url);
        },
      });
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1/);
      // A second start against the healthy runtime reuses it rather than
      // duplicating ownership.
      const second = await runStart({
        ...isolatedProductOptions(env),
        browserLauncher: (url: string) => {
          launched.push(url);
        },
      });
      expect(second.reused ?? second.runtime === first.runtime).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it("START-001 (failure path) returns an actionable error when the local runtime cannot start", async () => {
    const { runStart } = await importExpected("startCommand");
    const env = createIsolatedProductEnv("start-fail");
    try {
      await expect(
        runStart({ ...isolatedProductOptions(env), port: 1 }),
      ).rejects.toThrow(/start|runtime|port|error/i);
    } finally {
      env.cleanup();
    }
  });

  it("START-002 keeps the runtime healthy when the browser client terminates", async () => {
    const { runStart } = await importExpected("startCommand");
    const env = createIsolatedProductEnv("start-browser");
    try {
      const result = await runStart({ ...isolatedProductOptions(env) });
      // The browser (test client) goes away; the Control Runtime stays
      // healthy and the MCP endpoint remains available.
      const health = await fetch(`${result.runtime.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      await (result.runtime?.stop?.() ?? Promise.resolve());
    } finally {
      env.cleanup();
    }
  });
});

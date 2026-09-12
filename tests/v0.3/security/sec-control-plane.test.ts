import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { establishSession, apiRequest as mutatingRequest } from "../helpers/control-api.js";
import { importExpected } from "../helpers/expected-module.js";
import { assertNoRealUserState, createIsolatedProductEnv, isolatedProductOptions } from "../helpers/isolated-env.js";
import { callTool, cleanupWorkspace, connectClient, makeConfig, makePlainWorkspace } from "../helpers/mcp.js";

/**
 * L3 — Control Plane Security Contracts: SEC-001..013
 * (`docs/v0.3-test-contract.md` §10; `docs/v0.3-control-plane-security-contract.md` §21).
 *
 * These are release-blocking. SEC-001..012 bind the v0.3 Control Runtime HTTP
 * surface (Slice 7) and are RED until it exists; every rejected-request test
 * also asserts STATE UNCHANGED, per the false-green checklist (§17).
 * SEC-013 (MCP cannot escalate to Control API capabilities) is already
 * proven by the existing v0.2 read-only tool surface and stays GREEN.
 *
 * The runtime harness shape: `control/server.ts` exports
 * `createControlRuntime({ configPath, controlStatePath })` returning
 * `{ baseUrl, stop() }`. Session/CSRF bootstrap follows the security
 * contract: an ephemeral HttpOnly browser-session cookie plus a per-session
 * CSRF token delivered by the session read route.
 */

const SENTINEL_SECRET = "SEC011_SENTINEL_SECRET_kq83mz";

async function createRuntime(): Promise<any> {
  const mod = await importExpected("controlServer");
  const env = createIsolatedProductEnv("sec");
  const runtime = await mod.createControlRuntime({
    ...isolatedProductOptions(env),
    configPath: env.configPath,
    controlStatePath: env.controlStatePath,
  });
  runtime.__dir = env.stateRoot;
  runtime.__env = env;
  return runtime;
}

async function withRuntime(run: (runtime: any) => Promise<void>): Promise<void> {
  const runtime = await createRuntime();
  try {
    await run(runtime);
  } finally {
    await runtime.stop().catch(() => {});
    runtime.__env.cleanup();
  }
}

describe("SEC — control plane security", () => {
  it("SEC-001 binds loopback only; non-loopback exposure is rejected", async () => {
    await withRuntime(async (runtime) => {
      expect(runtime.baseUrl).toMatch(/^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
    });
    await expect(
      withRuntime(async (runtime) => {
        await runtime.rebind({ host: "0.0.0.0" });
      }),
    ).rejects.toThrow();
  });

  it("SEC-002 rejects an unexpected Host header before privileged routing", async () => {
    await withRuntime(async (runtime) => {
      const { host } = new URL(runtime.baseUrl);
      const rejected = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { host: "evil.example" },
      });
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      expect(rejected.status).toBeLessThan(500);
      const alsoRejected = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { host: `${host}.evil.example` },
      });
      expect(alsoRejected.status).toBeGreaterThanOrEqual(400);
      // State unchanged: no workspace document exists after rejected probes.
      const probe = await establishSession(runtime.baseUrl);
      const list = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: probe.cookie },
      });
      expect((await list.json()) as any).toMatchObject({ workspaces: [] });
    });
  });

  it("SEC-003 rejects a foreign-Origin mutating request with state unchanged", async () => {
    await withRuntime(async (runtime) => {
      const session = await establishSession(runtime.baseUrl);
      const rejected = await mutatingRequest(
        runtime.baseUrl,
        "/api/v1/workspaces",
        { root: "/tmp/sec003-should-never-be-authorized" },
        { cookie: session.cookie, csrf: session.csrf, origin: "https://evil.example" },
      );
      expect(rejected.status).toBeGreaterThanOrEqual(400);
      const list = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: session.cookie },
      });
      expect((await list.json()) as any).toMatchObject({ workspaces: [] });
    });
  });

  it("SEC-004 rejects privileged mutations without valid CSRF/session proof, state unchanged", async () => {
    await withRuntime(async (runtime) => {
      const session = await establishSession(runtime.baseUrl);
      const origin = runtime.baseUrl; // valid same-origin for every probe
      const mutationFamilies: { path: string; body: unknown }[] = [
        { path: "/api/v1/workspaces", body: { root: "/tmp/sec004-never" } },
        { path: "/api/v1/settings", body: { startAtLogin: true } },
        { path: "/api/v1/connection/connect", body: {} },
      ];
      for (const family of mutationFamilies) {
        // Variable-isolated rejections: every probe carries a VALID Origin so
        // an implementation that only checks Origin cannot pass this contract.
        // 1) valid Origin + valid CSRF + missing session.
        const noSession = await mutatingRequest(runtime.baseUrl, family.path, family.body, {
          origin,
          csrf: session.csrf,
        });
        expect(noSession.status).toBeGreaterThanOrEqual(400);
        // 2) valid Origin + valid session + missing CSRF token.
        const noCsrf = await mutatingRequest(runtime.baseUrl, family.path, family.body, {
          origin,
          cookie: session.cookie,
        });
        expect(noCsrf.status).toBeGreaterThanOrEqual(400);
        // 3) valid Origin + valid session + invalid CSRF token.
        const badCsrf = await mutatingRequest(runtime.baseUrl, family.path, family.body, {
          origin,
          cookie: session.cookie,
          csrf: "invalid-token",
        });
        expect(badCsrf.status).toBeGreaterThanOrEqual(400);
      }
      // State unchanged across all rejection paths.
      const list = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: session.cookie },
      });
      expect((await list.json()) as any).toMatchObject({ workspaces: [] });
    });
  });

  it("SEC-005 GET cannot mutate authorization, settings, or connection state", async () => {
    await withRuntime(async (runtime) => {
      const session = await establishSession(runtime.baseUrl);
      const before = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: session.cookie },
      });
      // GET on mutation-shaped routes must not mutate.
      const getMutations = await Promise.all([
        fetch(`${runtime.baseUrl}/api/v1/workspaces/remove?id=whatever`, { headers: { cookie: session.cookie } }),
        fetch(`${runtime.baseUrl}/api/v1/settings?startAtLogin=true`, { headers: { cookie: session.cookie } }),
        fetch(`${runtime.baseUrl}/api/v1/connection/connect`, { headers: { cookie: session.cookie } }),
      ]);
      for (const response of getMutations) {
        expect(response.status).toBeGreaterThanOrEqual(400);
      }
      const after = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: session.cookie },
      });
      expect(JSON.stringify(await after.json())).toBe(JSON.stringify(await before.json()));
    });
  });

  it("SEC-006 never sends wildcard CORS on privileged surfaces", async () => {
    await withRuntime(async (runtime) => {
      for (const route of ["/api/v1/status", "/api/v1/workspaces", "/api/v1/session"]) {
        const response = await fetch(`${runtime.baseUrl}${route}`, {
          headers: { origin: "https://evil.example" },
        });
        const cors = response.headers.get("access-control-allow-origin");
        expect(cors).not.toBe("*");
        expect(cors).not.toBe("https://evil.example");
      }
    });
  });

  it("SEC-007 rejects oversized request bodies before unbounded processing", async () => {
    await withRuntime(async (runtime) => {
      const session = await establishSession(runtime.baseUrl);
      const oversized = "x".repeat(2 * 1024 * 1024);
      const response = await mutatingRequest(
        runtime.baseUrl,
        "/api/v1/workspaces",
        { root: "/tmp/sec007", note: oversized },
        {
          cookie: session.cookie,
          csrf: session.csrf,
          origin: runtime.baseUrl,
        },
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      // State unchanged: the rejected oversized request must not have
      // authorized anything or mutated configuration.
      const list = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: session.cookie },
      });
      expect((await list.json()) as any).toMatchObject({ workspaces: [] });
    });
  });

  it("SEC-008 rejects malformed DTOs with a stable 4xx and no partial mutation", async () => {
    await withRuntime(async (runtime) => {
      const session = await establishSession(runtime.baseUrl);
      const invalidPayloads: Record<string, unknown>[] = [
        { root: 42 },
        { root: "relative/path" },
        { id: "<script>" },
        { workspace_id: "", enabled: "yes" },
        {},
      ];
      for (const payload of invalidPayloads) {
        const response = await mutatingRequest(
          runtime.baseUrl,
          "/api/v1/workspaces",
          payload,
          { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl },
        );
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.status).toBeLessThan(500);
        const body = JSON.stringify(await response.json());
        // Bounded product error: no stack traces or internal dumps.
        expect(body).not.toMatch(/at .*\(|node_modules|stack/i);
      }
      const list = await fetch(`${runtime.baseUrl}/api/v1/workspaces`, {
        headers: { cookie: session.cookie },
      });
      expect((await list.json()) as any).toMatchObject({ workspaces: [] });
    });
  });

  it("SEC-009 sets the browser session cookie with HttpOnly and SameSite=Strict", async () => {
    await withRuntime(async (runtime) => {
      const sessionResponse = await fetch(`${runtime.baseUrl}/api/v1/session`);
      const setCookie = sessionResponse.headers.get("set-cookie") ?? "";
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
    });
  });

  it("SEC-010 serves the WebUI with a restrictive CSP and no remote script dependency", async () => {
    await withRuntime(async (runtime) => {
      const response = await fetch(`${runtime.baseUrl}/`);
      const csp = response.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).not.toContain("unsafe-eval");
      expect(csp).not.toMatch(/https?:\/\/(?!127\.0\.0\.1|localhost)/);
      expect(response.headers.get("x-frame-options") ?? csp).toMatch(/DENY|SAMEORIGIN|frame-ancestors/i);
    });
  });

  it("SEC-011 keeps a sentinel secret out of API responses, logs, diagnostics, argv, and config", async () => {
    await withRuntime(async (runtime) => {
      const session = await establishSession(runtime.baseUrl);
      // Credential setup accepts the secret exactly once.
      const setup = await mutatingRequest(
        runtime.baseUrl,
        "/api/v1/credentials",
        { runtimeApiKey: SENTINEL_SECRET },
        { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl },
      );
      expect([200, 201]).toContain(setup.status);
      const setupBody = JSON.stringify(await setup.json());
      expect(setupBody).not.toContain(SENTINEL_SECRET);

      const surfaces: string[] = [];
      surfaces.push(setupBody);
      surfaces.push(JSON.stringify(await (await fetch(`${runtime.baseUrl}/api/v1/credentials`, { headers: { cookie: session.cookie } })).json()));
      surfaces.push(JSON.stringify(await (await fetch(`${runtime.baseUrl}/api/v1/connection`, { headers: { cookie: session.cookie } })).json()));
      surfaces.push(JSON.stringify(await (await fetch(`${runtime.baseUrl}/api/v1/diagnostics`, { headers: { cookie: session.cookie } })).json()));
      // The runtime test harness must actually capture logs and child argv;
      // an absent capture hook is itself a contract failure, never a pass.
      expect(Array.isArray(runtime.capturedLogs)).toBe(true);
      expect(Array.isArray(runtime.capturedChildArgv)).toBe(true);
      surfaces.push(JSON.stringify(runtime.capturedLogs));
      surfaces.push(JSON.stringify(runtime.capturedChildArgv));
      for (const surface of surfaces) {
        expect(surface).not.toContain(SENTINEL_SECRET);
      }
      // Persisted normal config/control-state hold no secret either: scan
      // every artifact the product wrote into the isolated state root.
      assertNoRealUserState(runtime.__env);
      for (const relative of runtime.__env.listStateRootFiles()) {
        const content = runtime.__env.readStateFile(relative) ?? "";
        expect(content).not.toContain(SENTINEL_SECRET);
      }
    });
  });

  it("SEC-012 keeps workspace file contents out of diagnostics", async () => {
    const workspace = makePlainWorkspace("sec012");
    try {
      await withRuntime(async (runtime) => {
        const session = await establishSession(runtime.baseUrl);
        await mutatingRequest(
          runtime.baseUrl,
          "/api/v1/workspaces",
          { root: workspace.root },
          { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl },
        );
        const diagnostics = await (await fetch(`${runtime.baseUrl}/api/v1/diagnostics`, {
          headers: { cookie: session.cookie },
        })).json();
        const diagnosticsText = JSON.stringify(diagnostics);
        // Status metadata only: no file bodies, diffs, or search snippets.
        expect(diagnosticsText).not.toContain(workspace.sentinelContent);
      });
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("SEC-013 gives MCP no tool or protocol path to Control API capabilities", async () => {
    const { client } = await connectClient(makeConfig([]));
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name);
      const adminShaped = names.filter((name) =>
        /add|remove|enable|disable|secret|tunnel|startup|setting|admin/i.test(name),
      );
      expect(adminShaped).toEqual([]);

      // Direct escalation attempts through the tool surface fail closed.
      for (const attempt of [
        "workspace_add",
        "workspace_remove",
        "workspace_disable",
        "settings_update",
        "secret_get",
        "tunnel_stop",
        "run_command",
      ]) {
        const result = await callTool(client, attempt, {});
        expect(result.isError).toBe(true);
      }
      // No resources/prompts channel exists that could carry admin capability.
      await expect(client.listResources()).rejects.toThrow(/-32601|Method not found/);
      await expect(client.listPrompts()).rejects.toThrow(/-32601|Method not found/);
      await client.close();
  });
});

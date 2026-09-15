import { describe, expect, it } from "vitest";
import { createControlRuntime } from "../../../src/control/server.js";
import { createIsolatedProductEnv, isolatedProductOptions } from "../helpers/isolated-env.js";
import { establishSession, apiRequest } from "../helpers/control-api.js";

describe("Connection and Diagnostics Control API (Slice 11 focused)", () => {
  it("exposes connection status and enforces credential requirements for connect/start/restart", async () => {
    const env = createIsolatedProductEnv("conn-api-1");
    let runtime: any;
    try {
      runtime = await createControlRuntime({
        ...isolatedProductOptions(env),
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
      });

      const session = await establishSession(runtime.baseUrl);
      const headers = { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl };

      // GET /api/v1/connection
      const statusRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      expect(statusRes.status).toBe(200);
      const statusBody = await statusRes.json();
      expect(statusBody).toHaveProperty("state");
      expect(statusBody).toHaveProperty("workspaceConfigurationIntact", true);

      // Without credentials: connect, start, restart must return 400 CREDENTIAL_REQUIRED
      const connectRes = await apiRequest(runtime.baseUrl, "/api/v1/connection/connect", {}, headers);
      expect(connectRes.status).toBe(400);
      expect(await connectRes.json()).toMatchObject({
        error: { code: "CREDENTIAL_REQUIRED" },
      });

      const startRes = await apiRequest(runtime.baseUrl, "/api/v1/connection/start", {}, headers);
      expect(startRes.status).toBe(400);
      expect(await startRes.json()).toMatchObject({
        error: { code: "CREDENTIAL_REQUIRED" },
      });

      const restartRes = await apiRequest(runtime.baseUrl, "/api/v1/connection/restart", {}, headers);
      expect(restartRes.status).toBe(400);
      expect(await restartRes.json()).toMatchObject({
        error: { code: "CREDENTIAL_REQUIRED" },
      });

      // Stop does not require credentials
      const stopRes = await apiRequest(runtime.baseUrl, "/api/v1/connection/stop", {}, headers);
      expect(stopRes.status).toBe(200);
      expect(await stopRes.json()).toMatchObject({
        state: "stopped",
      });

      // Diagnostics GET and POST run
      const diagGet = await fetch(`${runtime.baseUrl}/api/v1/diagnostics`, {
        headers: { cookie: session.cookie },
      });
      expect(diagGet.status).toBe(200);
      const diagGetBody = (await diagGet.json()) as any;
      expect(Array.isArray(diagGetBody.checks)).toBe(true);

      const diagRun = await apiRequest(runtime.baseUrl, "/api/v1/diagnostics/run", {}, headers);
      expect(diagRun.status).toBe(200);
      const diagRunBody = (await diagRun.json()) as any;
      expect(Array.isArray(diagRunBody.checks)).toBe(true);
    } finally {
      await runtime?.stop?.().catch(() => {});
      env.cleanup();
    }
  });

  it("rejects concurrent connection transitions with 409 Conflict", async () => {
    const env = createIsolatedProductEnv("conn-api-conflict");
    let runtime: any;
    try {
      // Injected slow tunnel adapter
      let releaseSlowStop: () => void = () => {};
      const slowStopPromise = new Promise<void>((resolve) => {
        releaseSlowStop = resolve;
      });

      const tunnelAdapter = {
        detect: async () => ({ installed: true, version: "0.0.14" }),
        connect: async () => ({ alias: "test", state: "healthy" }),
        status: async () => ({ alias: "test", state: "healthy" }),
        stop: async () => {
          await slowStopPromise;
        },
        restart: async () => ({ alias: "test", state: "healthy" }),
      };

      runtime = await createControlRuntime({
        ...isolatedProductOptions(env),
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        tunnelAdapter,
      });

      const session = await establishSession(runtime.baseUrl);
      const headers = { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl };

      // Launch first stop (in-flight)
      const firstStop = apiRequest(runtime.baseUrl, "/api/v1/connection/stop", {}, headers);

      // Immediately launch second stop while first is active
      const secondStop = await apiRequest(runtime.baseUrl, "/api/v1/connection/stop", {}, headers);
      expect(secondStop.status).toBe(409);
      expect(await secondStop.json()).toMatchObject({
        error: { code: "CONNECTION_TRANSITION_ACTIVE" },
      });

      // Release first stop
      releaseSlowStop();
      const firstRes = await firstStop;
      expect(firstRes.status).toBe(200);
    } finally {
      await runtime?.stop?.().catch(() => {});
      env.cleanup();
    }
  });
});

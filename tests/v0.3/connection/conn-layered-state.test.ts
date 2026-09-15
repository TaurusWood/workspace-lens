import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConnectionService } from "../../../src/application/connection-service.js";
import { TunnelRuntimeAdapter } from "../../../src/integrations/openai/tunnel-runtime-adapter.js";
import { startControlRuntime, type ControlRuntimeHandle } from "../../../src/control/runtime.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createIsolatedProductEnv } from "../helpers/isolated-env.js";
import { inMemorySecretAdapter } from "../helpers/test-adapters.js";
import { establishSession, apiRequest } from "../helpers/control-api.js";

async function connectMcpHttp(url: string): Promise<Client> {
  const client = new Client({ name: "v0.3-mcp-http-contract-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  return client;
}

const STUB_LOG = "stub-invocations.json";

function writeStubExecutable(dir: string, script: string): string {
  const stubPath = path.join(dir, "stub-tunnel-client.mjs");
  fs.writeFileSync(stubPath, script);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function makeRecordingStub(): string {
  return `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.WL_STUB_LOG;
const scenario = JSON.parse(fs.readFileSync(process.env.WL_STUB_SCENARIO, "utf8"));
const invocation = {
  argv: process.argv.slice(2),
  envKey: process.env.WORKSPACE_LENS_RUNTIME_KEY ?? null,
};
const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
log.push(invocation);
fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
const response = scenario.responses[log.length - 1] ?? { exitCode: 0, stdout: "", stderr: "" };
if (response.stderr) process.stderr.write(response.stderr);
if (response.stdout) process.stdout.write(response.stdout);
process.exit(response.exitCode ?? 0);
`;
}

describe("Slice 12.5B — Backend Connection State Contract Closure", () => {
  it("Case A: fresh machine defaults user confirmations to not-confirmed/none and reports action-required", async () => {
    const env = createIsolatedProductEnv("conn-case-a");
    let runtime: ControlRuntimeHandle | undefined;
    try {
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session = await establishSession(runtime.baseUrl);
      const res = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;

      expect(body.layers).toBeDefined();
      expect(body.layers.localRuntime).toEqual({ state: "healthy", evidence: "machine" });
      expect(body.layers.providerSetup).toEqual({ state: "not-confirmed", evidence: "none" });
      expect(body.layers.verification).toEqual({ state: "not-confirmed", evidence: "none" });
      expect(body.layers.tunnelConfiguration.state).toBe("action-required");
      expect(body.layers.tunnelConfiguration.evidence).toBe("machine");
      expect(body.nextAction).toBe("Store the runtime API key before connecting.");
    } finally {
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });

  it("Case B: tunnel-client missing produces tunnelClient.state = missing with actionable nextAction", async () => {
    const mockAdapter = {
      detect: async () => ({ installed: false }),
      status: async () => {
        throw new Error("spawn tunnel-client ENOENT");
      },
      connect: async () => ({ alias: "test", state: "healthy" }),
    };

    const service = new ConnectionService({
      adapter: mockAdapter,
      controlRuntime: { baseUrl: "http://127.0.0.1:50000", isHealthy: async () => true },
      credentialStatus: { isConfigured: async () => true },
      connection: {
        alias: "workspace-lens",
        mcpServerUrl: "http://127.0.0.1:50000/mcp",
        runtimeApiKey: "test-key",
      },
    });

    const status = await service.currentStatus();
    expect(status.layers.tunnelClient.state).toBe("missing");
    expect(status.layers.tunnelClient.evidence).toBe("machine");
    expect(status.layers.tunnelClient.action).toContain("Install");
    expect(status.nextAction).toContain("Install");
    expect(status.layers.tunnelClient.state).not.toBe("problem");
  });

  it("Case C: credential missing produces tunnelConfiguration.state = action-required without leaking secret", async () => {
    const env = createIsolatedProductEnv("conn-case-c");
    let runtime: ControlRuntimeHandle | undefined;
    try {
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session = await establishSession(runtime.baseUrl);
      const res = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      const body = (await res.json()) as any;

      expect(body.layers.tunnelConfiguration.state).toBe("action-required");
      expect(body.layers.tunnelConfiguration.action).toBe("Store the runtime API key before connecting.");
      expect(body.nextAction).toBe("Store the runtime API key before connecting.");

      // Verify no secret or secret-shaped key is leaked in payload
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain("secret");
      expect(serialized).not.toContain("runtimeApiKey");
    } finally {
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });

  it("Case D: alias missing maps to tunnelConfiguration.state = not-configured and tunnelRuntime.state = missing", async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-test-stub-d-"));
    const logPath = path.join(stubDir, STUB_LOG);
    const scenarioPath = path.join(stubDir, "scenario.json");
    fs.writeFileSync(
      scenarioPath,
      JSON.stringify({
        responses: [
          {
            exitCode: 1,
            stderr: "alias workspace-lens is not known; run create or connect first\n",
          },
        ],
      }),
    );
    const stubPath = writeStubExecutable(stubDir, makeRecordingStub());

    try {
      const adapter = new TunnelRuntimeAdapter({
        executable: stubPath,
        env: { WL_STUB_LOG: logPath, WL_STUB_SCENARIO: scenarioPath },
      });

      const service = new ConnectionService({
        adapter,
        controlRuntime: { baseUrl: "http://127.0.0.1:50000", isHealthy: async () => true },
        credentialStatus: { isConfigured: async () => true },
        connection: {
          alias: "workspace-lens",
          mcpServerUrl: "http://127.0.0.1:50000/mcp",
          runtimeApiKey: "test-key",
        },
      });

      const result = await service.currentStatus();
      expect(result.state).toBe("missing");
      expect(result.layers.tunnelConfiguration.state).toBe("not-configured");
      expect(result.layers.tunnelConfiguration.evidence).toBe("machine");
      expect(result.layers.tunnelRuntime.state).toBe("missing");
      expect(result.layers.tunnelRuntime.evidence).toBe("machine");
      expect(result.nextAction).toBe("Connect to create the tunnel runtime for this machine.");
      expect(result.layers.tunnelConfiguration.state).not.toBe("problem");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("Case E: healthy tunnel produces tunnelClient=available, tunnelConfiguration=configured, tunnelRuntime=healthy", async () => {
    const mockAdapter = {
      status: async () => ({ alias: "workspace-lens", status: "running", health: "healthy" }),
      connect: async () => ({ alias: "workspace-lens", state: "healthy" }),
    };

    const service = new ConnectionService({
      adapter: mockAdapter,
      controlRuntime: { baseUrl: "http://127.0.0.1:50000", isHealthy: async () => true },
      credentialStatus: { isConfigured: async () => true },
      connection: {
        alias: "workspace-lens",
        mcpServerUrl: "http://127.0.0.1:50000/mcp",
        runtimeApiKey: "test-key",
      },
    });

    const result = await service.currentStatus();
    expect(result.state).toBe("healthy");
    expect(result.layers.tunnelClient).toEqual({ state: "available", evidence: "machine" });
    expect(result.layers.tunnelConfiguration).toEqual({ state: "configured", evidence: "machine" });
    expect(result.layers.tunnelRuntime).toEqual({ state: "healthy", evidence: "machine" });
  });

  it("Case F: unhealthy tunnel produces tunnelRuntime.state = unhealthy with recovery action", async () => {
    const mockAdapter = {
      status: async () => ({ alias: "workspace-lens", status: "unhealthy", health: "unhealthy" }),
      connect: async () => ({ alias: "workspace-lens", state: "unhealthy" }),
    };

    const service = new ConnectionService({
      adapter: mockAdapter,
      controlRuntime: { baseUrl: "http://127.0.0.1:50000", isHealthy: async () => true },
      credentialStatus: { isConfigured: async () => true },
      connection: {
        alias: "workspace-lens",
        mcpServerUrl: "http://127.0.0.1:50000/mcp",
        runtimeApiKey: "test-key",
      },
    });

    const result = await service.currentStatus();
    expect(result.state).toBe("unhealthy");
    expect(result.layers.tunnelRuntime.state).toBe("unhealthy");
    expect(result.layers.tunnelRuntime.evidence).toBe("machine");
    expect(result.nextAction).toBe("Open Diagnostics and follow the connection recovery steps.");
  });

  it("Case G: unknown adapter failure produces tunnelRuntime.state = problem without crashing runtime", async () => {
    const mockAdapter = {
      status: async () => {
        throw new Error("kernel panic or unexpected adapter crash");
      },
      connect: async () => ({ alias: "workspace-lens", state: "healthy" }),
    };

    const service = new ConnectionService({
      adapter: mockAdapter,
      controlRuntime: { baseUrl: "http://127.0.0.1:50000", isHealthy: async () => true },
      credentialStatus: { isConfigured: async () => true },
      connection: {
        alias: "workspace-lens",
        mcpServerUrl: "http://127.0.0.1:50000/mcp",
        runtimeApiKey: "test-key",
      },
    });

    const result = await service.currentStatus();
    expect(result.state).toBe("problem");
    expect(result.layers.tunnelRuntime.state).toBe("problem");
    expect(result.layers.tunnelRuntime.evidence).toBe("machine");
    expect(result.nextAction).toBe("Open Diagnostics and follow the connection recovery steps.");
  });

  it("Case H: provider setup user confirmation PATCH sets user-confirmed / user without verified", async () => {
    const env = createIsolatedProductEnv("conn-case-h");
    let runtime: ControlRuntimeHandle | undefined;
    try {
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session = await establishSession(runtime.baseUrl);
      const headers = { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl };

      const patchRes = await apiRequest(
        runtime.baseUrl,
        "/api/v1/settings",
        { providerSetupUserConfirmed: true },
        headers,
        "PATCH",
      );
      expect(patchRes.status).toBe(200);

      const connRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      const connBody = (await connRes.json()) as any;
      expect(connBody.layers.providerSetup).toEqual({
        state: "user-confirmed",
        evidence: "user",
      });

      // Strict prohibition: verified must not appear as evidence or state
      const serialized = JSON.stringify(connBody.layers.providerSetup);
      expect(serialized).not.toContain("machine-verified");
      expect(serialized).not.toContain("provider-verified");
      expect(serialized).not.toContain("chatgpt-verified");
      expect(serialized).not.toContain('"verified"');
    } finally {
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });

  it("Case I: verification user confirmation PATCH sets user-confirmed / user", async () => {
    const env = createIsolatedProductEnv("conn-case-i");
    let runtime: ControlRuntimeHandle | undefined;
    try {
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session = await establishSession(runtime.baseUrl);
      const headers = { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl };

      const patchRes = await apiRequest(
        runtime.baseUrl,
        "/api/v1/settings",
        { verificationUserConfirmed: true },
        headers,
        "PATCH",
      );
      expect(patchRes.status).toBe(200);

      const connRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      const connBody = (await connRes.json()) as any;
      expect(connBody.layers.verification).toEqual({
        state: "user-confirmed",
        evidence: "user",
      });
    } finally {
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });

  it("Case J: reload reconstruction recovers provider setup and verification confirmations from persisted control state", async () => {
    const env = createIsolatedProductEnv("conn-case-j");
    let runtime: ControlRuntimeHandle | undefined;
    try {
      // 1. Start initial runtime
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session1 = await establishSession(runtime.baseUrl);
      const headers1 = { cookie: session1.cookie, csrf: session1.csrf, origin: runtime.baseUrl };

      // 2. Set both confirmations
      const patchRes = await apiRequest(
        runtime.baseUrl,
        "/api/v1/settings",
        { providerSetupUserConfirmed: true, verificationUserConfirmed: true },
        headers1,
        "PATCH",
      );
      expect(patchRes.status).toBe(200);

      // 3. Stop runtime
      await runtime.runtime.stop();
      runtime = undefined;

      // 4. Start fresh runtime on same state paths
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session2 = await establishSession(runtime.baseUrl);
      const connRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session2.cookie },
      });
      const connBody = (await connRes.json()) as any;

      // Both confirmations are recovered from persisted control state
      expect(connBody.layers.providerSetup).toEqual({
        state: "user-confirmed",
        evidence: "user",
      });
      expect(connBody.layers.verification).toEqual({
        state: "user-confirmed",
        evidence: "user",
      });
    } finally {
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });

  it("Case K: successful MCP activity must NOT verify provider (lockdown: MCP activity != provider verification)", async () => {
    const env = createIsolatedProductEnv("conn-case-k");
    let runtime: ControlRuntimeHandle | undefined;
    let mcpClient: any;
    try {
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session = await establishSession(runtime.baseUrl);

      // Verify before MCP activity: confirmations are not-confirmed
      const beforeRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      const beforeBody = (await beforeRes.json()) as any;
      expect(beforeBody.layers.providerSetup).toEqual({ state: "not-confirmed", evidence: "none" });
      expect(beforeBody.layers.verification).toEqual({ state: "not-confirmed", evidence: "none" });

      // Perform real MCP tool call over HTTP MCP bridge
      mcpClient = await connectMcpHttp(runtime.baseUrl);
      const listResult = await mcpClient.callTool({ name: "workspace_list", arguments: {} });
      expect(listResult.isError).toBeFalsy();

      // Check /healthz to verify MCP metrics updated (active_requests / last_request_at)
      const healthRes = await fetch(`${runtime.baseUrl}/healthz`);
      const healthBody = (await healthRes.json()) as any;
      expect(healthBody.mcp).toBeDefined();
      expect(healthBody.mcp.last_request_at).not.toBeNull();

      // After successful MCP tool execution, connection confirmations MUST REMAIN not-confirmed
      const afterRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      const afterBody = (await afterRes.json()) as any;
      expect(afterBody.layers.providerSetup).toEqual({ state: "not-confirmed", evidence: "none" });
      expect(afterBody.layers.verification).toEqual({ state: "not-confirmed", evidence: "none" });
    } finally {
      await mcpClient?.close().catch(() => {});
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });

  it("Task 12.5B-8: API contract tests enforce strict DTO validation and complete layered response", async () => {
    const env = createIsolatedProductEnv("conn-api-contracts");
    let runtime: ControlRuntimeHandle | undefined;
    try {
      runtime = await startControlRuntime({
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        secretAdapter: inMemorySecretAdapter(),
      });

      const session = await establishSession(runtime.baseUrl);
      const headers = { cookie: session.cookie, csrf: session.csrf, origin: runtime.baseUrl };

      // 1. Complete layered DTO structure on GET /api/v1/connection
      const connRes = await fetch(`${runtime.baseUrl}/api/v1/connection`, {
        headers: { cookie: session.cookie },
      });
      expect(connRes.status).toBe(200);
      const conn = (await connRes.json()) as any;
      expect(conn).toHaveProperty("state");
      expect(conn).toHaveProperty("workspaceConfigurationIntact", true);
      expect(conn).toHaveProperty("layers");
      expect(conn.layers).toHaveProperty("localRuntime");
      expect(conn.layers).toHaveProperty("tunnelClient");
      expect(conn.layers).toHaveProperty("tunnelConfiguration");
      expect(conn.layers).toHaveProperty("tunnelRuntime");
      expect(conn.layers).toHaveProperty("providerSetup");
      expect(conn.layers).toHaveProperty("verification");

      // 2. PATCH rejects unknown fields with 400
      const unknownRes = await apiRequest(
        runtime.baseUrl,
        "/api/v1/settings",
        { unknownField: "bad" },
        headers,
        "PATCH",
      );
      expect(unknownRes.status).toBe(400);

      // 3. PATCH rejects wrong type with 400
      const wrongTypeRes = await apiRequest(
        runtime.baseUrl,
        "/api/v1/settings",
        { providerSetupUserConfirmed: "not-a-boolean" },
        headers,
        "PATCH",
      );
      expect(wrongTypeRes.status).toBe(400);

      // 4. PATCH rejects secret-like fields with 400
      const secretRes = await apiRequest(
        runtime.baseUrl,
        "/api/v1/settings",
        { runtimeApiKey: "should-be-rejected" },
        headers,
        "PATCH",
      );
      expect(secretRes.status).toBe(400);
    } finally {
      await runtime?.runtime.stop();
      env.cleanup();
    }
  });
});

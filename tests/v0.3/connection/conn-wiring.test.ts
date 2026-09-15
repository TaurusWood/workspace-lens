import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConnectionService } from "../../../src/application/connection-service.js";
import { TunnelRuntimeAdapter } from "../../../src/integrations/openai/tunnel-runtime-adapter.js";
import type { ConnectionRuntimeInput } from "../../../src/application/contracts.js";

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

describe("Task 12.5A — Connection production wiring and state mapping", () => {
  it("A. maps frozen missing-alias stderr to missing state (never problem) across TunnelRuntimeAdapter -> ConnectionService", async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-test-stub-"));
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
        controlRuntime: { baseUrl: "http://127.0.0.1:59998", isHealthy: async () => true },
        configStore: { load: () => ({ version: 1, expose_absolute_paths: false, workspaces: [] }) },
        connection: {
          alias: "workspace-lens",
          mcpServerUrl: "http://127.0.0.1:59998/mcp",
        },
      });

      const result = await service.currentStatus();
      expect(result.state).toBe("missing");
      expect(result.state).not.toBe("problem");
      expect(result.workspaceConfigurationIntact).toBe(true);
      expect(result.nextAction).toBe("Connect to create the tunnel runtime for this machine.");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("B. maps structured unhealthy to unhealthy state across TunnelRuntimeAdapter -> ConnectionService", async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-test-stub-"));
    const logPath = path.join(stubDir, STUB_LOG);
    const scenarioPath = path.join(stubDir, "scenario.json");
    fs.writeFileSync(
      scenarioPath,
      JSON.stringify({
        responses: [
          {
            exitCode: 0,
            stdout: JSON.stringify({ status: "unhealthy" }),
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
        controlRuntime: { baseUrl: "http://127.0.0.1:59998", isHealthy: async () => true },
        configStore: { load: () => ({ version: 1, expose_absolute_paths: false, workspaces: [] }) },
        connection: {
          alias: "workspace-lens",
          mcpServerUrl: "http://127.0.0.1:59998/mcp",
        },
      });

      const result = await service.currentStatus();
      expect(result.state).toBe("unhealthy");
      expect(result.state).not.toBe("problem");
      expect(result.workspaceConfigurationIntact).toBe(true);
      expect(result.nextAction).toBe("Open Diagnostics and follow the connection recovery steps.");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("C. maps unknown / non-classifiable adapter failure to problem state", async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-test-stub-"));
    const logPath = path.join(stubDir, STUB_LOG);
    const scenarioPath = path.join(stubDir, "scenario.json");
    fs.writeFileSync(
      scenarioPath,
      JSON.stringify({
        responses: [
          {
            exitCode: 2,
            stderr: "unexpected process crash or kernel panic\n",
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
        controlRuntime: { baseUrl: "http://127.0.0.1:59998", isHealthy: async () => true },
        configStore: { load: () => ({ version: 1, expose_absolute_paths: false, workspaces: [] }) },
        connection: {
          alias: "workspace-lens",
          mcpServerUrl: "http://127.0.0.1:59998/mcp",
        },
      });

      const result = await service.currentStatus();
      expect(result.state).toBe("problem");
      expect(result.workspaceConfigurationIntact).toBe(true);
      expect(result.nextAction).toBe("Open Diagnostics and follow the connection recovery steps.");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("D & E. restart resolves connection input lazily, captures exact contract, and does not cache stale credentials", async () => {
    let currentApiKey: string | undefined = "key-version-1";
    let capturedRestartInput: ConnectionRuntimeInput | undefined;
    let capturedConnectInput: ConnectionRuntimeInput | undefined;

    const mockAdapter = {
      status: async () => ({ alias: "workspace-lens", status: "running", health: "healthy" }),
      connect: async (input?: ConnectionRuntimeInput) => {
        capturedConnectInput = input;
        return { alias: input?.alias ?? "workspace-lens", state: "healthy" };
      },
      stop: async () => ({ alias: "workspace-lens", state: "stopped" }),
      restart: async (input?: ConnectionRuntimeInput) => {
        capturedRestartInput = input;
        return { alias: input?.alias ?? "workspace-lens", state: "healthy" };
      },
    };

    let boundPort = 42100;
    const service = new ConnectionService({
      adapter: mockAdapter,
      controlRuntime: { baseUrl: "http://127.0.0.1:42100", isHealthy: async () => true },
      connection: {
        alias: "workspace-lens",
        mcpServerUrl: () => `http://127.0.0.1:${boundPort}/mcp`,
        getRuntimeApiKey: async () => currentApiKey,
      },
    });

    // 1. Initial connect
    await service.connect();
    expect(capturedConnectInput).toBeDefined();
    expect(typeof capturedConnectInput!.mcpServerUrl).toBe("string");
    expect(capturedConnectInput!.mcpServerUrl).toBe("http://127.0.0.1:42100/mcp");
    expect(capturedConnectInput!.runtimeApiKey).toBe("key-version-1");
    expect(capturedConnectInput!.alias).toBe("workspace-lens");

    // 2. Credential rotated and port shifted before restart
    currentApiKey = "key-version-2-rotated";
    boundPort = 42101;

    // 3. Restart must invoke adapter.restart with the freshly resolved input
    await service.restart();
    expect(capturedRestartInput).toBeDefined();
    expect(typeof capturedRestartInput!.mcpServerUrl).toBe("string");
    expect(capturedRestartInput!.mcpServerUrl).toBe("http://127.0.0.1:42101/mcp");
    expect(capturedRestartInput!.runtimeApiKey).toBe("key-version-2-rotated");
    expect(capturedRestartInput!.alias).toBe("workspace-lens");
  });

  it("D & E (end-to-end). TunnelRuntimeAdapter.restart passes lazily resolved credentials and exact argv to subprocess", async () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-test-stub-"));
    const logPath = path.join(stubDir, STUB_LOG);
    const scenarioPath = path.join(stubDir, "scenario.json");
    fs.writeFileSync(
      scenarioPath,
      JSON.stringify({
        responses: [
          // 1. connect response
          { exitCode: 0, stdout: JSON.stringify({ status: "running" }) },
          // 2. stop response (from restart)
          { exitCode: 0, stdout: "" },
          // 3. connect response (from restart)
          { exitCode: 0, stdout: JSON.stringify({ status: "running" }) },
        ],
      }),
    );
    const stubPath = writeStubExecutable(stubDir, makeRecordingStub());

    try {
      const adapter = new TunnelRuntimeAdapter({
        executable: stubPath,
        env: { WL_STUB_LOG: logPath, WL_STUB_SCENARIO: scenarioPath },
      });

      let currentApiKey: string | undefined = "secret-v1";
      const service = new ConnectionService({
        adapter,
        controlRuntime: { baseUrl: "http://127.0.0.1:50123", isHealthy: async () => true },
        connection: {
          alias: "workspace-lens",
          mcpServerUrl: () => "http://127.0.0.1:50123/mcp",
          getRuntimeApiKey: async () => currentApiKey,
        },
      });

      // First connect
      await service.connect();

      // Credential changes in SecretStore
      currentApiKey = "secret-v2-fresh";

      // Restart
      await service.restart();

      const invocations = JSON.parse(fs.readFileSync(logPath, "utf8")) as {
        argv: string[];
        envKey: string;
      }[];

      expect(invocations.length).toBe(3);
      // First invocation: connect with secret-v1
      expect(invocations[0]!.argv).toEqual([
        "runtimes",
        "connect",
        "--alias",
        "workspace-lens",
        "--mcp-server-url",
        "http://127.0.0.1:50123/mcp",
        "--runtime-api-key",
        "env:WORKSPACE_LENS_RUNTIME_KEY",
        "--json",
      ]);
      expect(invocations[0]!.envKey).toBe("secret-v1");

      // Second invocation: stop workspace-lens
      expect(invocations[1]!.argv).toEqual(["runtimes", "stop", "workspace-lens", "--json"]);

      // Third invocation: connect with secret-v2-fresh
      expect(invocations[2]!.argv).toEqual([
        "runtimes",
        "connect",
        "--alias",
        "workspace-lens",
        "--mcp-server-url",
        "http://127.0.0.1:50123/mcp",
        "--runtime-api-key",
        "env:WORKSPACE_LENS_RUNTIME_KEY",
        "--json",
      ]);
      expect(invocations[2]!.envKey).toBe("secret-v2-fresh");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });
});

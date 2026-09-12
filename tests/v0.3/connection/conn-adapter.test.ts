import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";

/**
 * Connection / Tunnel Adapter Contracts: CONN-001..005
 * (`docs/v0.3-test-contract.md` §9).
 *
 * These bind the v0.3 `TunnelRuntimeAdapter` / `ConnectionService` (Slice 6)
 * against the real captured Gate-B output in `tests/v0.3/fixtures/gate-b/`.
 * All are RED until the adapter exists; the fixture for the missing-alias
 * state is the real binary's documented behavior (exit 1 + human-readable
 * stderr), which the adapter must normalize into a stable product state.
 *
 * For CONN-002 the stub executable contract is expressed through a real
 * stub script (see tests/v0.3/fixtures/stub-tunnel-client.mjs) so the exact
 * argv arrays can be asserted without the official binary.
 */

const FIXTURE_DIR = path.join(import.meta.dirname, "../fixtures/gate-b");
const STUB_LOG = "stub-invocations.json";

function writeStubExecutable(dir: string, script: string): string {
  const stubPath = path.join(dir, "stub-tunnel-client.mjs");
  fs.writeFileSync(stubPath, script);
  fs.chmodSync(stubPath, 0o755);
  return stubPath;
}

function makeRecordingStub(): string {
  // Records argv + env exposure per invocation, emits JSON payloads chosen by
  // a scenario file so tests can drive status/stop/failure shapes.
  return `#!/usr/bin/env node
import fs from "node:fs";
const logPath = process.env.WL_STUB_LOG;
const scenario = JSON.parse(fs.readFileSync(process.env.WL_STUB_SCENARIO, "utf8"));
const invocation = { argv: process.argv.slice(2), envRef: process.env.WL_STUB_SEES_ENV ?? null };
const log = fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf8")) : [];
log.push(invocation);
fs.writeFileSync(logPath, JSON.stringify(log, null, 2));
const response = scenario.responses[log.length - 1] ?? { exitCode: 0, stdout: "", stderr: "" };
if (response.stderr) process.stderr.write(response.stderr);
if (response.stdout) process.stdout.write(response.stdout);
process.exit(response.exitCode ?? 0);
`;
}

describe("CONN — tunnel adapter contracts", () => {
  it("CONN-001 normalizes captured Gate-B status output into stable product states", async () => {
    const { normalizeRuntimeStatus } = await importExpected("tunnelRuntimeAdapter");
    const listFixture = JSON.parse(
      fs.readFileSync(path.join(FIXTURE_DIR, "runtimes-list-empty.json"), "utf8"),
    );
    expect(Array.isArray(listFixture.aliases)).toBe(true);

    // Missing alias (real captured stderr text + nonzero exit).
    const missingFixture = fs.readFileSync(
      path.join(FIXTURE_DIR, "runtimes-status-missing-alias.stderr.txt"),
      "utf8",
    );
    const missingState = normalizeRuntimeStatus({
      exitCode: 1,
      stdout: "",
      stderr: missingFixture,
    });
    expect(missingState).toMatchObject({ state: expect.stringMatching(/missing|stopped|action-required/) });
    // The product state must not leak raw provider implementation details
    // (exit codes/argv) to UI/application callers.
    expect(JSON.stringify(missingState)).not.toContain("exitCode");

    // Structured JSON status normalizes to a stable, typed state set.
    const structured = normalizeRuntimeStatus({
      exitCode: 0,
      stdout: JSON.stringify({ alias: "workspace-lens", status: "running", health: "healthy" }),
      stderr: "",
    });
    expect(["ready", "healthy", "starting", "stopped", "unhealthy", "recovering", "problem"]).toContain(
      structured.state,
    );
  });

  it("CONN-002 constructs exact executable + argument arrays with no shell and no secret in argv", async () => {
    const { TunnelRuntimeAdapter } = await importExpected("tunnelRuntimeAdapter");
    const stubDir = fs.mkdtempSync(path.join(import.meta.dirname, "../fixtures/.stub-run-"));
    const logPath = path.join(stubDir, STUB_LOG);
    const scenarioPath = path.join(stubDir, "scenario.json");
    fs.writeFileSync(
      scenarioPath,
      JSON.stringify({
        responses: [{ exitCode: 0, stdout: JSON.stringify({ status: "running" }) }],
      }),
    );
    const stubPath = writeStubExecutable(stubDir, makeRecordingStub());
    const sentinelSecret = "CONN002_SENTINEL_SECRET_zz91";
    try {
      const adapter = new TunnelRuntimeAdapter({
        executable: stubPath,
        env: { WL_STUB_LOG: logPath, WL_STUB_SCENARIO: scenarioPath, WL_STUB_SEES_ENV: sentinelSecret },
      });
      // connect/status/stop/restart paths must each build exact argv arrays.
      await adapter.connect({
        alias: "workspace-lens",
        mcpServerUrl: "http://127.0.0.1:59999/mcp",
        runtimeApiKey: sentinelSecret,
      });
      await adapter.status("workspace-lens");
      await adapter.stop("workspace-lens");

      const invocations = JSON.parse(fs.readFileSync(logPath, "utf8")) as { argv: string[] }[];
      // No shell: the stub was executed directly with an argument array.
      expect(invocations.length).toBeGreaterThanOrEqual(3);
      for (const invocation of invocations) {
        expect(invocation.argv[0]).toBeDefined();
        // Forbidden: literal secret in argv.
        expect(invocation.argv.join(" ")).not.toContain(sentinelSecret);
      }
      // The secret is passed by env reference, not as a literal argument.
      const connectArgv = invocations[0]!.argv.join(" ");
      expect(connectArgv).toContain("--mcp-server-url");
      expect(connectArgv).toContain("env:");
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("CONN-003 bounds every external command failure into stable application errors", async () => {
    const { TunnelRuntimeAdapter } = await importExpected("tunnelRuntimeAdapter");
    const stubDir = fs.mkdtempSync(path.join(import.meta.dirname, "../fixtures/.stub-run-"));
    try {
      const cases: { name: string; responses: unknown[]; expectMatch: RegExp }[] = [
        { name: "nonzero exit", responses: [{ exitCode: 2, stderr: "boom" }], expectMatch: /fail|error|problem/i },
        { name: "malformed JSON", responses: [{ exitCode: 0, stdout: "{not json" }], expectMatch: /invalid|parse|unexpected/i },
        { name: "unhealthy runtime", responses: [{ exitCode: 0, stdout: JSON.stringify({ status: "unhealthy" }) }], expectMatch: /unhealthy|problem|action/i },
      ];
      for (const testCase of cases) {
        const logPath = path.join(stubDir, `${testCase.name.replace(/\W+/g, "-")}.json`);
        const scenarioPath = path.join(stubDir, `${testCase.name.replace(/\W+/g, "-")}.scenario.json`);
        fs.writeFileSync(scenarioPath, JSON.stringify({ responses: testCase.responses }));
        const stubPath = writeStubExecutable(stubDir, makeRecordingStub());
        const adapter = new TunnelRuntimeAdapter({
          executable: stubPath,
          env: { WL_STUB_LOG: logPath, WL_STUB_SCENARIO: scenarioPath },
        });
        await expect(adapter.status("workspace-lens")).rejects.toThrow(testCase.expectMatch);
      }

      // Binary missing: a nonexistent executable yields a stable dependency
      // error, not a raw spawn exception.
      const missing = new TunnelRuntimeAdapter({ executable: "/nonexistent/wl-stub" });
      await expect(missing.detect()).rejects.toThrow(/not.*found|missing|unavailable/i);

      // Alias missing: normalized per the captured fixture semantics.
      const logPath = path.join(stubDir, "alias-missing.json");
      const scenarioPath = path.join(stubDir, "alias-missing.scenario.json");
      fs.writeFileSync(
        scenarioPath,
        JSON.stringify({
          responses: [{ exitCode: 1, stderr: "alias workspace-lens is not known; run create or connect first" }],
        }),
      );
      const stubPath = writeStubExecutable(stubDir, makeRecordingStub());
      const adapter = new TunnelRuntimeAdapter({
        executable: stubPath,
        env: { WL_STUB_LOG: logPath, WL_STUB_SCENARIO: scenarioPath },
      });
      await expect(adapter.status("workspace-lens")).rejects.toThrow(/not known|missing|alias/i);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it("CONN-004 keeps the control plane alive when the tunnel fails", async () => {
    const { ConnectionService } = await importExpected("connectionService");
    const service = new ConnectionService({
      adapter: {
        status: async () => {
          throw new Error("tunnel runtime is unhealthy");
        },
      },
      controlRuntime: { baseUrl: "http://127.0.0.1:59998", isHealthy: async () => true },
      configStore: { load: () => ({ version: 1, expose_absolute_paths: false, workspaces: [] }) },
    });
    const state = await service.currentStatus();
    // Connection state becomes actionable, but the control plane stays up:
    // WebUI/Control API availability is asserted by HTTP-*/E2E-005 against
    // the real runtime; here the workspace configuration must remain intact.
    expect(state).toMatchObject({ state: expect.stringMatching(/unhealthy|problem|action-required/) });
    expect(state.workspaceConfigurationIntact).toBe(true);
  });

  it("CONN-005 keeps a single product connection as more workspaces are added", async () => {
    const { ConnectionService } = await importExpected("connectionService");
    let connectCalls = 0;
    const service = new ConnectionService({
      adapter: {
        status: async () => ({ alias: "workspace-lens", status: "running", health: "healthy" }),
        connect: async () => {
          connectCalls += 1;
          return { alias: "workspace-lens", status: "running" };
        },
      },
      controlRuntime: { baseUrl: "http://127.0.0.1:59997", isHealthy: async () => true },
    });
    // Adding a second and third workspace must not create another tunnel.
    await service.ensureConnectedForWorkspaces(["ws-one"]);
    await service.ensureConnectedForWorkspaces(["ws-one", "ws-two"]);
    await service.ensureConnectedForWorkspaces(["ws-one", "ws-two", "ws-three"]);
    expect(connectCalls).toBeLessThanOrEqual(1);
  });
});

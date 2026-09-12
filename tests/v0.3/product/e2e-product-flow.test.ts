import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";
import { cleanupWorkspace, makePlainWorkspace } from "../helpers/mcp.js";

/**
 * L4 — Product Flow / End-to-End Acceptance (`docs/v0.3-test-contract.md` §14):
 * E2E-001..007. These run against package-shaped artifacts and the v0.3
 * Control Runtime; both do not exist yet, so each contract is RED with its
 * specific missing capability. E2E-008 (real ChatGPT verification) is an
 * intentionally manual release gate and is documented in
 * tests/v0.3/product/MANUAL-E2E-008-chatgpt.md — it is never automated.
 */

const PACKAGE_MARKERS = ["dist/cli/index.js"];

async function requirePackageShape(): Promise<void> {
  // E2E must exercise the built package, not repository-relative dev
  // assumptions; the built CLI entry is the minimum package shape.
  await importExpected("controlRuntime");
  const { existsSync } = await import("node:fs");
  const { CLI_ENTRY } = await import("../helpers/spawn-cli.js");
  if (!existsSync(CLI_ENTRY)) {
    throw new Error("E2E BLOCKED: built CLI entry missing; run `npm run build` first.");
  }
}

describe("E2E — product flow acceptance (package-shaped)", () => {
  it("E2E-001 bootstraps from a clean temporary environment without repository assumptions", async () => {
    await requirePackageShape();
    const { runStart } = await importExpected("startCommand");
    // Package-shaped start from a working directory unrelated to the repo.
    const { spawnSync } = await import("node:child_process");
    const probe = spawnSync(process.execPath, ["-e", "process.exit(0)"], { cwd: "/tmp" });
    expect(probe.status).toBe(0);
    const result = await runStart({ cwd: "/tmp", browserLauncher: () => {} });
    expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1/);
    await (result.runtime?.stop?.() ?? Promise.resolve());
  });

  it("E2E-002 authorizes a first workspace and serves it over HTTP MCP", async () => {
    await requirePackageShape();
    const { runStart } = await importExpected("startCommand");
    const { WorkspaceAdminService } = await importExpected("workspaceAdminService");
    const workspace = makePlainWorkspace("e2e002");
    try {
      const started = await runStart({ browserLauncher: () => {} });
      const admin = new WorkspaceAdminService({ configPath: started.configPath });
      await admin.add({ root: workspace.root, id: "e2e002-a" });
      // MCP over HTTP sees A and answers a representative read.
      const response = await fetch(`${started.runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_list", arguments: {} } }),
      });
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("e2e002-a");
      await (started.runtime?.stop?.() ?? Promise.resolve());
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("E2E-003 makes a second workspace visible over MCP without any restart (release-blocking)", async () => {
    await requirePackageShape();
    const { runStart } = await importExpected("startCommand");
    const { WorkspaceAdminService } = await importExpected("workspaceAdminService");
    const workspaceA = makePlainWorkspace("e2e003a");
    const workspaceB = makePlainWorkspace("e2e003b");
    try {
      const started = await runStart({ browserLauncher: () => {} });
      const admin = new WorkspaceAdminService({ configPath: started.configPath });
      await admin.add({ root: workspaceA.root, id: "e2e003-a" });

      const callList = async (): Promise<string> => {
        const response = await fetch(`${started.runtime.baseUrl}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "workspace_list", arguments: {} } }),
        });
        return response.text();
      };
      expect(await callList()).toContain("e2e003-a");

      // Add B through the Control API path; do NOT restart the Control
      // Runtime and do NOT restart any tunnel adapter/runtime.
      await admin.add({ root: workspaceB.root, id: "e2e003-b" });

      const after = await callList();
      expect(after).toContain("e2e003-a");
      expect(after).toContain("e2e003-b");
      // The runtime process instance is the same one we started.
      expect(started.restarted ?? false).toBe(false);
      await (started.runtime?.stop?.() ?? Promise.resolve());
    } finally {
      cleanupWorkspace(workspaceA);
      cleanupWorkspace(workspaceB);
    }
  });

  it("E2E-004 reflects disable/remove on the next MCP call without stale authorization", async () => {
    await requirePackageShape();
    const { runStart } = await importExpected("startCommand");
    const { WorkspaceAdminService } = await importExpected("workspaceAdminService");
    const workspace = makePlainWorkspace("e2e004");
    try {
      const started = await runStart({ browserLauncher: () => {} });
      const admin = new WorkspaceAdminService({ configPath: started.configPath });
      await admin.add({ root: workspace.root, id: "e2e004-a" });
      await admin.disable("e2e004-a");
      const response = await fetch(`${started.runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "read_file", arguments: { workspace_id: "e2e004-a", path: "anything.txt" } },
        }),
      });
      const body = await response.text();
      expect(body).toContain("WORKSPACE_DISABLED");
      await (started.runtime?.stop?.() ?? Promise.resolve());
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("E2E-005 keeps the WebUI recoverable while the tunnel is unavailable", async () => {
    await requirePackageShape();
    const { runStart } = await importExpected("startCommand");
    const started = await runStart({
      browserLauncher: () => {},
      tunnelAdapter: { simulateState: "stopped" },
    });
    try {
      const webui = await fetch(`${started.runtime.baseUrl}/`);
      expect(webui.status).toBe(200);
      const health = await fetch(`${started.runtime.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      // The connection state is surfaced as actionable, not hidden.
      const connection = await fetch(`${started.runtime.baseUrl}/api/v1/connection`);
      expect(connection.status).toBe(200);
      expect(JSON.stringify(await connection.json())).toMatch(/action|stopped|unavailable|problem/i);
    } finally {
      await (started.runtime?.stop?.() ?? Promise.resolve());
    }
  });

  it("E2E-006 requires no additional WorkspaceLens CLI commands for daily operations", async () => {
    await requirePackageShape();
    const { runStart } = await importExpected("startCommand");
    const { WorkspaceAdminService } = await importExpected("workspaceAdminService");
    const workspace = makePlainWorkspace("e2e006");
    try {
      const started = await runStart({ browserLauncher: () => {} });
      // Daily operations through the API/service surface only: workspace
      // add/list/disable, diagnostics, settings. The harness records that no
      // additional WorkspaceLens CLI invocation is needed.
      const admin = new WorkspaceAdminService({ configPath: started.configPath });
      await admin.add({ root: workspace.root, id: "e2e006-a" });
      await admin.disable("e2e006-a");
      await admin.enable("e2e006-a");
      const cliInvocations = started.capturedCliInvocations ?? [];
      expect(cliInvocations).toEqual(["start"]);
      await (started.runtime?.stop?.() ?? Promise.resolve());
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("E2E-007 reconciles the startup command into a running runtime without embedding secrets", async () => {
    await requirePackageShape();
    const { StartupManager } = await importExpected("startupManager");
    const manager = new StartupManager({ platformAdapter: "test" });
    await manager.enable({ executable: process.execPath, args: ["start"] });
    const definition = await manager.buildDefinition({ executable: process.execPath, args: ["start"] });
    expect(JSON.stringify(definition)).not.toMatch(/SENTINEL|api[-_]?key|secret/i);
    // Simulate the user-session startup: the control runtime starts and, if
    // prerequisites exist, the desired connection is reconciled.
    const result = await manager.simulateUserSessionStart();
    expect(result.runtimeStarted).toBe(true);
  });
});

describe("E2E-008 — real ChatGPT verification (manual release gate)", () => {
  it("is documented as a manual gate and never automated", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const manualDoc = new URL("./MANUAL-E2E-008-chatgpt.md", import.meta.url);
    expect(existsSync(manualDoc)).toBe(true);
    const content = readFileSync(manualDoc, "utf8");
    // The manual checklist must exist and stay aligned with the contract.
    expect(content).toContain("workspace_list");
    expect(content).toContain("manual");
  });
});

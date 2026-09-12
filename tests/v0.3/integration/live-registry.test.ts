import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { makeTempRoot } from "../../helpers/fixtures.js";
import { importExpected } from "../helpers/expected-module.js";
import { callTool, cleanupWorkspace, makeConfig, makePlainWorkspace } from "../helpers/mcp.js";
import { spawnServe } from "../helpers/spawn-cli.js";

/**
 * Live Configuration contracts: LIVE-001..003
 * (`docs/v0.3-test-contract.md` §6).
 *
 * v0.2 builds a startup-only authorization snapshot, so adding, disabling,
 * or removing a workspace today requires a restart. These contracts bind the
 * v0.3 live registry semantics (Slice 2: no restart) and are RED until it
 * exists.
 *
 * Shape: the real `workspace-lens serve` process serves one stdio MCP client
 * over ONE connection (a restart would close it) while a workspace mutation
 * goes through the shared application service (`WorkspaceAdminService`) on
 * the same config file. The very next request must reflect the change. The
 * child process pid must be unchanged. The full Control Runtime-level PID
 * proof runs in E2E-003.
 *
 * Progressive RED: until Slice 0 lands `WorkspaceAdminService` the tests fail
 * on the missing module; afterwards they fail on the snapshot registry until
 * Slice 2 makes authorization live.
 */

async function makeAdmin(configPath: string) {
  const mod = await importExpected("workspaceAdminService");
  return new mod.WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
}

describe("LIVE — workspace changes visible without runtime restart", () => {
  it("LIVE-001 makes an added workspace visible to the next MCP request without restart", async () => {
    const { WorkspaceAdminService } = (await importExpected("workspaceAdminService")) as any;
    const workspaceA = makePlainWorkspace("live001a");
    const workspaceB = makePlainWorkspace("live001b");
    let handle: Awaited<ReturnType<typeof spawnServe>> | undefined;
    try {
      handle = await spawnServe(
        makeConfig([{ id: "live001-a", name: "live001a", root: workspaceA.root, enabled: true }]),
      );
      const pidBefore = handle.transport.pid;
      const before = await callTool(handle.client, "workspace_list", {});
      expect(JSON.stringify(before)).toContain("live001-a");
      expect(JSON.stringify(before)).not.toContain("live001-b");

      // Add B through the shared application service against the same config
      // file the serving process owns.
      const admin = new WorkspaceAdminService({ configStore: new ConfigStore(handle.configPath) });
      await admin.add({ root: workspaceB.root, id: "live001-b" });

      // The NEXT request over the SAME connection must contain B, with the
      // same serving process: no WorkspaceLens or tunnel restart.
      const after = await callTool(handle.client, "workspace_list", {});
      expect(JSON.stringify(after)).toContain("live001-a");
      expect(JSON.stringify(after)).toContain("live001-b");
      expect(handle.transport.pid).toBe(pidBefore);
    } finally {
      await handle?.close();
      cleanupWorkspace(workspaceA);
      cleanupWorkspace(workspaceB);
    }
  });

  it("LIVE-002 rejects a disabled workspace on the next MCP request without restart", async () => {
    const { WorkspaceAdminService } = (await importExpected("workspaceAdminService")) as any;
    const workspaceA = makePlainWorkspace("live002");
    let handle: Awaited<ReturnType<typeof spawnServe>> | undefined;
    try {
      handle = await spawnServe(
        makeConfig([{ id: "live002-a", name: "live002", root: workspaceA.root, enabled: true }]),
      );
      const pidBefore = handle.transport.pid;
      const admin = new WorkspaceAdminService({ configStore: new ConfigStore(handle.configPath) });
      await admin.disable("live002-a");

      const next = await callTool(handle.client, "read_file", {
        workspace_id: "live002-a",
        path: workspaceA.sentinelFile,
      });
      expect(next.isError).toBe(true);
      expect(JSON.stringify(next)).toContain("WORKSPACE_DISABLED");
      expect(handle.transport.pid).toBe(pidBefore);
    } finally {
      await handle?.close();
      cleanupWorkspace(workspaceA);
    }
  });

  it("LIVE-003 returns not-found for a removed workspace on the next MCP request", async () => {
    const { WorkspaceAdminService } = (await importExpected("workspaceAdminService")) as any;
    const workspaceA = makePlainWorkspace("live003");
    let handle: Awaited<ReturnType<typeof spawnServe>> | undefined;
    try {
      handle = await spawnServe(
        makeConfig([{ id: "live003-a", name: "live003", root: workspaceA.root, enabled: true }]),
      );
      const admin = new WorkspaceAdminService({ configStore: new ConfigStore(handle.configPath) });
      await admin.remove("live003-a");

      const next = await callTool(handle.client, "read_file", {
        workspace_id: "live003-a",
        path: workspaceA.sentinelFile,
      });
      // The stale in-memory authorization snapshot must not be used.
      expect(next.isError).toBe(true);
      expect(JSON.stringify(next)).toContain("WORKSPACE_NOT_FOUND");
    } finally {
      await handle?.close();
      cleanupWorkspace(workspaceA);
    }
  });
});

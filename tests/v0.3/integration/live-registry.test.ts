import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ConfigStore } from "../../../src/config/config-store.js";
import { LiveWorkspaceRegistry } from "../../../src/core/live-workspace-registry.js";
import { createToolContext, createWorkspaceLensServer } from "../../../src/mcp/server.js";
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

  it("keeps concurrent A/B requests isolated on the live registry path", async () => {
    const { WorkspaceAdminService } = (await importExpected("workspaceAdminService")) as any;
    const workspaceA = makePlainWorkspace("liveisoa");
    const workspaceB = makePlainWorkspace("liveisob");
    const configDir = makeTempRoot("wl-v03-liveiso-config-");
    const configPath = path.join(configDir, "config.json");
    let client: Client | undefined;
    let server: Awaited<ReturnType<typeof createWorkspaceLensServer>> | undefined;
    try {
      // Seed the on-disk config with A only; the registry resolves the
      // current config for every authorization decision.
      fs.writeFileSync(configPath, `${JSON.stringify(makeConfig([
        { id: "liveiso-a", name: "liveisoa", root: workspaceA.root, enabled: true },
      ]), null, 2)}\n`);

      const store = new ConfigStore(configPath);
      const registry = new LiveWorkspaceRegistry(() => store.load());
      server = createWorkspaceLensServer(createToolContext({ registry }));
      client = new Client({ name: "v0.3-live-iso-client", version: "0.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

      // B becomes visible through the live path (added via the shared service).
      const admin = new WorkspaceAdminService({ configStore: store });
      await admin.add({ root: workspaceB.root, id: "liveiso-b" });

      // Concurrent content requests against A and B must not cross.
      const [readA, readB, listB] = await Promise.all([
        callTool(client, "read_file", { workspace_id: "liveiso-a", path: workspaceA.sentinelFile }),
        callTool(client, "read_file", { workspace_id: "liveiso-b", path: workspaceB.sentinelFile }),
        callTool(client, "list_files", { workspace_id: "liveiso-b" }),
      ]);
      expect(readA.isError).toBeFalsy();
      expect(JSON.stringify(readA)).toContain(workspaceA.sentinelContent);
      expect(JSON.stringify(readA)).not.toContain(workspaceB.sentinelContent);
      expect(JSON.stringify(readB)).toContain(workspaceB.sentinelContent);
      expect(JSON.stringify(readB)).not.toContain(workspaceA.sentinelContent);
      expect(JSON.stringify(listB)).not.toContain(workspaceA.sentinelContent);

      // Disabling A is immediately observable; the concurrent B request is
      // unaffected and A never falls through to B or any other workspace.
      await admin.disable("liveiso-a");
      const [disabledA, stillB] = await Promise.all([
        callTool(client, "read_file", { workspace_id: "liveiso-a", path: workspaceA.sentinelFile }),
        callTool(client, "read_file", { workspace_id: "liveiso-b", path: workspaceB.sentinelFile }),
      ]);
      expect(disabledA.isError).toBe(true);
      expect(JSON.stringify(disabledA)).toContain("WORKSPACE_DISABLED");
      expect(JSON.stringify(disabledA)).not.toContain(workspaceB.sentinelContent);
      expect(stillB.isError).toBeFalsy();
      expect(JSON.stringify(stillB)).toContain(workspaceB.sentinelContent);
    } finally {
      await client?.close();
      await server?.close().catch(() => undefined);
      cleanupWorkspace(workspaceA);
      cleanupWorkspace(workspaceB);
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { WorkspaceAdminService } from "../../../src/application/workspace-admin-service.js";
import { listToolNames } from "../helpers/mcp.js";
import {
  assertNoRealUserState,
  createIsolatedProductEnv,
  type IsolatedProductEnv,
} from "../helpers/isolated-env.js";
import { spawnProductChild, type ProductChild } from "../helpers/spawn-product-child.js";
import { writeTree } from "../../helpers/fixtures.js";
import { cleanupWorkspace, makePlainWorkspace } from "../helpers/mcp.js";

/**
 * Slice 4 — read-only MCP over the Control Runtime's loopback HTTP endpoint
 * (`docs/v0.3-implementation-plan.md` §8 Tests).
 *
 * Evidence runs against the REAL product runtime (dedicated child process in
 * the isolated product env) and a real MCP Streamable HTTP client — not an
 * in-process shortcut. Ownership of the stdio surface is unchanged (REG-003
 * keeps `workspace-lens serve` green); these tests prove the HTTP surface:
 * identical ten-tool contract, representative reads, concurrent A/B
 * isolation, live per-request authorization (disable without restart), and
 * fail-closed behavior on a malformed current config.
 */

async function withRuntime(
  tag: string,
  run: (child: ProductChild, env: IsolatedProductEnv) => Promise<void>,
): Promise<void> {
  const env = createIsolatedProductEnv(tag);
  let child: ProductChild | undefined;
  try {
    assertNoRealUserState(env);
    child = await spawnProductChild(env, { entry: "control" });
    await run(child, env);
  } finally {
    await child?.stop();
    env.cleanup();
  }
}

async function connectMcpHttp(url: string): Promise<Client> {
  const client = new Client({ name: "v0.3-mcp-http-contract-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`));
  await client.connect(transport);
  return client;
}

describe("MCP HTTP — read-only tools over the Control Runtime", () => {
  it("exposes the same ten-tool surface and serves representative reads over HTTP", async () => {
    await withRuntime("mcphttp-surface", async (child, env) => {
      const workspace = makePlainWorkspace("mcphttp");
      writeTree(workspace.root, { "notes.md": "mcphttp readable content" });
      try {
        // Authorize the workspace through the shared admin service on the
        // SAME config file the runtime serves (configPath via env).
        const admin = new WorkspaceAdminService({
          configStore: new ConfigStore(env.configPath),
        });
        await admin.add({ root: workspace.root, id: "mcphttp-ws", name: "mcphttp" });

        const client = await connectMcpHttp(child.url);
        try {
          const names = await listToolNames(client);
          expect(names).toEqual([
            "git_commit",
            "git_compare",
            "git_diff",
            "git_history",
            "git_status",
            "list_files",
            "read_file",
            "search_workspace",
            "workspace_info",
            "workspace_list",
          ]);

          const list = await client.callTool({ name: "workspace_list", arguments: {} });
          expect(list.isError).toBeFalsy();
          expect(JSON.stringify(list)).toContain("mcphttp-ws");

          const read = await client.callTool({
            name: "read_file",
            arguments: { workspace_id: "mcphttp-ws", path: "notes.md" },
          });
          expect(read.isError).toBeFalsy();
          expect(JSON.stringify(read)).toContain("mcphttp readable content");
        } finally {
          await client.close();
        }
      } finally {
        cleanupWorkspace(workspace);
      }
    });
  });

  it("keeps concurrent A/B workspace reads isolated over HTTP", async () => {
    await withRuntime("mcphttp-iso", async (child, env) => {
      const workspaceA = makePlainWorkspace("mcpisoa");
      const workspaceB = makePlainWorkspace("mcpisob");
      try {
        const admin = new WorkspaceAdminService({
          configStore: new ConfigStore(env.configPath),
        });
        await admin.add({ root: workspaceA.root, id: "mcpiso-a", name: "a" });
        await admin.add({ root: workspaceB.root, id: "mcpiso-b", name: "b" });

        const client = await connectMcpHttp(child.url);
        try {
          const [readA, readB] = await Promise.all([
            client.callTool({
              name: "read_file",
              arguments: { workspace_id: "mcpiso-a", path: workspaceA.sentinelFile },
            }),
            client.callTool({
              name: "read_file",
              arguments: { workspace_id: "mcpiso-b", path: workspaceB.sentinelFile },
            }),
          ]);
          expect(readA.isError).toBeFalsy();
          expect(readB.isError).toBeFalsy();
          expect(JSON.stringify(readA)).toContain(workspaceA.sentinelContent);
          expect(JSON.stringify(readA)).not.toContain(workspaceB.sentinelContent);
          expect(JSON.stringify(readB)).toContain(workspaceB.sentinelContent);
          expect(JSON.stringify(readB)).not.toContain(workspaceA.sentinelContent);
        } finally {
          await client.close();
        }
      } finally {
        cleanupWorkspace(workspaceA);
        cleanupWorkspace(workspaceB);
      }
    });
  });

  it("makes a disable visible on the next HTTP request without a runtime restart", async () => {
    await withRuntime("mcphttp-live", async (child, env) => {
      const workspace = makePlainWorkspace("mcplive");
      try {
        const admin = new WorkspaceAdminService({
          configStore: new ConfigStore(env.configPath),
        });
        await admin.add({ root: workspace.root, id: "mcplive-ws", name: "live" });

        const client = await connectMcpHttp(child.url);
        try {
          const before = await client.callTool({
            name: "read_file",
            arguments: { workspace_id: "mcplive-ws", path: workspace.sentinelFile },
          });
          expect(before.isError).toBeFalsy();

          // Disable through the shared application service while the runtime
          // keeps serving: the NEXT request must reject as disabled.
          await admin.disable("mcplive-ws");
          const after = await client.callTool({
            name: "read_file",
            arguments: { workspace_id: "mcplive-ws", path: workspace.sentinelFile },
          });
          expect(after.isError).toBe(true);
          expect(JSON.stringify(after)).toContain("WORKSPACE_DISABLED");

          // Re-enable: live again on the next request.
          await admin.enable("mcplive-ws");
          const restored = await client.callTool({
            name: "read_file",
            arguments: { workspace_id: "mcplive-ws", path: workspace.sentinelFile },
          });
          expect(restored.isError).toBeFalsy();
        } finally {
          await client.close();
        }
      } finally {
        cleanupWorkspace(workspace);
      }
    });
  });

  it("fails closed on a malformed current config and recovers without a restart", async () => {
    await withRuntime("mcphttp-failclosed", async (child, env) => {
      const workspace = makePlainWorkspace("mcpfail");
      try {
        const admin = new WorkspaceAdminService({
          configStore: new ConfigStore(env.configPath),
        });
        await admin.add({ root: workspace.root, id: "mcpfail-ws", name: "fail" });

        const client = await connectMcpHttp(child.url);
        try {
          const healthy = await client.callTool({ name: "workspace_list", arguments: {} });
          expect(healthy.isError).toBeFalsy();

          // Corrupt the current config: the next request must fail closed —
          // a stable failure, never a stale (broader) authorization snapshot.
          fs.writeFileSync(env.configPath, "{ malformed", { mode: 0o600 });
          const degraded = await client.callTool({ name: "workspace_list", arguments: {} });
          expect(degraded.isError).toBe(true);
          expect(JSON.stringify(degraded)).not.toContain("mcpfail-ws");

          // Repair the config: the next request serves again, same process.
          fs.writeFileSync(
            env.configPath,
            `${JSON.stringify(
              {
                version: 1,
                expose_absolute_paths: false,
                workspaces: [
                  {
                    workspace_id: "mcpfail-ws",
                    name: "fail",
                    root: workspace.root,
                    enabled: true,
                  },
                ],
              },
              null,
              2,
            )}\n`,
            { mode: 0o600 },
          );
          const recovered = await client.callTool({ name: "workspace_list", arguments: {} });
          expect(recovered.isError).toBeFalsy();
          expect(JSON.stringify(recovered)).toContain("mcpfail-ws");
        } finally {
          await client.close();
        }
      } finally {
        cleanupWorkspace(workspace);
      }
    });
  });
});

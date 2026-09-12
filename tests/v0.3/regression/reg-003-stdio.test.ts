import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupWorkspace, makeConfig, makePlainWorkspace } from "../helpers/mcp.js";
import { CLI_ENTRY, REPO_ROOT_V03, spawnServe } from "../helpers/spawn-cli.js";

const REPO_ROOT = REPO_ROOT_V03;

/**
 * REG-003 — stdio remains supported
 * (`docs/v0.3-test-contract.md` §4).
 *
 * Invokes the existing stdio MCP path (`workspace-lens serve`) as a real
 * child process and proves the local MCP behavior still works end to end
 * after the Control Runtime / HTTP path is introduced in v0.3.
 */
describe("REG-003 stdio remains supported", () => {
  it("serves the MCP contract over real stdio from the packaged CLI entry", async () => {
    const workspace = makePlainWorkspace("reg003");
    let handle: Awaited<ReturnType<typeof spawnServe>> | undefined;
    try {
      handle = await spawnServe(
        makeConfig([{ id: "reg003-ws", name: "reg003", root: workspace.root, enabled: true }]),
      );

      const serverInfo = handle.client.getServerVersion();
      expect(serverInfo?.name).toBe("workspace-lens");

      const tools = await handle.client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toContain("workspace_list");
      expect(names).toContain("read_file");

      const list = await handle.client.callTool({ name: "workspace_list", arguments: {} });
      expect(list.isError).toBeFalsy();
      expect(JSON.stringify(list)).toContain("reg003-ws");

      const read = await handle.client.callTool({
        name: "read_file",
        arguments: { workspace_id: "reg003-ws", path: workspace.sentinelFile },
      });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read)).toContain(workspace.sentinelContent);
    } finally {
      await handle?.close();
      cleanupWorkspace(workspace);
    }
  });

  it("keeps stdio failing closed on a malformed config", async () => {
    const configDir = fs.mkdtempSync(path.join(REPO_ROOT, "node_modules/.tmp-wl-v03-"));
    const configPath = path.join(configDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        expose_absolute_paths: false,
        workspaces: [{ workspace_id: "bad id with spaces", name: "bad", root: "/tmp/whatever", enabled: true }],
      }),
    );
    // The server must refuse to start rather than serve a broken config.
    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_ENTRY, "serve"], {
        env: { ...process.env, WORKSPACE_LENS_CONFIG: configPath },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("exit", (code) => resolve(code ?? -1));
      child.on("error", reject);
    });
    expect(exitCode).toBe(1);
    fs.rmSync(configDir, { recursive: true, force: true });
  });
});

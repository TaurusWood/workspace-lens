import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { writeTree } from "../helpers/fixtures.js";

/**
 * Phase 9 runtime lifecycle: the built CLI serves the full MCP contract on
 * stdio as a foreground process, the gate0 server answers over stdio, and a
 * malformed config fails safely with a clear error.
 */
describe("serve runtime lifecycle (built CLI)", () => {
  const cliPath = path.resolve("dist/cli/index.js");
  const gate0Path = path.resolve("dist/gate0/connection-test-server.js");

  beforeAll(() => {
    // Tests must pass from a clean checkout: build when dist is missing or
    // older than any source file.
    if (distIsMissingOrStale()) {
      execFileSync("npm", ["run", "build", "-s"], { cwd: path.resolve(".") });
    }
  });

  function distIsMissingOrStale(): boolean {
    if (!fs.existsSync(cliPath) || !fs.existsSync(gate0Path)) {
      return true;
    }
    const distTime = fs.statSync(cliPath).mtimeMs;
    let newestSource = 0;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
        } else if (entry.name.endsWith(".ts")) {
          newestSource = Math.max(newestSource, fs.statSync(absolute).mtimeMs);
        }
      }
    };
    walk(path.resolve("src"));
    return newestSource > distTime;
  }

  describe("serve command", () => {
    let scratch: string;
    let configPath: string;

    beforeAll(() => {
      scratch = fs.realpathSync(
        fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "wl-runtime-")),
      );
      configPath = path.join(scratch, "config.json");
      const workspace = path.join(scratch, "proj");
      writeTree(workspace, { "hello.txt": "hello workspace\n" });
      execFileSync("node", [cliPath, "add", workspace], {
        env: { ...process.env, WORKSPACE_LENS_CONFIG: configPath },
      });
    });

    afterAll(() => {
      fs.rmSync(scratch, { recursive: true, force: true });
    });

    it("serves the full tool contract over stdio and answers tool calls", async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath, "serve"],
        env: { ...process.env, WORKSPACE_LENS_CONFIG: configPath } as Record<string, string>,
      });
      const client = new Client({ name: "runtime-test", version: "0.0.0" });
      try {
        await client.connect(transport);

        const tools = await client.listTools();
        expect(tools.tools).toHaveLength(7);

        const list = (await client.callTool({
          name: "workspace_list",
          arguments: {},
        })) as CallToolResult;
        const first = list.content[0]!;
        const envelope = JSON.parse(first.type === "text" ? first.text : "{}") as {
          ok: boolean;
          data: { workspaces: Array<{ workspace_id: string }> };
        };
        expect(envelope.ok).toBe(true);
        expect(envelope.data.workspaces[0]!.workspace_id).toBe("proj");

        const read = (await client.callTool({
          name: "read_file",
          arguments: { workspace_id: "proj", path: "hello.txt" },
        })) as CallToolResult;
        const readFirst = read.content[0]!;
        const readEnvelope = JSON.parse(readFirst.type === "text" ? readFirst.text : "{}") as {
          ok: boolean;
          data: { content: string };
        };
        expect(readEnvelope.data.content).toBe("hello workspace");
      } finally {
        await client.close();
      }
    });

    it("exits with a clear error for a malformed config", async () => {
      const badConfig = path.join(scratch, "bad.json");
      fs.writeFileSync(badConfig, "{ not json");
      let stderr = "";
      const exitCode = await new Promise<number | null>((resolve) => {
        const child = spawn(process.execPath, [cliPath, "serve"], {
          env: { ...process.env, WORKSPACE_LENS_CONFIG: badConfig } as NodeJS.ProcessEnv,
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("exit", (code) => resolve(code));
      });
      expect(exitCode).toBe(1);
      expect(stderr).toContain("error:");
    });
  });

  describe("gate0 connection-test server", () => {
    it("answers over stdio for the ChatGPT connection path", async () => {
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [gate0Path],
      });
      const client = new Client({ name: "gate0-test", version: "0.0.0" });
      try {
        await client.connect(transport);
        const result = (await client.callTool({
          name: "workspace_list",
          arguments: {},
        })) as CallToolResult;
        expect(result.isError).toBeFalsy();
      } finally {
        await client.close();
      }
    });
  });
});

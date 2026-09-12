import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { WorkspaceLensConfig } from "../../../src/config/config-schema.js";
import { WorkspaceRegistry } from "../../../src/core/workspace-registry.js";
import type { Logger } from "../../../src/core/logger.js";
import { createToolContext, createWorkspaceLensServer } from "../../../src/mcp/server.js";
import { cleanupWorkspace, makeConfig, makePlainWorkspace, type WorkspaceFixture } from "../helpers/mcp.js";
import { spawnServe } from "../helpers/spawn-cli.js";

const SILENT_LOGGER: Logger = {
  toolCall: () => {},
  event: () => {},
  error: () => {},
};

/**
 * GATE-A — Streamable HTTP MCP parity
 * (`docs/v0.3-test-contract.md` §7; `docs/v0.3-implementation-plan.md` §3 Gate A).
 *
 * Question: can the accepted MCP SDK/runtime expose the existing WorkspaceLens
 * tool contract through a loopback Streamable HTTP endpoint without changing
 * Core/tool semantics — and without migrating MCP SDK major versions?
 *
 * The harness mounts the real `createWorkspaceLensServer` factory (the same
 * server used by `workspace-lens serve`) behind the SDK's stateless
 * Streamable HTTP transport. Nothing here is production implementation; it is
 * the spike the implementation plan retains as an integration test.
 */

/** Minimal stateless Streamable HTTP transport bridge over node:http. */
class HttpMcpTestServer {
  private httpServer: Server | undefined;
  private readonly transports: StreamableHTTPServerTransport[] = [];
  private readonly servers: McpServer[] = [];
  url = "";

  constructor(
    private readonly config: WorkspaceLensConfig,
    private readonly onToolCall?: (toolName: string) => void,
  ) {}

  async start(): Promise<void> {
    const httpServer = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    this.httpServer = httpServer;
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", () => resolve());
    });
    const address = httpServer.address() as AddressInfo;
    this.url = `http://127.0.0.1:${address.port}/mcp`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || req.url !== "/mcp") {
      res.writeHead(405).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(400).end();
      return;
    }
    // Stateless mode: a fresh transport + server instance per request, built
    // from the same public factory the stdio path uses.
    const registry = new WorkspaceRegistry(this.config);
    const server = createWorkspaceLensServer(
      createToolContext({ registry, logger: SILENT_LOGGER }),
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    this.transports.push(transport);
    this.servers.push(server);
    await server.connect(transport);
    await transport.handleRequest(req, res, parsedBody);
  }

  async stop(): Promise<void> {
    for (const transport of this.transports) {
      await transport.close().catch(() => {});
    }
    for (const server of this.servers) {
      await server.close().catch(() => {});
    }
    await new Promise<void>((resolve, reject) => {
      this.httpServer?.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function connectHttpClient(url: string): Promise<Client> {
  const client = new Client({ name: "v0.3-gate-a-http-client", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url));
  await client.connect(transport);
  return client;
}

describe("GATE-A Streamable HTTP MCP parity", () => {
  let workspace: WorkspaceFixture;
  let httpMcp: HttpMcpTestServer;

  beforeAll(async () => {
    workspace = makePlainWorkspace("gate-a");
    httpMcp = new HttpMcpTestServer(
      makeConfig([{ id: "gate-a-ws", name: "gate-a", root: workspace.root, enabled: true }]),
    );
    await httpMcp.start();
  });

  afterAll(async () => {
    await httpMcp.stop();
    cleanupWorkspace(workspace);
  });

  it("GATE-A-1 completes a minimal HTTP MCP round trip with list + content tool", async () => {
    const client = await connectHttpClient(httpMcp.url);
    try {
      const tools = await client.listTools();
      const names = tools.tools.map((tool) => tool.name).sort();
      expect(names).toContain("workspace_list");
      expect(names).toContain("read_file");

      const list = await client.callTool({ name: "workspace_list", arguments: {} });
      expect(list.isError).toBeFalsy();
      expect(JSON.stringify(list)).toContain("gate-a-ws");

      const read = await client.callTool({
        name: "read_file",
        arguments: { workspace_id: "gate-a-ws", path: workspace.sentinelFile },
      });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read)).toContain(workspace.sentinelContent);
    } finally {
      await client.close();
    }
  });

  it("GATE-A-2 keeps stdio/HTTP semantic parity for representative operations", async () => {
    // stdio side: the REAL `workspace-lens serve` child process (the exact
    // stdio transport product clients use), pinned to the same workspace
    // fixture via an isolated config.
    const config = makeConfig([{ id: "gate-a-ws", name: "gate-a", root: workspace.root, enabled: true }]);
    const serve = await spawnServe(config);
    const httpClient = await connectHttpClient(httpMcp.url);
    try {
      // Representative operation set: list, one filesystem read, one Git
      // operation, one stable error case.
      const operations: { name: string; args: Record<string, unknown> }[] = [
        { name: "workspace_list", args: {} },
        { name: "read_file", args: { workspace_id: "gate-a-ws", path: workspace.sentinelFile } },
        { name: "git_status", args: { workspace_id: "gate-a-ws" } },
        { name: "read_file", args: { workspace_id: "gate-a-ws", path: "does/not/exist.txt" } },
      ];
      for (const operation of operations) {
        const viaStdio = await serve.client.callTool({ name: operation.name, arguments: operation.args });
        const viaHttp = await httpClient.callTool({ name: operation.name, arguments: operation.args });
        // Meaningful structured results must not fork between transports:
        // same error/success outcome, same payload content.
        expect(viaHttp.isError).toBe(viaStdio.isError);
        expect(JSON.stringify(viaHttp)).toBe(JSON.stringify(viaStdio));
      }
    } finally {
      await httpClient.close();
      await serve.close();
    }
  });

  it("GATE-A-3 proves stateless/request isolation across concurrent HTTP calls", async () => {
    const second = makePlainWorkspace("gate-a-b");
    try {
      const config = makeConfig([
        { id: "gate-a-ws", name: "gate-a", root: workspace.root, enabled: true },
        { id: "gate-a-b-ws", name: "gate-a-b", root: second.root, enabled: true },
      ]);
      const concurrent = new HttpMcpTestServer(config);
      await concurrent.start();
      const client = await connectHttpClient(concurrent.url);
      try {
        const [listA, readB, listB, readA] = await Promise.all([
          client.callTool({ name: "workspace_list", arguments: {} }),
          client.callTool({
            name: "read_file",
            arguments: { workspace_id: "gate-a-b-ws", path: second.sentinelFile },
          }),
          client.callTool({ name: "workspace_list", arguments: {} }),
          client.callTool({
            name: "read_file",
            arguments: { workspace_id: "gate-a-ws", path: workspace.sentinelFile },
          }),
        ]);
        expect(listA.isError).toBeFalsy();
        expect(listB.isError).toBeFalsy();
        expect(readA.isError).toBeFalsy();
        expect(readB.isError).toBeFalsy();
        // No protocol/session requirement forced a shared "current workspace":
        // each concurrent request resolved its own explicit workspace id.
        expect(JSON.stringify(readA)).toContain(workspace.sentinelContent);
        expect(JSON.stringify(readB)).toContain(second.sentinelContent);
        expect(JSON.stringify(readA)).not.toContain(second.sentinelContent);
        expect(JSON.stringify(readB)).not.toContain(workspace.sentinelContent);
      } finally {
        await client.close();
        await concurrent.stop();
      }
    } finally {
      cleanupWorkspace(second);
    }
  });
});

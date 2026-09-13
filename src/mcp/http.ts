/**
 * Read-only Streamable HTTP MCP adapter (`docs/v0.3-implementation-plan.md` §8).
 *
 * Mounts the SAME public server factory the stdio path uses
 * (`createWorkspaceLensServer`) behind the SDK's stateless Streamable HTTP
 * transport — one fresh transport + server instance per request, so there is
 * no session state and no shared mutable workspace context:
 *
 * - request-scoped authorization: each request builds a
 *   `LiveWorkspaceRegistry` over the CURRENT config; the tool runner resolves
 *   the snapshot once per request and a malformed config fails closed;
 * - no administration capability exists on the MCP surface by construction
 *   (the tool list is the frozen ten-tool read-only contract);
 * - bounded observability only: active-request count and last-request
 *   timestamp are reported to the runtime's in-memory state, never persisted.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ConfigStore } from "../config/config-store.js";
import { LiveWorkspaceRegistry } from "../core/live-workspace-registry.js";
import { StderrLogger, type Logger } from "../core/logger.js";
import { createToolContext, createWorkspaceLensServer } from "./server.js";

export interface McpHttpMetrics {
  /** Requests currently executing through this bridge. */
  activeRequests: number;
  /** Epoch ms of the last accepted POST, or null. */
  lastRequestAt: number | null;
}

export interface McpHttpBridge {
  handlePost(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void>;
  metrics: McpHttpMetrics;
}

export interface McpHttpBridgeOptions {
  configPath: string;
  logger?: Logger;
}

/**
 * Hard cap on one MCP request body, enforced by counting ACTUAL bytes read
 * from the raw Node request — not by trusting a Content-Length header. This
 * is the security-contract body bound for the raw `/mcp` surface: an
 * oversized or chunked body is rejected before the SDK transport ever sees
 * it, and the connection is torn down.
 */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;

async function readBoundedBody(incoming: IncomingMessage): Promise<
  { ok: true; body: Buffer } | { ok: false; reason: "too-large" | "aborted" }
> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: { ok: true; body: Buffer } | { ok: false; reason: "too-large" | "aborted" }): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    incoming.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_MCP_BODY_BYTES) {
        incoming.destroy();
        finish({ ok: false, reason: "too-large" });
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    incoming.on("error", () => finish({ ok: false, reason: "aborted" }));
    incoming.on("close", () => {
      if (!incoming.readableEnded) {
        finish({ ok: false, reason: "aborted" });
      }
    });
  });
}

export function createMcpHttpBridge(options: McpHttpBridgeOptions): McpHttpBridge {
  const logger = options.logger ?? new StderrLogger();
  const metrics: McpHttpMetrics = { activeRequests: 0, lastRequestAt: null };
  const openServers: McpServer[] = [];

  return {
    metrics,
    async handlePost(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
      metrics.activeRequests += 1;
      metrics.lastRequestAt = Date.now();
      try {
        // Bounded body read BEFORE anything touches the payload: an
        // oversized/chunked body is rejected with a stable JSON-RPC envelope
        // and the socket is destroyed (no unbounded buffering).
        const body = await readBoundedBody(incoming);
        if (!body.ok) {
          if (!outgoing.headersSent) {
            outgoing.writeHead(413, { "content-type": "application/json" });
            outgoing.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: null,
                error: { code: -32000, message: "Request body exceeds the accepted size." },
              }),
            );
          }
          return;
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(body.body.toString("utf8"));
        } catch {
          outgoing.writeHead(400, { "content-type": "application/json" });
          outgoing.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error: request body is not valid JSON." },
            }),
          );
          return;
        }
        // Negotiation normalization: the SDK transport requires the Streamable
        // HTTP Accept pair; clients that omit it (raw HTTP probes) get the same
        // JSON-RPC semantics instead of a protocol-level rejection. This only
        // completes content negotiation — it never widens capabilities.
        const accept = incoming.headers.accept;
        const acceptValue = Array.isArray(accept) ? accept.join(", ") : accept;
        if (acceptValue === undefined || !acceptValue.includes("application/json")) {
          incoming.headers.accept = "application/json, text/event-stream";
        }
        // Stateless mode: a fresh transport + server per request, built from the
        // same public factory the stdio path uses (GATE-A parity evidence).
        // JSON responses only: stateless requests have no session stream, and
        // every conforming client accepts application/json.
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
          enableJsonResponse: true,
        });
        const registry = new LiveWorkspaceRegistry(() => new ConfigStore(options.configPath).load());
        const server = createWorkspaceLensServer(createToolContext({ registry, logger }));
        openServers.push(server);
        try {
          await server.connect(transport);
          await transport.handleRequest(incoming, outgoing, parsedBody);
        } finally {
          openServers.splice(openServers.indexOf(server), 1);
          await server.close().catch(() => undefined);
        }
      } finally {
        metrics.activeRequests -= 1;
      }
    },
  };
}

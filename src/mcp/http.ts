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

export function createMcpHttpBridge(options: McpHttpBridgeOptions): McpHttpBridge {
  const logger = options.logger ?? new StderrLogger();
  const metrics: McpHttpMetrics = { activeRequests: 0, lastRequestAt: null };
  const openServers: McpServer[] = [];

  return {
    metrics,
    async handlePost(incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> {
      metrics.activeRequests += 1;
      metrics.lastRequestAt = Date.now();
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
        // The SDK collects and parses the body itself, answering parse errors
        // with the proper JSON-RPC error envelope.
        await transport.handleRequest(incoming, outgoing);
      } finally {
        metrics.activeRequests -= 1;
        openServers.splice(openServers.indexOf(server), 1);
        await server.close().catch(() => undefined);
      }
    },
  };
}

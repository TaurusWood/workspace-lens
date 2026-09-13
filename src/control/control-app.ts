/**
 * Control Runtime HTTP application (`docs/v0.3-technical-architecture-rfc.md` §4/§5).
 *
 * Slice 3 surface: `/healthz`, `/readyz`, the packaged WebUI asset seam, and
 * a bounded placeholder for `/mcp` (the read-only Streamable HTTP endpoint
 * lands in Slice 4). No privileged mutation routes exist yet.
 *
 * Security baseline (required BEFORE any privileged route can be added later,
 * `docs/v0.3-control-plane-security-contract.md` §3/§4/§20):
 * - the listener is bound loopback-only (enforced by the runtime, which never
 *   accepts a host option);
 * - the effective Host/authority is validated on every request — unexpected
 *   hosts are rejected before routing (DNS-rebinding protection);
 * - restrictive default headers on every response;
 * - request body size is bounded before unbounded processing.
 */
import { Hono } from "hono";
import { ConfigStore } from "../config/config-store.js";
import { createPackagedUiAssetResolver, type UiAssetResolver } from "./static-assets.js";

/** Default request body cap until the Control API slice tunes per-route DTOs. */
const MAX_BODY_BYTES = 1024 * 1024;

export interface ControlAppOptions {
  instanceId: string;
  configPath: string;
  assetResolver?: UiAssetResolver;
}

export function createControlApp(options: ControlAppOptions): Hono {
  const app = new Hono();
  const assets = options.assetResolver ?? createPackagedUiAssetResolver();

  // Security baseline: Host/authority validation before any routing.
  app.use("*", async (context, next) => {
    const host = context.req.header("host") ?? "";
    if (!isLoopbackHost(host)) {
      return context.json(
        { error: { code: "HOST_REJECTED", message: "Unexpected Host header." } },
        403,
      );
    }
    await next();
  });

  // Security baseline: restrictive default headers on every response.
  app.use("*", async (context, next) => {
    await next();
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
  });

  // Security baseline: bounded request bodies before unbounded processing.
  app.use("*", async (context, next) => {
    const contentLength = Number(context.req.header("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return context.json(
        {
          error: {
            code: "BODY_TOO_LARGE",
            message: "Request body exceeds the accepted size.",
          },
        },
        413,
      );
    }
    await next();
  });

  app.get("/healthz", (context) =>
    context.json({ status: "ok", runtime_instance_id: options.instanceId }),
  );

  app.get("/readyz", (context) => {
    // Ready means: serving AND the workspace authorization config currently
    // loads. A malformed config must never present this runtime as ready.
    try {
      new ConfigStore(options.configPath).load();
      return context.json({ status: "ok" });
    } catch {
      return context.json(
        {
          status: "degraded",
          reason: "workspace configuration is malformed or unreadable",
        },
        503,
      );
    }
  });

  app.get("/", (context) => {
    const asset = assets.resolve("/");
    return context.newResponse(asset.body, asset.status, { "Content-Type": asset.contentType });
  });
  app.get("/assets/:name", (context) => {
    const asset = assets.resolve(`/assets/${context.req.param("name")}`);
    return context.newResponse(asset.body, asset.status, { "Content-Type": asset.contentType });
  });

  // Placeholder until Slice 4 mounts the read-only Streamable HTTP MCP
  // endpoint here. Bounded JSON, no capability leak-through.
  app.all("/mcp", (context) =>
    context.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32601,
          message: "Method not found: MCP over HTTP is not available in this runtime build.",
        },
      },
      404,
    ),
  );

  // No privileged Control API routes exist yet (Slice 8); nothing falls
  // through from other surfaces.
  app.all("/api/v1/*", (context) =>
    context.json(
      { error: { code: "NOT_FOUND", message: "No such Control API route." } },
      404,
    ),
  );

  return app;
}

/**
 * The Host contract is limited to the loopback host forms for the configured
 * local port (`docs/v0.3-control-plane-security-contract.md` §4). Slice 7
 * narrows this further to the exact bound port.
 */
function isLoopbackHost(host: string): boolean {
  return /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host);
}

/**
 * Control Runtime HTTP application (`docs/v0.3-technical-architecture-rfc.md` §4/§5,
 * `docs/v0.3-control-plane-security-contract.md`).
 *
 * Surfaces (one listener, strictly separated capabilities):
 * - `/healthz`, `/readyz`: local liveness/readiness;
 * - `/`, `/assets/*`: packaged WebUI assets (module-relative);
 * - `/mcp`: read-only Streamable HTTP MCP (no administration capability);
 * - `/api/v1/*`: privileged Control API behind the browser-session gate.
 *
 * Security controls (normative: security contract §4-§9):
 * - loopback-only binding is enforced by the runtime (never an option);
 * - Host/authority validation BEFORE any routing (DNS rebinding);
 * - browser session gate on /api/v1/*: valid `wl_session` cookie required
 *   (401 otherwise); every mutation additionally requires the EXACT runtime
 *   Origin (403) and a per-session CSRF token (403) — variables are checked
 *   independently so no single-header implementation passes;
 * - no wildcard CORS and no CORS reflection on any privileged surface;
 * - restrictive CSP and frame denial on every response;
 * - bounded request bodies before unbounded processing;
 * - Zod DTO validation at the boundary with bounded product errors;
 * - GET routes never mutate (mutation verbs are separate routes).
 */
import { Hono } from "hono";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "node:http";
import { ConfigStore, describeError } from "../config/config-store.js";
import { WORKSPACE_ID_MAX_LENGTH, WORKSPACE_ID_PATTERN } from "../config/config-schema.js";
import type { DiagnosticsCheck } from "../application/contracts.js";
import { WorkspaceAdminService } from "../application/workspace-admin-service.js";
import { ConnectionService } from "../application/connection-service.js";
import { PromptHelperService } from "../application/prompt-helper-service.js";
import type { McpHttpBridge } from "../mcp/http.js";
import { createPackagedUiAssetResolver, type UiAssetResolver } from "./static-assets.js";
import {
  SESSION_COOKIE_NAME,
  parseCookieHeader,
  type SessionStore,
} from "./session-store.js";

/** Default request body cap (security contract §9). */
const MAX_BODY_BYTES = 1024 * 1024;

const CONTROL_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'; " +
  "form-action 'self'; object-src 'none'";

export interface ControlApiServices {
  sessionStore: SessionStore;
  /**
   * The exact loopback origin mutations must present as their Origin.
   * Resolved lazily: the bound port is only known once the listener is live,
   * and the origin must never fall back to a wildcard check.
   */
  getRuntimeOrigin(): string;
  instanceId: string;
  workspaces: WorkspaceAdminService;
  connection: ConnectionService;
  helpers: PromptHelperService;
  credentials: {
    getRuntimeApiKey(): Promise<string | undefined>;
    setRuntimeApiKey(value: string): Promise<void>;
    storeAvailable(): Promise<boolean>;
  };
  diagnostics(): Promise<DiagnosticsCheck[]>;
}

export interface ControlAppOptions {
  instanceId: string;
  configPath: string;
  assetResolver?: UiAssetResolver;
  /** Read-only Streamable HTTP MCP bridge (Slice 4); POST /mcp is delegated. */
  mcpBridge?: McpHttpBridge;
  /** Privileged Control API assembly (Slice 7+); absent = API routes off. */
  controlApi?: ControlApiServices;
}

const addWorkspaceDto = z.object({
  root: z.string().min(1),
  name: z.string().max(100).optional(),
  id: z.string().max(WORKSPACE_ID_MAX_LENGTH).optional(),
});

const patchWorkspaceDto = z.object({
  name: z.string().min(1).max(100).optional(),
  enabled: z.boolean().optional(),
});

const credentialsDto = z.object({
  runtimeApiKey: z.string().min(1),
});

const workspaceIdParam = z.string().regex(WORKSPACE_ID_PATTERN).max(WORKSPACE_ID_MAX_LENGTH);

export function createControlApp(options: ControlAppOptions): Hono {
  const app = new Hono();
  const assets = options.assetResolver ?? createPackagedUiAssetResolver();

  // Security control: Host/authority validation before any routing.
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

  // Security control: restrictive default headers on every response.
  app.use("*", async (context, next) => {
    await next();
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Cache-Control", "no-store");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Content-Security-Policy", CONTROL_CSP);
    context.header("X-Frame-Options", "DENY");
  });

  // Security control: bounded request bodies before unbounded processing.
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
    context.json({
      status: "ok",
      runtime_instance_id: options.instanceId,
      mcp: options.mcpBridge
        ? {
            active_requests: options.mcpBridge.metrics.activeRequests,
            last_request_at: options.mcpBridge.metrics.lastRequestAt,
          }
        : undefined,
    }),
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

  // Read-only Streamable HTTP MCP endpoint: POST is handled by the stateless
  // bridge over the SAME tool factory the stdio path uses; no administration
  // capability exists on the MCP surface, and the browser session is never
  // accepted here (capability separation). Other methods get a bounded JSON
  // answer.
  if (options.mcpBridge !== undefined) {
    app.post("/mcp", (context) => {
      const { incoming, outgoing } = context.env as {
        incoming: IncomingMessage;
        outgoing: ServerResponse;
      };
      return options.mcpBridge!.handlePost(incoming, outgoing).then(() => undefined);
    });
    app.all("/mcp", (context) =>
      context.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32000, message: "Method not allowed on the MCP endpoint." },
        },
        405,
      ),
    );
  } else {
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
  }

  if (options.controlApi !== undefined) {
    registerControlApi(app, options.controlApi);
  }

  return app;
}

/**
 * Privileged Control API. Every route below the browser-session gate requires
 * a valid session; every mutation additionally requires the exact runtime
 * Origin and the per-session CSRF token. GET routes are reads only.
 */
export function registerControlApi(app: Hono, services: ControlApiServices): void {
  // Session bootstrap is the one unauthenticated API route: it mints (or
  // resumes) the ephemeral browser session and returns its CSRF token.
  app.get("/api/v1/session", (context) => {
    const token = parseCookieHeader(context.req.header("cookie"))[SESSION_COOKIE_NAME];
    const session = services.sessionStore.ensure(token);
    context.header(
      "Set-Cookie",
      `${SESSION_COOKIE_NAME}=${session.token}; HttpOnly; SameSite=Strict; Path=/`,
    );
    return context.json({ csrf_token: session.csrfToken });
  });

  // Browser-session gate for everything else under /api/v1/*.
  app.use("/api/v1/*", async (context, next) => {
    const token = parseCookieHeader(context.req.header("cookie"))[SESSION_COOKIE_NAME];
    const session = services.sessionStore.get(token);
    if (session === undefined) {
      return context.json(
        { error: { code: "SESSION_REQUIRED", message: "A browser session is required." } },
        401,
      );
    }
    const method = context.req.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      // Same-origin intent, checked independently from the CSRF token. An
      // unresolved origin (before the first bind completes) rejects closed.
      if (context.req.header("origin") !== services.getRuntimeOrigin()) {
        return context.json(
          { error: { code: "ORIGIN_REJECTED", message: "Mutations require the exact same-origin." } },
          403,
        );
      }
      if (context.req.header("x-csrf-token") !== session.csrfToken) {
        return context.json(
          { error: { code: "CSRF_REJECTED", message: "Mutations require a valid CSRF token." } },
          403,
        );
      }
    }
    await next();
  });

  app.get("/api/v1/status", (context) =>
    context.json({ status: "ok", runtime_instance_id: services.instanceId }),
  );

  app.get("/api/v1/workspaces", (context) =>
    context.json({
      workspaces: services.workspaces.list().map((workspace) => ({
        workspace_id: workspace.workspace_id,
        name: workspace.name,
        enabled: workspace.enabled,
        available: workspace.available,
      })),
    }),
  );

  app.post("/api/v1/workspaces", async (context) => {
    const dto = addWorkspaceDto.safeParse(await parseJsonBody(context));
    if (!dto.success) {
      return dtoError(context, dto.error);
    }
    try {
      const workspace = await services.workspaces.add(dto.data);
      return context.json(
        {
          workspace: {
            workspace_id: workspace.workspace_id,
            name: workspace.name,
            enabled: workspace.enabled,
          },
        },
        201,
      );
    } catch (error) {
      return boundedError(context, "WORKSPACE_REJECTED", error);
    }
  });

  app.patch("/api/v1/workspaces/:id", async (context) => {
    const id = workspaceIdParam.safeParse(context.req.param("id"));
    if (!id.success) {
      return context.json(
        { error: { code: "INVALID_DTO", message: "Invalid workspace id." } },
        400,
      );
    }
    const dto = patchWorkspaceDto.safeParse(await parseJsonBody(context));
    if (!dto.success) {
      return dtoError(context, dto.error);
    }
    try {
      const workspace =
        dto.data.name !== undefined
          ? await services.workspaces.rename(id.data, dto.data.name)
          : dto.data.enabled === true
            ? await services.workspaces.enable(id.data)
            : dto.data.enabled === false
              ? await services.workspaces.disable(id.data)
              : undefined;
      if (workspace === undefined) {
        return context.json(
          { error: { code: "INVALID_DTO", message: "Nothing to update." } },
          400,
        );
      }
      return context.json({
        workspace: {
          workspace_id: workspace.workspace_id,
          name: workspace.name,
          enabled: workspace.enabled,
        },
      });
    } catch (error) {
      return boundedError(context, "WORKSPACE_REJECTED", error);
    }
  });

  app.delete("/api/v1/workspaces/:id", async (context) => {
    const id = workspaceIdParam.safeParse(context.req.param("id"));
    if (!id.success) {
      return context.json(
        { error: { code: "INVALID_DTO", message: "Invalid workspace id." } },
        400,
      );
    }
    try {
      const removed = await services.workspaces.remove(id.data);
      return context.json({
        removed: {
          workspace_id: removed.workspace_id,
          name: removed.name,
        },
      });
    } catch (error) {
      return boundedError(context, "WORKSPACE_REJECTED", error);
    }
  });

  // Runtime credential setup: the secret is accepted exactly once and stored
  // through the injected credential adapter; responses are non-secret only
  // (security contract §10). No plaintext fallback exists.
  app.get("/api/v1/credentials", async (context) =>
    context.json({
      configured: (await services.credentials.getRuntimeApiKey()) !== undefined,
      store_available: await services.credentials.storeAvailable(),
    }),
  );

  app.post("/api/v1/credentials", async (context) => {
    const dto = credentialsDto.safeParse(await parseJsonBody(context));
    if (!dto.success) {
      return dtoError(context, dto.error);
    }
    try {
      await services.credentials.setRuntimeApiKey(dto.data.runtimeApiKey);
    } catch {
      return context.json(
        {
          error: {
            code: "CREDENTIAL_STORE_UNAVAILABLE",
            message: "The credential store is unavailable; no plaintext fallback is used.",
          },
        },
        503,
      );
    }
    return context.json({ configured: true }, 201);
  });

  app.get("/api/v1/connection", async (context) =>
    context.json(await services.connection.currentStatus()),
  );

  app.post("/api/v1/connection/connect", async (context) => {
    const runtimeApiKey = await services.credentials.getRuntimeApiKey();
    if (runtimeApiKey === undefined) {
      return context.json(
        {
          error: {
            code: "CREDENTIAL_REQUIRED",
            message: "Store the runtime API key before connecting.",
          },
        },
        400,
      );
    }
    try {
      return context.json(await services.connection.connect());
    } catch (error) {
      return boundedError(context, "CONNECTION_FAILED", error);
    }
  });

  app.get("/api/v1/diagnostics", async (context) =>
    context.json({ checks: await services.diagnostics() }),
  );

  // Prompt helpers: stateless generation from stable workspace identity
  // (security contract §2.2 — bounded convenience, no filesystem access and
  // no workflow state). Unknown workspaces are a bounded 404.
  const helperDto = z.object({
    workspace_id: workspaceIdParam,
    root: z.string().optional(),
  });
  const helperRoute = (kind: "project-instructions" | "review-prompt" | "plan-prompt") => {
    app.post(`/api/v1/helpers/${kind}`, async (context) => {
      const dto = helperDto.safeParse(await parseJsonBody(context));
      if (!dto.success) {
        return dtoError(context, dto.error);
      }
      const known = services.workspaces.list().some((ws) => ws.workspace_id === dto.data.workspace_id);
      if (!known) {
        return context.json(
          { error: { code: "WORKSPACE_NOT_FOUND", message: "Unknown workspace_id." } },
          404,
        );
      }
      const input = { workspaceId: dto.data.workspace_id, root: dto.data.root };
      const prompt =
        kind === "project-instructions"
          ? services.helpers.projectInstructions(input)
          : kind === "review-prompt"
            ? services.helpers.reviewPrompt(input)
            : services.helpers.planPrompt(input);
      return context.json({ workspace_id: dto.data.workspace_id, prompt });
    });
  };
  helperRoute("project-instructions");
  helperRoute("review-prompt");
  helperRoute("plan-prompt");

  // Settings arrive with the control-state slice (Slice 9); the route is
  // already inside the privileged gate so future behavior inherits every
  // protection.
  app.patch("/api/v1/settings", (context) =>
    context.json(
      { error: { code: "NOT_IMPLEMENTED", message: "Settings are not part of this runtime build yet." } },
      501,
    ),
  );
}

async function parseJsonBody(context: { req: { json(): Promise<unknown> } }): Promise<unknown> {
  try {
    return await context.req.json();
  } catch {
    return undefined;
  }
}

function dtoError(
  context: { json(body: unknown, status?: 400): Response },
  error: z.ZodError,
): Response {
  const message = error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join("; ");
  return context.json(
    { error: { code: "INVALID_DTO", message: message === "" ? "Invalid request body." : message } },
    400,
  );
}

/** Bounded product error: never stack traces or internal dumps. */
function boundedError(
  context: { json(body: unknown, status?: 400): Response },
  code: string,
  error: unknown,
): Response {
  const message = error instanceof Error ? error.message : "The request could not be completed.";
  return context.json({ error: { code, message } }, 400);
}

/**
 * The Host contract is limited to the loopback host forms for the configured
 * local port (`docs/v0.3-control-plane-security-contract.md` §4). The exact
 * bound port is enforced by the runtime's bind; the Host shape check here
 * rejects rebinding-style and remote authorities before routing.
 */
function isLoopbackHost(host: string): boolean {
  return /^(127\.0\.0\.1|\[::1\]|localhost)(:\d+)?$/i.test(host);
}

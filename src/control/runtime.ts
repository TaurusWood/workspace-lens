/**
 * WorkspaceLens Control Runtime lifecycle (`docs/v0.3-implementation-plan.md` §7,
 * `docs/v0.3-technical-architecture-rfc.md` §4).
 *
 * One long-lived local runtime owns WebUI assets, (later) the Control API and
 * read-only MCP HTTP, and bounded in-memory operational state. It binds
 * loopback only — the host is never configurable — and holds the runtime
 * singleton lock for its whole lifetime:
 *
 * - a second `workspace-lens control` for the same state root detects the
 *   healthy existing runtime and REUSES it (reports its URL, never starts a
 *   duplicate);
 * - a live-but-unreachable runtime is reported as an explicit ownership
 *   conflict instead of starting a second manager;
 * - a dead owner's lock is recovered after the bounded proof of process
 *   death (`runtime-lock.ts`).
 *
 * The handle's `stop()` is idempotent and closes the listener, clears the
 * runtime state file, and releases the lock. Signals are owned by the
 * caller: the `workspace-lens control` command wires SIGINT/SIGTERM to
 * `stop()`; a launcher (Slice 12) may own the runtime in a child process.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import type { ServerType } from "@hono/node-server";
import { ConfigError } from "../config/config-schema.js";
import { defaultConfigPath } from "../config/config-store.js";
import { StderrLogger, type Logger } from "../core/logger.js";
import { ConfigStore } from "../config/config-store.js";
import { ControlStateStore } from "../config/control-state-store.js";
import { ConnectionService } from "../application/connection-service.js";
import { DiagnosticsService } from "../application/diagnostics-service.js";
import { PromptHelperService } from "../application/prompt-helper-service.js";
import { WorkspaceAdminService } from "../application/workspace-admin-service.js";
import { SettingsService } from "../application/settings-service.js";
import type { ConnectionRuntimeInput } from "../application/contracts.js";
import { TunnelRuntimeAdapter } from "../integrations/openai/tunnel-runtime-adapter.js";
import type { Hono } from "hono";
import { registerControlApi } from "./control-app.js";
import { SessionStore } from "./session-store.js";
import { createControlApp } from "./control-app.js";
import { acquireRuntimeLock, type RuntimeLockHandle } from "./runtime-lock.js";
import { createMcpHttpBridge } from "../mcp/http.js";
import { SecretStore } from "../integrations/secrets/secret-store.js";

export interface ControlRuntimeOptions {
  /** Workspace authorization config file (read-only for the runtime). */
  configPath: string;
  /** Non-secret control state file (owned by the settings slice). */
  controlStatePath?: string;
  /** State directory holding the runtime lock and runtime metadata. */
  runtimeStatePath: string;
  /** Ephemeral port when 0/unset; never exposes a host choice. */
  port?: number;
  // The following seams exist so ONE runtime wiring serves every surface;
  // absent adapters degrade honestly (e.g. no credential store -> the
  // credential routes report store_available: false, never plaintext).
  /** Credential adapter (Slice 10): injected OS-credential adapter object. */
  secretAdapter?: CredentialStoreAdapter;
  secretNamespace?: string;
  /** Managed-runtime adapter (Slice 6): injected adapter object. */
  tunnelAdapter?: ManagedRuntimeAdapter;
  /** Startup manager seam (Slice 17): injected adapter object. */
  startupAdapter?: unknown;
  /** Browser launcher seam (Slice 12): opens the WebUI on the user's machine. */
  browserLauncher?: (url: string) => void;
  /** Metadata-only logger for the MCP surface (defaults to stderr). */
  logger?: Logger;
  /**
   * Hook to assemble additional routes BEFORE the listener starts; called
   * exactly once with the resolved instance identity. Routes must be added
   * here — Hono builds its matcher on the first request, so late additions
   * are rejected.
   */
  extendApp?: (app: Hono, runtime: { instanceId: string }) => void;
}

export interface ControlRuntimeHandle {
  /** Loopback base URL, e.g. http://127.0.0.1:43127 */
  url: string;
  baseUrl: string;
  /** True when an existing healthy runtime was reused instead of started. */
  reused: boolean;
  /** Instance identity of the STARTED runtime (empty for a reuse). */
  instanceId: string;
  /** Metadata-only log capture (security contract §18); bounded. */
  capturedLogs: unknown[];
  /** Captured child-process argv (reference arguments only); bounded. */
  capturedChildArgv: string[][];
  runtime: {
    baseUrl: string;
    /** Idempotent: closes the listener and releases the singleton lock. */
    stop(): Promise<void>;
  };
}

export interface CredentialStoreAdapter {
  available(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface ManagedRuntimeAdapter {
  detect(): Promise<{ installed: boolean; version?: string }>;
  connect(input: ConnectionRuntimeInput): Promise<unknown>;
  status(alias: string): Promise<unknown>;
  stop(alias: string): Promise<unknown>;
  restart(input: ConnectionRuntimeInput): Promise<unknown>;
}

const CREDENTIAL_NAME = "runtime-api-key";
const CAPTURE_LIMIT = 500;

class CapturingLogger implements Logger {
  private count = 0;

  constructor(private readonly sink: unknown[]) {}

  private record(entry: Record<string, unknown>): void {
    // Bounded capture: runtime evidence, never a growing history store.
    if (this.count >= CAPTURE_LIMIT) {
      return;
    }
    this.count += 1;
    this.sink.push(entry);
  }

  toolCall(fields: Record<string, unknown>): void {
    this.record({ event: "tool_call", ...fields });
  }

  event(event: string, detail?: string): void {
    this.record({ event, detail });
  }

  error(event: string, message: string): void {
    this.record({ event, level: "error", detail: message });
  }
}

interface RuntimeStateFile {
  baseUrl: string;
  pid: number;
  startedAt: string;
  instanceId: string;
}

const HEALTH_PROBE_TIMEOUT_MS = 1500;

export async function startControlRuntime(options: ControlRuntimeOptions): Promise<ControlRuntimeHandle> {
  const runtimeStatePath = path.resolve(options.runtimeStatePath);
  const capturedLogs: unknown[] = [];
  const capturedChildArgv: string[][] = [];
  const lock = acquireRuntimeLock(runtimeStatePath);

  if (!lock.acquired) {
    // A live owner holds the singleton. Reuse it only when the runtime state
    // names THE SAME owner and a live endpoint that proves the SAME instance
    // identity — never a stale runtime.json pointing at an unrelated local
    // service that merely answers 200. Everything else is an explicit
    // ownership conflict; a duplicate manager is never started.
    const existing = readRuntimeState(runtimeStatePath);
    if (
      existing !== undefined &&
      existing.pid === lock.ownerPid &&
      isLoopbackBaseUrl(existing.baseUrl) &&
      (await provesSameInstance(existing))
    ) {
      return {
        url: existing.baseUrl,
        baseUrl: existing.baseUrl,
        reused: true,
        instanceId: "",
        capturedLogs,
        capturedChildArgv,
        runtime: {
          baseUrl: existing.baseUrl,
          // The reuser does not own the runtime; stopping it must not stop
          // the existing instance.
          stop(): Promise<void> {
            return Promise.resolve();
          },
        },
      };
    }
    const reason =
      existing !== undefined
        ? existing.pid === lock.ownerPid
          ? `its endpoint ${existing.baseUrl} does not prove the recorded runtime instance`
          : `the runtime state names pid ${existing.pid}, not the lock owner ${lock.ownerPid ?? "unknown"}`
        : "its endpoint could not be discovered";
    throw new ConfigError(
      `Another Control Runtime instance is already running for this state ` +
        `(owner pid ${lock.ownerPid ?? "unknown"} holds the runtime lock) but ${reason}.`,
    );
  }

  const instanceId = randomUUID();
  const port = options.port ?? 0;
  const mcpBridge = createMcpHttpBridge({
    configPath: options.configPath,
    logger: options.logger ?? new CapturingLogger(capturedLogs),
  });

  // The privileged Control API is part of the runtime's default wiring: the
  // management routes exist under the full session gate for every caller
  // (CLI control, launcher child). Absent adapters degrade honestly.
  const secretNamespace = options.secretNamespace ?? "workspace-lens";
  const credentialStore =
    options.secretAdapter ?? new SecretStore({ namespace: secretNamespace });
  const credentials = {
    getRuntimeApiKey(): Promise<string | undefined> {
      return credentialStore.get(CREDENTIAL_NAME);
    },
    setRuntimeApiKey(value: string): Promise<void> {
      return credentialStore.set(CREDENTIAL_NAME, value);
    },
    storeAvailable(): Promise<boolean> {
      return credentialStore.available();
    },
  };
  const managedAdapter: ManagedRuntimeAdapter =
    options.tunnelAdapter ??
    new TunnelRuntimeAdapter({
      executable: "tunnel-client",
      // Child argv is captured metadata-only; the literal key travels via
      // the child env and never appears in argv.
      onInvocation: (argv) => {
        if (capturedChildArgv.length < CAPTURE_LIMIT) {
          capturedChildArgv.push(argv);
        }
      },
    });
  const configStore = new ConfigStore(options.configPath);
  const settings = new SettingsService({
    controlStateStore: new ControlStateStore(
      options.controlStatePath ?? defaultControlStatePath(),
    ),
  });
  const connectionService = new ConnectionService({
    adapter: managedAdapter,
    controlRuntime: { baseUrl: "", isHealthy: async () => true },
    configStore: { load: () => configStore.load() },
    credentialStatus: {
      isConfigured: async () => (await credentials.getRuntimeApiKey()) !== undefined,
      storeAvailable: () => credentials.storeAvailable(),
    },
    controlStateReader: {
      getConfirmations: async () => {
        const current = await settings.get();
        return {
          providerSetupUserConfirmed: current.providerSetupUserConfirmed,
          verificationUserConfirmed: current.verificationUserConfirmed,
        };
      },
    },
    connection: {
      alias: "workspace-lens",
      // Resolved lazily: the bound port is only known once the listener is
      // live, before any connect can be issued.
      mcpServerUrl: () => `${baseUrl}/mcp`,
      getRuntimeApiKey: credentials.getRuntimeApiKey,
    },
  });
  let baseUrl = "";
  const sessionStore = new SessionStore();
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    // Every caller — including ones racing the first call — receives the
    // SAME shutdown promise, which resolves only after the listener is
    // fully stopped and the lock is released.
    stopPromise ??= (async () => {
      // Hold singleton ownership until the listener is FULLY stopped: while
      // connections may still drain, releasing the lock could let a second
      // manager bind (a different ephemeral port) and coexist. State and
      // lock cleanup follow only after the port is released.
      try {
        if (server !== undefined) {
          await stopServer(server);
        }
      } finally {
        clearRuntimeState(runtimeStatePath);
        lock.handle.release();
      }
    })();
    return stopPromise;
  };
  // Unified rollback: from the moment the listener exists until the handle
  // is fully delivered, ANY failure closes the server and releases the lock
  // — a failed start can never leave an orphan listener holding ownership.
  let server: ServerType | undefined;
  const app = createControlApp({
    instanceId,
    configPath: options.configPath,
    mcpBridge,
  });
  // Route assembly happens BEFORE the listener starts: Hono builds its
  // matcher on the first request, so late additions are rejected. The origin
  // gate resolves the bound URL lazily and rejects closed until the bind.
  registerControlApi(app, {
    sessionStore,
    getRuntimeOrigin: () => baseUrl,
    instanceId,
    workspaces: new WorkspaceAdminService({ configStore }),
    connection: connectionService,
    helpers: new PromptHelperService(),
    settings,
    credentials,
    diagnostics: () =>
      new DiagnosticsService({
        configStore,
        detectTunnel:
          options.tunnelAdapter !== undefined
            ? () => options.tunnelAdapter!.detect()
            : undefined,
      }).run(),
  });
  try {
    server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: "127.0.0.1",
      },
    );
    // serve() returns before the listener is live; bind errors (e.g. port in
    // use) surface on the error event.
    await waitForListening(server);
    const address = server.address();
    if (address === null || typeof address === "string" || !isLoopbackAddress(address.address)) {
      throw new ConfigError("Control Runtime refused to start: the listener is not loopback-only.");
    }
    const boundPort = address.port;
    baseUrl = `http://127.0.0.1:${boundPort}`;
    writeRuntimeState(runtimeStatePath, {
      baseUrl,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      instanceId,
    });
    return {
      url: baseUrl,
      baseUrl,
      reused: false,
      instanceId,
      capturedLogs,
      capturedChildArgv,
      runtime: { baseUrl, stop },
    };
  } catch (error) {
    if (server !== undefined) {
      await stopServer(server);
    }
    lock.handle.release();
    throw error instanceof ConfigError
      ? error
      : new ConfigError(
          `Cannot start the Control Runtime on 127.0.0.1:${port}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
  }
}

/** Default state paths for the user-facing `workspace-lens control` command. */
export function defaultRuntimeStatePath(): string {
  const fromEnv = process.env.WORKSPACE_LENS_RUNTIME_STATE;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  const stateHome = process.env.XDG_STATE_HOME ?? path.join(process.env.HOME ?? "", ".local", "state");
  return path.join(stateHome, "workspace-lens");
}

export function defaultControlStatePath(): string {
  const fromEnv = process.env.WORKSPACE_LENS_CONTROL_STATE;
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  return path.join(path.dirname(defaultConfigPath()), "control-state.json");
}

function stopServer(server: ServerType): Promise<void> {
  return new Promise((resolve) => {
    // Close idle keep-alive connections so the port drains promptly on stop.
    (server as { closeIdleConnections?: () => void }).closeIdleConnections?.();
    server.close(() => resolve());
  });
}

function waitForListening(server: ServerType): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("the listener did not start in time")), 5000);
    server.once("listening", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.once("error", (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

/** The reuse candidate must be a loopback URL — never an arbitrary host. */
function isLoopbackBaseUrl(baseUrl: string): boolean {
  return /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(baseUrl);
}

/**
 * Identity proof for reuse: the endpoint must answer /healthz with the SAME
 * runtime_instance_id recorded in the runtime state. A 200 from any other
 * local service is not a WorkspaceLens runtime.
 */
async function provesSameInstance(state: RuntimeStateFile): Promise<boolean> {
  try {
    const response = await fetch(`${state.baseUrl}/healthz`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      return false;
    }
    const body = (await response.json()) as { runtime_instance_id?: unknown };
    return body.runtime_instance_id === state.instanceId;
  } catch {
    return false;
  }
}

function runtimeStateFile(runtimeStatePath: string): string {
  return path.join(runtimeStatePath, "runtime.json");
}

function writeRuntimeState(runtimeStatePath: string, state: RuntimeStateFile): void {
  fs.writeFileSync(runtimeStateFile(runtimeStatePath), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function readRuntimeState(runtimeStatePath: string): RuntimeStateFile | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeStateFile(runtimeStatePath), "utf8")) as RuntimeStateFile;
    return typeof parsed.baseUrl === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function clearRuntimeState(runtimeStatePath: string): void {
  try {
    fs.rmSync(runtimeStateFile(runtimeStatePath), { force: true });
  } catch {
    // A leftover state file is inert (the lock decides ownership); never
    // mask a shutdown with it.
  }
}

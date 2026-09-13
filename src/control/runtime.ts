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
import { createControlApp } from "./control-app.js";
import { acquireRuntimeLock, type RuntimeLockHandle } from "./runtime-lock.js";

export interface ControlRuntimeOptions {
  /** Workspace authorization config file (read-only for the runtime). */
  configPath: string;
  /** Non-secret control state file (owned by the settings slice). */
  controlStatePath?: string;
  /** State directory holding the runtime lock and runtime metadata. */
  runtimeStatePath: string;
  /** Ephemeral port when 0/unset; never exposes a host choice. */
  port?: number;
  // The following seams exist so ONE runtime wiring serves every later
  // surface; the slices that own them read them from the runtime context.
  /** SecretStore seam (Slice 10): injected OS-credential adapter object. */
  secretAdapter?: unknown;
  secretNamespace?: string;
  /** Tunnel managed-runtime seam (Slice 6): injected adapter object. */
  tunnelAdapter?: unknown;
  /** Startup manager seam (Slice 17): injected adapter object. */
  startupAdapter?: unknown;
  /** Browser launcher seam (Slice 12): opens the WebUI on the user's machine. */
  browserLauncher?: (url: string) => void;
}

export interface ControlRuntimeHandle {
  /** Loopback base URL, e.g. http://127.0.0.1:43127 */
  url: string;
  baseUrl: string;
  /** True when an existing healthy runtime was reused instead of started. */
  reused: boolean;
  /** Instance identity of the STARTED runtime (empty for a reuse). */
  instanceId: string;
  runtime: {
    baseUrl: string;
    /** Idempotent: closes the listener and releases the singleton lock. */
    stop(): Promise<void>;
  };
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
  const lock = acquireRuntimeLock(runtimeStatePath);

  if (!lock.acquired) {
    // A live owner holds the singleton. Reuse it when it is healthy;
    // otherwise report an explicit ownership conflict — never start a
    // duplicate manager.
    const existing = readRuntimeState(runtimeStatePath);
    const baseUrl = existing?.baseUrl;
    if (baseUrl !== undefined && (await isHealthy(baseUrl))) {
      return {
        url: baseUrl,
        baseUrl,
        reused: true,
        instanceId: "",
        runtime: {
          baseUrl,
          // The reuser does not own the runtime; stopping it must not stop
          // the existing instance.
          stop(): Promise<void> {
            return Promise.resolve();
          },
        },
      };
    }
    throw new ConfigError(
      `Another Control Runtime instance is already running for this state ` +
        `(owner pid ${lock.ownerPid ?? "unknown"} holds the runtime lock)` +
        (baseUrl !== undefined ? ` but ${baseUrl} is not healthy.` : " and its endpoint could not be discovered."),
    );
  }

  const instanceId = randomUUID();
  const port = options.port ?? 0;
  let server: ServerType;
  try {
    server = serve(
      { fetch: createControlApp({ instanceId, configPath: options.configPath }).fetch, port, hostname: "127.0.0.1" },
    );
  } catch (error) {
    lock.handle.release();
    throw new ConfigError(
      `Cannot start the Control Runtime on 127.0.0.1:${port}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // serve() returns before the listener is live; bind errors (e.g. port in
  // use) surface on the error event.
  try {
    await waitForListening(server);
  } catch (error) {
    lock.handle.release();
    throw new ConfigError(
      `Cannot start the Control Runtime on 127.0.0.1:${port}: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const address = server.address();
  if (address === null || typeof address === "string" || !isLoopbackAddress(address.address)) {
    void stopServer(server);
    lock.handle.release();
    throw new ConfigError("Control Runtime refused to start: the listener is not loopback-only.");
  }
  const boundPort = address.port;
  const baseUrl = `http://127.0.0.1:${boundPort}`;

  writeRuntimeState(runtimeStatePath, {
    baseUrl,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    instanceId,
  });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    stopped = true;
    clearRuntimeState(runtimeStatePath);
    lock.handle.release();
    await stopServer(server);
  };

  return {
    url: baseUrl,
    baseUrl,
    reused: false,
    instanceId,
    runtime: { baseUrl, stop },
  };
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

function isHealthy(baseUrl: string): Promise<boolean> {
  return fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS) })
    .then((response) => response.status === 200)
    .catch(() => false);
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

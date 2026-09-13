/**
 * Control Runtime server assembly (Slice 7).
 *
 * `createControlRuntime` wires the long-lived runtime lifecycle (Slice 3)
 * together with the privileged Control API under the full browser-session
 * security gate (`docs/v0.3-control-plane-security-contract.md`):
 *
 * - ephemeral browser session (memory-only, HttpOnly + SameSite=Strict
 *   cookie) with a per-session CSRF token; exact same-origin enforcement for
 *   every mutation; Zod DTO validation and stable product errors;
 * - metadata-only log capture and child-argv capture hooks (security
 *   contract §18) so secret-leak checks have a real evidence surface;
 * - capability separation: the browser session is never accepted on /mcp,
 *   and the MCP surface stays the frozen read-only ten-tool contract;
 * - the runtime binds loopback only — `rebind` is refused unconditionally.
 */
import { ConfigStore } from "../config/config-store.js";
import { ConnectionService } from "../application/connection-service.js";
import { DiagnosticsService } from "../application/diagnostics-service.js";
import { WorkspaceAdminService } from "../application/workspace-admin-service.js";
import type { Logger } from "../core/logger.js";
import { TunnelRuntimeAdapter } from "../integrations/openai/tunnel-runtime-adapter.js";
import { registerControlApi } from "./control-app.js";
import { SessionStore } from "./session-store.js";
import { startControlRuntime } from "./runtime.js";

/** Credential adapter surface the Control API stores secrets through. */
export interface CredentialStoreAdapter {
  available(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

/** Managed-runtime adapter surface consumed by the connection service. */
export interface ManagedRuntimeAdapter {
  detect(): Promise<{ installed: boolean; version?: string }>;
  connect(input: unknown): Promise<unknown>;
  status(alias: string): Promise<unknown>;
  stop(alias: string): Promise<unknown>;
  restart(input: unknown): Promise<unknown>;
}

export interface ControlRuntimeServerOptions {
  configPath: string;
  controlStatePath?: string;
  runtimeStatePath: string;
  port?: number;
  /** Credential adapter (injected object); absent means no store is available. */
  secretAdapter?: CredentialStoreAdapter;
  secretNamespace?: string;
  /** Managed-runtime adapter (injected object); absent means the real binary. */
  tunnelAdapter?: ManagedRuntimeAdapter;
  startupAdapter?: unknown;
}

export interface ControlRuntimeServer {
  baseUrl: string;
  instanceId: string;
  /** Metadata-only log capture (security contract §18); bounded. */
  capturedLogs: unknown[];
  /** Captured child-process argv (reference arguments only); bounded. */
  capturedChildArgv: string[][];
  /** The runtime binds loopback only: rebinding is refused unconditionally. */
  rebind(options: { host: string }): never;
  stop(): Promise<void>;
  runtime: { stop(): Promise<void> };
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

export async function createControlRuntime(
  options: ControlRuntimeServerOptions,
): Promise<ControlRuntimeServer> {
  const capturedLogs: unknown[] = [];
  const capturedChildArgv: string[][] = [];
  const logger: Logger = new CapturingLogger(capturedLogs);
  const sessionStore = new SessionStore();
  const configStore = new ConfigStore(options.configPath);

  const credentialStore = options.secretAdapter;
  const credentials = {
    getRuntimeApiKey(): Promise<string | undefined> {
      return credentialStore !== undefined
        ? credentialStore.get(CREDENTIAL_NAME)
        : Promise.resolve(undefined);
    },
    setRuntimeApiKey(value: string): Promise<void> {
      if (credentialStore === undefined) {
        // No plaintext fallback exists (security contract §10.2).
        return Promise.reject(
          new Error("No credential store is available; no plaintext fallback is used."),
        );
      }
      return credentialStore.set(CREDENTIAL_NAME, value);
    },
    storeAvailable(): Promise<boolean> {
      return credentialStore !== undefined
        ? credentialStore.available()
        : Promise.resolve(false);
    },
  };

  // Managed-runtime adapter: an injected object (tests / composition) or the
  // real tunnel-client binary. Child argv is captured metadata-only; the
  // literal key never appears in argv (it travels via the child env).
  const managedAdapter =
    options.tunnelAdapter ??
    new TunnelRuntimeAdapter({
      executable: "tunnel-client",
      onInvocation: (argv) => {
        if (capturedChildArgv.length < CAPTURE_LIMIT) {
          capturedChildArgv.push(argv);
        }
      },
    });

  let baseUrl = "";
  // The service speaks the frozen ConnectionAdapter shape; the real adapter's
  // alias-scoped methods are wrapped onto the single product alias.
  const adapterForService = managedAdapter instanceof TunnelRuntimeAdapter
    ? {
        status: (alias?: string) => managedAdapter.status(alias ?? "workspace-lens"),
        connect: (input?: unknown) => managedAdapter.connect(input as never),
        stop: (alias?: string) => managedAdapter.stop(alias ?? "workspace-lens"),
        restart: (input?: unknown) => managedAdapter.restart("workspace-lens", input as never),
      }
    : managedAdapter;
  const connectionService = new ConnectionService({
    adapter: adapterForService,
    controlRuntime: { baseUrl: "", isHealthy: async () => true },
    configStore: { load: () => configStore.load() },
    connection: {
      alias: "workspace-lens",
      // Resolved lazily: the bound port is only known once the listener is
      // live, before any connect can be issued.
      mcpServerUrl: () => `${baseUrl}/mcp`,
      getRuntimeApiKey: credentials.getRuntimeApiKey,
    },
  });

  const diagnostics = new DiagnosticsService({
    configStore,
    detectTunnel:
      options.tunnelAdapter !== undefined ? () => options.tunnelAdapter!.detect() : undefined,
  });

  // The runtime origin is only known once the bind completes; the gate
  // resolves it lazily and rejects closed until then.
  let runtimeOrigin = "";
  let handle: { baseUrl: string } | undefined;

  const started = await startControlRuntime({
    configPath: options.configPath,
    controlStatePath: options.controlStatePath,
    runtimeStatePath: options.runtimeStatePath,
    port: options.port,
    logger,
    extendApp: (app, runtime) => {
      registerControlApi(app, {
        sessionStore,
        getRuntimeOrigin: () => runtimeOrigin,
        instanceId: runtime.instanceId,
        workspaces: new WorkspaceAdminService({ configStore }),
        connection: connectionService,
        credentials,
        diagnostics: () => diagnostics.run(),
      });
    },
  });
  baseUrl = started.baseUrl;
  runtimeOrigin = started.baseUrl;

  const stop = async (): Promise<void> => {
    sessionStore.clear();
    await started.runtime.stop();
  };

  return {
    baseUrl: started.baseUrl,
    instanceId: started.instanceId,
    capturedLogs,
    capturedChildArgv,
    rebind(): never {
      throw new Error("Control Runtime binds loopback only; rebinding is not supported.");
    },
    stop,
    runtime: { stop },
  };
}

/**
 * Connection application service (`docs/v0.3-implementation-plan.md` §10).
 *
 * Owns the product view of the ONE normal provider connection: normalized
 * current status, connect/start/stop/restart, and the workspace-count
 * invariant (adding workspaces never creates another connection — CONN-005).
 *
 * The service never executes provider-supplied commands and never claims
 * provider-side state it cannot prove: a tunnel failure turns into an
 * actionable state while the workspace configuration stays intact
 * (CONN-004). The raw adapter surface stays behind this boundary.
 */
import type { ConnectionStatusResult, TunnelRuntimeState } from "./contracts.js";

const FROZEN_STATES: TunnelRuntimeState[] = [
  "missing",
  "stopped",
  "starting",
  "healthy",
  "unhealthy",
  "recovering",
  "problem",
];

/** Bounded, actionable next steps per product state. */
const NEXT_ACTIONS: Partial<Record<TunnelRuntimeState, string>> = {
  missing: "Connect to create the tunnel runtime for this machine.",
  stopped: "Connect to start the tunnel runtime.",
  unhealthy: "Open Diagnostics and follow the connection recovery steps.",
  recovering: "The runtime is recovering; wait for the next status update.",
  problem: "Open Diagnostics and follow the connection recovery steps.",
};

export interface ConnectionAdapter {
  status(alias?: string): Promise<unknown>;
  connect(input?: unknown): Promise<unknown>;
  stop?(alias?: string): Promise<unknown>;
  restart?(input?: unknown): Promise<unknown>;
}

export interface ConnectionServiceDependencies {
  adapter: ConnectionAdapter;
  controlRuntime: { baseUrl: string; isHealthy: () => Promise<boolean> };
  /** Workspace configuration integrity probe (CONN-004). */
  configStore?: { load(): unknown };
  /**
   * What a connect needs. The literal key never sits in the service: it is
   * resolved lazily from the credential store at connect time. The MCP URL
   * resolves lazily too: the runtime's bound port is only known after the
   * listener is live.
   */
  connection?: {
    alias: string;
    mcpServerUrl: string | (() => string);
    runtimeApiKey?: string;
    getRuntimeApiKey?: () => Promise<string | undefined>;
  };
}

export class ConnectionService {
  private readonly adapter: ConnectionAdapter;
  private readonly controlRuntime: { baseUrl: string; isHealthy: () => Promise<boolean> };
  private readonly configStore: { load(): unknown } | undefined;
  private readonly connection: ConnectionServiceDependencies["connection"];

  constructor(dependencies: ConnectionServiceDependencies) {
    this.adapter = dependencies.adapter;
    this.controlRuntime = dependencies.controlRuntime;
    this.configStore = dependencies.configStore;
    this.connection = dependencies.connection;
  }

  /** Normalized current connection state; failures are actionable, not fatal. */
  async currentStatus(): Promise<ConnectionStatusResult> {
    const workspaceConfigurationIntact = await this.configurationIntact();
    let state: TunnelRuntimeState;
    try {
      state = extractState(await this.adapter.status(this.connection?.alias));
    } catch {
      // Bounded failure: actionable state, never a control-plane crash and
      // never a claim that the provider side is fine.
      state = "problem";
    }
    return {
      state,
      nextAction: NEXT_ACTIONS[state],
      workspaceConfigurationIntact,
    };
  }

  /**
   * Converge the one product connection for the given workspaces: a healthy
   * (or already starting) connection is reused; nothing here may create a
   * second tunnel alias as workspaces are added.
   */
  async ensureConnectedForWorkspaces(_workspaceIds: readonly string[]): Promise<ConnectionStatusResult> {
    const current = await this.currentStatus();
    if (current.state === "healthy" || current.state === "starting") {
      return current;
    }
    return this.connect();
  }

  async connect(): Promise<ConnectionStatusResult> {
    const input = this.connection === undefined
      ? undefined
      : {
          alias: this.connection.alias,
          mcpServerUrl:
            typeof this.connection.mcpServerUrl === "function"
              ? this.connection.mcpServerUrl()
              : this.connection.mcpServerUrl,
          runtimeApiKey: (await this.connection.getRuntimeApiKey?.()) ?? this.connection.runtimeApiKey,
        };
    const raw = await this.adapter.connect(input);
    const state = extractState(raw);
    return {
      state,
      nextAction: NEXT_ACTIONS[state],
      workspaceConfigurationIntact: await this.configurationIntact(),
    };
  }

  /** Idempotent start: an already-healthy connection is reused. */
  async start(): Promise<ConnectionStatusResult> {
    const current = await this.currentStatus();
    if (current.state === "healthy") {
      return current;
    }
    return this.connect();
  }

  async stop(): Promise<ConnectionStatusResult> {
    await this.adapter.stop?.(this.connection?.alias);
    return {
      state: "stopped",
      nextAction: NEXT_ACTIONS.stopped,
      workspaceConfigurationIntact: await this.configurationIntact(),
    };
  }

  async restart(): Promise<ConnectionStatusResult> {
    if (this.adapter.restart !== undefined) {
      const raw = await this.adapter.restart(this.connection);
      const state = extractState(raw);
      return {
        state,
        nextAction: NEXT_ACTIONS[state],
        workspaceConfigurationIntact: await this.configurationIntact(),
      };
    }
    await this.stop();
    return this.connect();
  }

  private async configurationIntact(): Promise<boolean> {
    if (this.configStore === undefined) {
      return true;
    }
    try {
      this.configStore.load();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Accept both the adapter's normalized result (`state`) and a raw structured
 * status (`status`/`health`) so injected adapters and the real adapter share
 * one product-state vocabulary.
 */
function extractState(raw: unknown): TunnelRuntimeState {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as {
    state?: unknown;
    status?: unknown;
    health?: unknown;
  };
  if (typeof record.state === "string" && FROZEN_STATES.includes(record.state as TunnelRuntimeState)) {
    return record.state as TunnelRuntimeState;
  }
  const status = typeof record.status === "string" ? record.status.toLowerCase() : "";
  const health = typeof record.health === "string" ? record.health.toLowerCase() : "";
  if (status === "running" && (health === "healthy" || health === "")) {
    return "healthy";
  }
  if (health === "healthy") {
    return "healthy";
  }
  if (status === "unhealthy" || health === "unhealthy") {
    return "unhealthy";
  }
  if (status === "starting" || status === "connecting") {
    return "starting";
  }
  if (status === "stopped") {
    return "stopped";
  }
  if (status === "recovering") {
    return "recovering";
  }
  return "problem";
}

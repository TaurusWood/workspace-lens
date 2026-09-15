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
import {
  CONNECTION_ADAPTER_ERROR_CODES,
  type ConnectionLayers,
  type ConnectionRuntimeInput,
  type ConnectionStatusResult,
  type ControlStateReaderPort,
  type CredentialStatusPort,
  type TunnelRuntimeState,
} from "./contracts.js";

const FROZEN_STATES: TunnelRuntimeState[] = [
  "missing",
  "stopped",
  "starting",
  "healthy",
  "unhealthy",
  "recovering",
  "problem",
];

export interface ConnectionAdapter {
  detect?(): Promise<{ installed: boolean; version?: string }>;
  status(alias: string): Promise<unknown>;
  connect(input: ConnectionRuntimeInput): Promise<unknown>;
  stop?(alias: string): Promise<unknown>;
  restart?(input: ConnectionRuntimeInput): Promise<unknown>;
}

export interface ConnectionServiceDependencies {
  adapter: ConnectionAdapter;
  controlRuntime: { baseUrl: string; isHealthy: () => Promise<boolean> };
  /** Workspace configuration integrity probe (CONN-004). */
  configStore?: { load(): unknown };
  /** Safe non-secret port for querying credential status. */
  credentialStatus: CredentialStatusPort;
  /** Non-secret reader port for user-owned setup/verification confirmations. */
  controlStateReader?: ControlStateReaderPort;
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
  private readonly credentialStatus: CredentialStatusPort;
  private readonly controlStateReader: ControlStateReaderPort | undefined;
  private readonly connection: ConnectionServiceDependencies["connection"];

  constructor(dependencies: ConnectionServiceDependencies) {
    this.adapter = dependencies.adapter;
    this.controlRuntime = dependencies.controlRuntime;
    this.configStore = dependencies.configStore;
    this.credentialStatus = dependencies.credentialStatus;
    this.controlStateReader = dependencies.controlStateReader;
    this.connection = dependencies.connection;
  }

  /** Normalized current connection state across the frozen layers. */
  async currentStatus(): Promise<ConnectionStatusResult> {
    return this.buildStatus();
  }

  private async buildStatus(options?: {
    runtimeStateOverride?: TunnelRuntimeState;
  }): Promise<ConnectionStatusResult> {
    const workspaceConfigurationIntact = await this.configurationIntact();
    const confirmations = await this.resolveConfirmations();
    const credStatus = await this.resolveCredentialStatus();

    const localRuntime = {
      state: "healthy" as const,
      evidence: "machine" as const,
    };

    // Sole dependency detector
    const detected = await this.detectTunnelClient();
    let tunnelClientState = detected.state;
    let tunnelClientAction = detected.action;

    let tunnelRuntimeState: TunnelRuntimeState = "missing";
    let tunnelRuntimeAction: string | undefined;
    let isAliasMissing = false;

    const hasConnectionConfig =
      this.connection !== undefined &&
      typeof this.connection.alias === "string" &&
      this.connection.alias.trim() !== "";
    const alias = (this.connection?.alias ?? "workspace-lens").trim();

    // Query runtime status only after tunnelClient is confirmed available
    if (tunnelClientState !== "available") {
      tunnelRuntimeState = "missing";
    } else if (options?.runtimeStateOverride !== undefined) {
      tunnelRuntimeState = options.runtimeStateOverride;
      if (tunnelRuntimeState === "unhealthy" || tunnelRuntimeState === "problem") {
        tunnelRuntimeAction = "Open Diagnostics and follow the connection recovery steps.";
      }
    } else {
      try {
        const raw = await this.adapter.status(alias);
        tunnelRuntimeState = extractState(raw);
        if (tunnelRuntimeState === "unhealthy" || tunnelRuntimeState === "problem") {
          tunnelRuntimeAction = "Open Diagnostics and follow the connection recovery steps.";
        }
      } catch (error: unknown) {
        if (isAliasMissingError(error)) {
          isAliasMissing = true;
          tunnelRuntimeState = "missing";
        } else if (isTunnelUnhealthyError(error)) {
          tunnelRuntimeState = "unhealthy";
          tunnelRuntimeAction = "Open Diagnostics and follow the connection recovery steps.";
        } else if (isBinaryMissing(error)) {
          tunnelClientState = "missing";
          tunnelClientAction = "Install the tunnel-client executable.";
          tunnelRuntimeState = "missing";
        } else {
          tunnelRuntimeState = "problem";
          tunnelRuntimeAction = "Open Diagnostics and follow the connection recovery steps.";
        }
      }
    }

    let tunnelConfigurationState: "configured" | "not-configured" | "action-required";
    let tunnelConfigurationAction: string | undefined;

    if (!hasConnectionConfig) {
      tunnelConfigurationState = "action-required";
      tunnelConfigurationAction = "Configure tunnel connection and alias before connecting.";
    } else if (!credStatus.storeAvailable) {
      tunnelConfigurationState = "action-required";
      tunnelConfigurationAction =
        "The credential store is unavailable; ensure system keychain is accessible.";
    } else if (!credStatus.configured) {
      tunnelConfigurationState = "action-required";
      tunnelConfigurationAction = "Store the runtime API key before connecting.";
    } else if (tunnelClientState === "missing") {
      tunnelConfigurationState = "action-required";
      tunnelConfigurationAction = "Install the tunnel-client executable.";
    } else if (isAliasMissing) {
      tunnelConfigurationState = "not-configured";
      tunnelConfigurationAction = "Connect to create the tunnel runtime for this machine.";
    } else {
      tunnelConfigurationState = "configured";
    }

    const providerSetup = {
      state: confirmations.providerSetupUserConfirmed
        ? ("user-confirmed" as const)
        : ("not-confirmed" as const),
      evidence: confirmations.providerSetupUserConfirmed
        ? ("user" as const)
        : ("none" as const),
    };

    const verification = {
      state: confirmations.verificationUserConfirmed
        ? ("user-confirmed" as const)
        : ("not-confirmed" as const),
      evidence: confirmations.verificationUserConfirmed
        ? ("user" as const)
        : ("none" as const),
    };

    const layers: ConnectionLayers = {
      localRuntime,
      tunnelClient: {
        state: tunnelClientState,
        evidence: "machine",
        ...(tunnelClientAction !== undefined ? { action: tunnelClientAction } : {}),
      },
      tunnelConfiguration: {
        state: tunnelConfigurationState,
        evidence: "machine",
        ...(tunnelConfigurationAction !== undefined ? { action: tunnelConfigurationAction } : {}),
      },
      tunnelRuntime: {
        state: tunnelRuntimeState,
        evidence: "machine",
        ...(tunnelRuntimeAction !== undefined ? { action: tunnelRuntimeAction } : {}),
      },
      providerSetup,
      verification,
    };

    const nextAction = computeNextAction(layers);

    return {
      state: layers.tunnelRuntime.state,
      nextAction,
      workspaceConfigurationIntact,
      layers,
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

  private async resolveConnectionInput(): Promise<ConnectionRuntimeInput> {
    if (this.connection === undefined) {
      throw new Error("Connection configuration is missing; connect cannot proceed.");
    }
    const runtimeApiKey =
      (await this.connection.getRuntimeApiKey?.()) ?? this.connection.runtimeApiKey;
    if (typeof runtimeApiKey !== "string" || runtimeApiKey.trim() === "") {
      throw new Error("Runtime API key is missing or empty; connect cannot proceed.");
    }
    const mcpServerUrl =
      typeof this.connection.mcpServerUrl === "function"
        ? this.connection.mcpServerUrl()
        : this.connection.mcpServerUrl;
    if (typeof mcpServerUrl !== "string" || mcpServerUrl.trim() === "") {
      throw new Error("MCP server URL is missing or unresolved; connect cannot proceed.");
    }
    if (typeof this.connection.alias !== "string" || this.connection.alias.trim() === "") {
      throw new Error("Tunnel alias is missing or empty; connect cannot proceed.");
    }
    return {
      alias: this.connection.alias,
      mcpServerUrl,
      runtimeApiKey,
    };
  }

  async connect(): Promise<ConnectionStatusResult> {
    const input = await this.resolveConnectionInput();
    const raw = await this.adapter.connect(input);
    const state = extractState(raw);
    return this.buildStatus({ runtimeStateOverride: state });
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
    const alias = this.connection?.alias ?? "workspace-lens";
    if (this.adapter.stop !== undefined) {
      await this.adapter.stop(alias);
    }
    return this.buildStatus({ runtimeStateOverride: "stopped" });
  }

  async restart(): Promise<ConnectionStatusResult> {
    const input = await this.resolveConnectionInput();
    let state: TunnelRuntimeState;
    if (this.adapter.restart !== undefined) {
      const raw = await this.adapter.restart(input);
      state = extractState(raw);
    } else {
      await this.stop();
      const raw = await this.adapter.connect(input);
      state = extractState(raw);
    }
    return this.buildStatus({ runtimeStateOverride: state });
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

  private async resolveConfirmations(): Promise<{
    providerSetupUserConfirmed: boolean;
    verificationUserConfirmed: boolean;
  }> {
    if (this.controlStateReader !== undefined) {
      try {
        const confirmations = await this.controlStateReader.getConfirmations();
        return {
          providerSetupUserConfirmed: confirmations.providerSetupUserConfirmed === true,
          verificationUserConfirmed: confirmations.verificationUserConfirmed === true,
        };
      } catch {
        return { providerSetupUserConfirmed: false, verificationUserConfirmed: false };
      }
    }
    return { providerSetupUserConfirmed: false, verificationUserConfirmed: false };
  }

  private async resolveCredentialStatus(): Promise<{
    configured: boolean;
    storeAvailable: boolean;
  }> {
    try {
      const configured = await this.credentialStatus.isConfigured();
      const storeAvailable =
        this.credentialStatus.storeAvailable !== undefined
          ? await this.credentialStatus.storeAvailable()
          : true;
      return { configured, storeAvailable };
    } catch {
      return { configured: false, storeAvailable: false };
    }
  }

  private async detectTunnelClient(): Promise<{
    state: "available" | "missing" | "problem";
    action?: string;
  }> {
    if (this.adapter.detect === undefined) {
      return { state: "available" };
    }
    try {
      const detected = await this.adapter.detect();
      if (detected.installed) {
        return { state: "available" };
      }
      return {
        state: "missing",
        action: "Install the tunnel-client executable.",
      };
    } catch (error: unknown) {
      if (isBinaryMissing(error)) {
        return {
          state: "missing",
          action: "Install the tunnel-client executable.",
        };
      }
      return {
        state: "problem",
        action: "Check tunnel-client installation or open Diagnostics.",
      };
    }
  }
}

function computeNextAction(layers: ConnectionLayers): string | undefined {
  if (layers.tunnelClient.state === "missing") {
    return layers.tunnelClient.action ?? "Install the tunnel-client executable.";
  }
  if (layers.tunnelClient.state === "problem") {
    return layers.tunnelClient.action ?? "Check tunnel-client installation or open Diagnostics.";
  }
  if (layers.tunnelConfiguration.state === "action-required") {
    return layers.tunnelConfiguration.action ?? "Store the runtime API key before connecting.";
  }
  if (
    layers.tunnelConfiguration.state === "not-configured" ||
    layers.tunnelRuntime.state === "missing"
  ) {
    return "Connect to create the tunnel runtime for this machine.";
  }
  if (layers.tunnelRuntime.state === "stopped") {
    return "Connect to start the tunnel runtime.";
  }
  if (layers.tunnelRuntime.state === "unhealthy") {
    return "Open Diagnostics and follow the connection recovery steps.";
  }
  if (layers.tunnelRuntime.state === "recovering") {
    return "The runtime is recovering; wait for the next status update.";
  }
  if (layers.tunnelRuntime.state === "starting") {
    return "The tunnel runtime is starting; wait for the next status update.";
  }
  if (layers.tunnelRuntime.state === "problem") {
    return "Open Diagnostics and follow the connection recovery steps.";
  }
  // Tunnel runtime is healthy
  if (layers.providerSetup.state === "not-confirmed") {
    return "Complete provider-side setup in ChatGPT.";
  }
  if (layers.verification.state === "not-confirmed") {
    return "Verify WorkspaceLens from ChatGPT and confirm.";
  }
  return undefined;
}

function isBinaryMissing(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    return record.code === CONNECTION_ADAPTER_ERROR_CODES.TUNNEL_BINARY_MISSING;
  }
  return false;
}

function isAliasMissingError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === CONNECTION_ADAPTER_ERROR_CODES.ALIAS_MISSING) {
      return true;
    }
  }
  return false;
}

function isTunnelUnhealthyError(error: unknown): boolean {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (code === CONNECTION_ADAPTER_ERROR_CODES.TUNNEL_UNHEALTHY) {
      return true;
    }
  }
  return false;
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

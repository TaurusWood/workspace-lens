/**
 * v0.3 application service contracts (`docs/v0.3-implementation-plan.md` §4).
 *
 * These interfaces fix the shared application seams that CLI and WebUI must
 * both call instead of owning independent business rules
 * (`docs/v0.3-technical-architecture-rfc.md` §6). `WorkspaceAdminService` is
 * implemented in Slice 0; the services below are contracts only and are
 * implemented by their owning slices (DiagnosticsService — Slice 5,
 * PromptHelperService — Slice 8, ConnectionService — Slice 6,
 * SettingsService — Slice 9).
 *
 * The application layer stays framework-independent: no Hono (HTTP adapter)
 * and no React (UI) types or dependencies may appear here.
 */

/**
 * Structured factual diagnostics check. CLI `doctor` and the Control API
 * diagnostics both render from these results (`v0.3-test-contract.md` §12).
 */
export type DiagnosticsGroupId = "local-runtime" | "workspaces" | "provider-integration";

export type DiagnosticsCheckStatus = "ok" | "warning" | "error";

export interface DiagnosticsCheck {
  /** Stable check identifier (for example `config-readable`). */
  id: string;
  group: DiagnosticsGroupId;
  status: DiagnosticsCheckStatus;
  /** Concise factual message; never includes secrets or file contents. */
  message: string;
  /** Optional safe, product-owned next action. */
  action?: string;
}

export interface DiagnosticsService {
  /** Run all checks and return structured results grouped by `group`. */
  run(): Promise<DiagnosticsCheck[]>;
}

/**
 * Normalized managed-runtime states produced by the tunnel adapter
 * (`docs/v0.3-implementation-plan.md` §10). Raw provider/process schema must
 * not leak past this vocabulary.
 */
export type TunnelRuntimeState =
  | "missing"
  | "stopped"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "recovering"
  | "problem";

export interface ConnectionStatusResult {
  state: TunnelRuntimeState;
  /** Safe next step for the user when the state is not healthy. */
  nextAction?: string;
  /**
   * True when the workspace authorization config remains intact regardless
   * of tunnel state (CONN-004: a tunnel failure is actionable, the
   * configuration is never touched).
   */
  workspaceConfigurationIntact?: boolean;
}

/**
 * Resolved connection runtime command input. Connect and restart share this
 * single normalized contract across the application and integration boundary.
 */
export interface ConnectionRuntimeInput {
  alias: string;
  mcpServerUrl: string;
  runtimeApiKey: string;
}

/** Stable adapter error codes recognized by application services. */
export const CONNECTION_ADAPTER_ERROR_CODES = {
  ALIAS_MISSING: "ALIAS_MISSING",
  TUNNEL_UNHEALTHY: "TUNNEL_UNHEALTHY",
} as const;

export type ConnectionAdapterErrorCode =
  (typeof CONNECTION_ADAPTER_ERROR_CODES)[keyof typeof CONNECTION_ADAPTER_ERROR_CODES];


/**
 * Shared connection application service. Method direction follows the
 * frozen executable contracts (`tests/v0.3/connection/conn-adapter.test.ts`,
 * CONN-004/005): `currentStatus` is the single status entry point and
 * `ensureConnectedForWorkspaces` converges on the ONE normal product
 * connection — adding workspaces must never create additional connections
 * (CONN-005). The lifecycle operations below stay on the service because
 * the implementation plan assigns connect/start/stop/restart to it; the
 * exact executable+argv contract lives in `TunnelRuntimeAdapter` (CONN-002).
 */
export interface ConnectionService {
  /** Normalized current connection state across the frozen layers. */
  currentStatus(): Promise<ConnectionStatusResult>;
  /**
   * Converge the one normal product connection for the given workspaces.
   * Idempotent: repeated calls with growing workspace lists must not
   * create additional tunnel connections.
   */
  ensureConnectedForWorkspaces(workspaceIds: readonly string[]): Promise<ConnectionStatusResult>;
  connect(): Promise<ConnectionStatusResult>;
  start(): Promise<ConnectionStatusResult>;
  stop(): Promise<ConnectionStatusResult>;
  restart(): Promise<ConnectionStatusResult>;
}

/**
 * Non-secret product preferences persisted separately from authorization
 * config (`docs/v0.3-technical-architecture-rfc.md` §7.2). Concrete DTOs are
 * fixed by the control-state schema in Slice 9.
 */
export interface SettingsService {
  get(): Promise<Record<string, unknown>>;
  patch(patch: Record<string, unknown>): Promise<Record<string, unknown>>;
}

export interface PromptHelperInput {
  /** Stable workspace identity the helper targets. */
  workspaceId: string;
  /** Optional canonical root context; never embedded in generated text. */
  root?: string;
}

export interface PromptHelperService {
  /**
   * Generate the optional copy helpers from stable workspace identity
   * (`v0.3-test-contract.md` §12 HELP-001/002). Stateless: no saved prompt
   * library, no workflow/session/task records, nothing stored on the service.
   */
  projectInstructions(input: PromptHelperInput): string;
  reviewPrompt(input: PromptHelperInput): string;
  planPrompt(input: PromptHelperInput): string;
}

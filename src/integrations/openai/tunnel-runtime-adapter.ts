/**
 * Official tunnel-client managed-runtime adapter
 * (`docs/v0.3-implementation-plan.md` §10, Gate B Option A).
 *
 * Owns the bounded executable surface: exact executable + argument arrays
 * (no shell), the frozen missing-alias classification, and normalized
 * product states. Raw provider schema (exit codes, argv, raw stderr) never
 * leaves this module.
 *
 * Secret handling: the runtime API key is passed to the child process as an
 * environment variable and referenced from argv as `env:<NAME>` — the
 * literal value never appears in argv, stdout/stderr capture, or logs.
 *
 * Classification rule (owner decision Option A, executable contract
 * CONN-001/003): the ONLY human-readable text this adapter may classify is
 * the ONE frozen, verified missing-alias shape, and only when exit != 0 AND
 * the command is one of the exact supported commands (status/stop). Every
 * other failure is a generic bounded external-runtime error. No general log
 * scraping, no pgrep fallback.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CONNECTION_ADAPTER_ERROR_CODES,
  type ConnectionRuntimeInput,
  type TunnelRuntimeState,
} from "../../application/contracts.js";

const execFileAsync = promisify(execFile);

/** Env var name carrying the literal runtime key inside the child process. */
export const RUNTIME_API_KEY_ENV = "WORKSPACE_LENS_RUNTIME_KEY";

const FROZEN_MISSING_ALIAS_SHAPE = /^alias .+ is not known; run create or connect first$/;
const MISSING_ALIAS_COMMANDS = new Set(["status", "stop"]);
/** Total per-invocation bound; managed-runtime calls are short-lived. */
const COMMAND_TIMEOUT_MS = 15_000;

export class TunnelAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TunnelAdapterError";
  }
}

export interface RuntimeStatusInput {
  command: string;
  alias: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Normalize one command result into the frozen product state vocabulary
 * (missing/stopped/starting/healthy/unhealthy/recovering/problem). Pure and
 * provider-schema-free: the result carries the state, never exit codes or
 * raw output.
 */
export function normalizeRuntimeStatus(input: RuntimeStatusInput): { state: TunnelRuntimeState } {
  const stderrText = input.stderr.trim();
  if (input.exitCode !== 0) {
    // Option A: the frozen shape matches the alias NAME WILDCARD (the
    // captured fixture's alias differs from the queried one), but only on
    // the exact supported commands and the exact sentence.
    if (MISSING_ALIAS_COMMANDS.has(input.command) && FROZEN_MISSING_ALIAS_SHAPE.test(stderrText)) {
      return { state: "missing" };
    }
    return { state: "problem" };
  }
  const stdoutText = input.stdout.trim();
  // Success with no structured payload (e.g. a quiet stop): the command
  // succeeded, the state maps from the command semantics.
  if (stdoutText === "") {
    return { state: input.command === "stop" ? "stopped" : "starting" };
  }
  try {
    return { state: mapStructuredState(JSON.parse(stdoutText) as unknown) };
  } catch {
    return { state: "problem" };
  }
}

function mapStructuredState(parsed: unknown): TunnelRuntimeState {
  const record = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    status?: unknown;
    health?: unknown;
  };
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

export interface TunnelRuntimeAdapterOptions {
  /** Path to the supported tunnel-client executable. */
  executable: string;
  /** Extra child env (test adapters pass their scenario variables here). */
  env?: Record<string, string>;
  organizationId?: string;
  timeoutMs?: number;
  /** Metadata-only argv capture hook (security contract §18: no secrets in argv). */
  onInvocation?: (argv: string[]) => void;
}

export type ConnectRuntimeInput = ConnectionRuntimeInput;

export interface RuntimeStateResult {
  alias: string;
  state: TunnelRuntimeState;
}

export class TunnelRuntimeAdapter {
  private readonly executable: string;
  private readonly env: Record<string, string>;
  private readonly organizationId: string | undefined;
  private readonly timeoutMs: number;
  private readonly onInvocation: ((argv: string[]) => void) | undefined;

  constructor(options: TunnelRuntimeAdapterOptions) {
    this.executable = options.executable;
    this.env = options.env ?? {};
    this.organizationId = options.organizationId;
    this.timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    this.onInvocation = options.onInvocation;
  }

  /** Detect the managed-runtime binary; a missing binary is a stable error. */
  async detect(): Promise<{ installed: true }> {
    try {
      await execFileAsync(this.executable, ["help"], { timeout: this.timeoutMs });
      return { installed: true };
    } catch (error) {
      throw describeSpawnFailure(error, this.executable);
    }
  }

  /** Create/connect the one product runtime for the stable alias. */
  async connect(input: ConnectRuntimeInput): Promise<RuntimeStateResult> {
    const argv = [
      "runtimes",
      "connect",
      "--alias",
      input.alias,
      "--mcp-server-url",
      input.mcpServerUrl,
      // The literal value travels in the child env; argv carries the reference.
      "--runtime-api-key",
      `env:${RUNTIME_API_KEY_ENV}`,
      ...(this.organizationId !== undefined ? ["--organization-id", this.organizationId] : []),
      "--json",
    ];
    const result = await this.run(argv, input.runtimeApiKey);
    if (result.exitCode !== 0) {
      throw new TunnelAdapterError(
        "TUNNEL_COMMAND_FAILED",
        `tunnel-client connect failed with exit code ${result.exitCode}.`,
      );
    }
    return { alias: input.alias, state: structuredState(result.stdout, "starting") };
  }

  /** Query the managed runtime's structured status. */
  async status(alias: string): Promise<RuntimeStateResult> {
    const result = await this.run(["runtimes", "status", alias, "--json"]);
    return this.interpret(alias, "status", result);
  }

  /** Stop the managed runtime for the alias. */
  async stop(alias: string): Promise<RuntimeStateResult> {
    const result = await this.run(["runtimes", "stop", alias, "--json"]);
    return this.interpret(alias, "stop", result);
  }

  /** Restart = stop (a missing alias is fine) + connect again. */
  async restart(input: ConnectionRuntimeInput): Promise<RuntimeStateResult> {
    try {
      await this.stop(input.alias);
    } catch (error) {
      if (
        !(error instanceof TunnelAdapterError) ||
        error.code !== CONNECTION_ADAPTER_ERROR_CODES.ALIAS_MISSING
      ) {
        throw error;
      }
    }
    return this.connect(input);
  }

  private interpret(
    alias: string,
    command: "status" | "stop",
    result: CommandResult,
  ): RuntimeStateResult {
    const normalized = normalizeRuntimeStatus({
      command,
      alias,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    if (normalized.state === "missing") {
      throw new TunnelAdapterError(
        CONNECTION_ADAPTER_ERROR_CODES.ALIAS_MISSING,
        `The tunnel runtime alias "${alias}" is missing; run connect first.`,
      );
    }
    if (result.exitCode !== 0) {
      throw new TunnelAdapterError(
        "TUNNEL_COMMAND_FAILED",
        `tunnel-client ${command} failed with exit code ${result.exitCode}.`,
      );
    }
    const state = structuredState(result.stdout, command === "stop" ? "stopped" : "starting");
    if (state === "unhealthy") {
      throw new TunnelAdapterError(
        CONNECTION_ADAPTER_ERROR_CODES.TUNNEL_UNHEALTHY,
        "tunnel runtime is unhealthy.",
      );
    }
    if (state === "problem") {
      throw new TunnelAdapterError(
        "TUNNEL_OUTPUT_INVALID",
        "tunnel-client reported an unrecognized runtime state.",
      );
    }
    return { alias, state };
  }

  private async run(argv: string[], runtimeApiKey?: string): Promise<CommandResult> {
    this.onInvocation?.([...argv]);
    const env: Record<string, string> = { ...process.env, ...this.env } as Record<string, string>;
    if (runtimeApiKey !== undefined) {
      env[RUNTIME_API_KEY_ENV] = runtimeApiKey;
    }
    try {
      const { stdout, stderr } = await execFileAsync(this.executable, argv, {
        env,
        timeout: this.timeoutMs,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const errno = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
      // A nonzero EXIT is a command result, not a spawn failure.
      if (typeof errno.code === "number") {
        return { stdout: errno.stdout ?? "", stderr: errno.stderr ?? "", exitCode: errno.code };
      }
      throw describeSpawnFailure(error, this.executable, argv[1]);
    }
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Parse a success payload; an empty payload maps to the command's own state. */
function structuredState(stdout: string, emptyState: TunnelRuntimeState): TunnelRuntimeState {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return emptyState;
  }
  return mapStructuredState(parseStructured(trimmed));
}

function parseStructured(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    throw new TunnelAdapterError(
      "TUNNEL_OUTPUT_INVALID",
      "tunnel-client produced invalid JSON output.",
    );
  }
}

function describeSpawnFailure(
  error: unknown,
  executable: string,
  command?: string,
): TunnelAdapterError {
  const errno = error as NodeJS.ErrnoException;
  if (errno.code === "ENOENT") {
    return new TunnelAdapterError(
      "TUNNEL_BINARY_MISSING",
      `The tunnel-client executable was not found or is not executable: ${executable}`,
    );
  }
  const suffix = command !== undefined ? ` (${command})` : "";
  return new TunnelAdapterError(
    "TUNNEL_COMMAND_FAILED",
    `tunnel-client could not be executed${suffix}.`,
  );
}

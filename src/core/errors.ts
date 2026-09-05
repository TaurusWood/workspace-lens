/**
 * Stable application-level error codes defined by `docs/mcp-tools-spec.md` §4.
 * These codes cross the MCP boundary and must remain stable within v0.x.
 */
export const ERROR_CODES = [
  "INVALID_ARGUMENT",
  "WORKSPACE_NOT_FOUND",
  "WORKSPACE_DISABLED",
  "WORKSPACE_UNAVAILABLE",
  "PATH_INVALID",
  "PATH_OUTSIDE_WORKSPACE",
  "PATH_BLOCKED",
  "PATH_NOT_FOUND",
  "NOT_A_FILE",
  "NOT_A_DIRECTORY",
  "BINARY_FILE_NOT_SUPPORTED",
  "UNSUPPORTED_FILE_TYPE",
  "FILE_TOO_LARGE",
  "NOT_A_GIT_REPOSITORY",
  "GIT_OPERATION_FAILED",
  "SEARCH_FAILED",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE_BY_CODE: Record<ErrorCode, boolean> = {
  INVALID_ARGUMENT: false,
  WORKSPACE_NOT_FOUND: false,
  WORKSPACE_DISABLED: false,
  WORKSPACE_UNAVAILABLE: true,
  PATH_INVALID: false,
  PATH_OUTSIDE_WORKSPACE: false,
  PATH_BLOCKED: false,
  PATH_NOT_FOUND: true,
  NOT_A_FILE: false,
  NOT_A_DIRECTORY: false,
  BINARY_FILE_NOT_SUPPORTED: false,
  UNSUPPORTED_FILE_TYPE: false,
  FILE_TOO_LARGE: false,
  NOT_A_GIT_REPOSITORY: false,
  GIT_OPERATION_FAILED: true,
  SEARCH_FAILED: true,
  INTERNAL_ERROR: true,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options?: { retryable?: boolean; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.retryable = options?.retryable ?? RETRYABLE_BY_CODE[code];
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Successful structured result envelope (`mcp-tools-spec.md` §3.3). */
export interface ToolSuccess<TData> {
  ok: true;
  data: TData;
}

/** Application-level failure envelope (`mcp-tools-spec.md` §3.3). */
export interface ToolError {
  ok: false;
  error: {
    code: ErrorCode;
    message: string;
    retryable: boolean;
  };
}

export type ToolEnvelope<TData> = ToolSuccess<TData> | ToolError;

export const GENERIC_INTERNAL_ERROR_MESSAGE = "An unexpected internal error occurred.";

/**
 * Convert any thrown value into the stable error envelope.
 *
 * Internal exceptions (stack traces, unrelated host paths, raw command lines)
 * MUST NOT cross the MCP boundary (`security-model.md` §14), so unknown
 * errors collapse into a generic INTERNAL_ERROR.
 */
export function errorEnvelope(thrown: unknown): ToolError {
  if (isAppError(thrown)) {
    return {
      ok: false,
      error: {
        code: thrown.code,
        message: thrown.message,
        retryable: thrown.retryable,
      },
    };
  }
  return {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: GENERIC_INTERNAL_ERROR_MESSAGE,
      retryable: RETRYABLE_BY_CODE.INTERNAL_ERROR,
    },
  };
}

export function successEnvelope<TData>(data: TData): ToolSuccess<TData> {
  return { ok: true, data };
}

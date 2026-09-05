import { describe, expect, it } from "vitest";
import {
  AppError,
  GENERIC_INTERNAL_ERROR_MESSAGE,
  ERROR_CODES,
  errorEnvelope,
  isAppError,
  successEnvelope,
} from "../../src/core/errors.js";

describe("AppError", () => {
  it("carries a stable code and default retryable flag", () => {
    const err = new AppError("PATH_BLOCKED", "blocked");
    expect(err.code).toBe("PATH_BLOCKED");
    expect(err.retryable).toBe(false);
    expect(isAppError(err)).toBe(true);
  });

  it("marks documented retryable codes", () => {
    expect(new AppError("WORKSPACE_UNAVAILABLE", "x").retryable).toBe(true);
    expect(new AppError("GIT_OPERATION_FAILED", "x").retryable).toBe(true);
    expect(new AppError("SEARCH_FAILED", "x").retryable).toBe(true);
    expect(new AppError("INTERNAL_ERROR", "x").retryable).toBe(true);
    expect(new AppError("PATH_NOT_FOUND", "x").retryable).toBe(true);
    expect(new AppError("INVALID_ARGUMENT", "x").retryable).toBe(false);
  });

  it("covers every documented error code", () => {
    // mcp-tools-spec.md §4 defines exactly these codes.
    expect(ERROR_CODES).toHaveLength(17);
  });
});

describe("errorEnvelope", () => {
  it("converts AppError into the stable error envelope", () => {
    const envelope = errorEnvelope(new AppError("WORKSPACE_NOT_FOUND", "no such workspace"));
    expect(envelope).toEqual({
      ok: false,
      error: { code: "WORKSPACE_NOT_FOUND", message: "no such workspace", retryable: false },
    });
  });

  it("converts unknown exceptions into a generic INTERNAL_ERROR without internals", () => {
    const internal = new Error("EACCES: permission denied, open /Users/me/.ssh/id_rsa");
    const envelope = errorEnvelope(internal);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("INTERNAL_ERROR");
    expect(envelope.error.message).toBe(GENERIC_INTERNAL_ERROR_MESSAGE);
    expect(JSON.stringify(envelope)).not.toContain("/Users/me");
    expect(JSON.stringify(envelope)).not.toContain("EACCES");
  });

  it("never leaks stack traces in the envelope", () => {
    const err = new Error("boom");
    const text = JSON.stringify(errorEnvelope(err));
    expect(text).not.toContain("at ");
    expect(text).not.toContain("stack");
  });
});

describe("successEnvelope", () => {
  it("wraps data in the ok envelope", () => {
    expect(successEnvelope({ a: 1 })).toEqual({ ok: true, data: { a: 1 } });
  });
});

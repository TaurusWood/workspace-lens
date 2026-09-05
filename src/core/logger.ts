/**
 * Metadata-only operational logging (`security-model.md` §12).
 *
 * Logs go to stderr because stdout carries the MCP protocol when running on
 * stdio transport. Log lines MUST NOT contain file bodies, diff bodies,
 * search snippets, or credential values — callers pass only stable
 * metadata fields.
 */
export type LogFields = {
  tool?: string;
  workspace_id?: string;
  duration_ms?: number;
  result_count?: number;
  code?: string;
  truncated?: boolean;
  event?: string;
  detail?: string;
};

export interface Logger {
  /** One line per tool invocation with metadata only. */
  toolCall(fields: LogFields): void;
  /** Operational lifecycle messages (startup, shutdown, config problems). */
  event(event: string, detail?: string): void;
  /** Error details for local diagnostics; never workspace content. */
  error(event: string, message: string): void;
}

export class StderrLogger implements Logger {
  private emit(level: "info" | "error", fields: LogFields): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, ...fields });
    process.stderr.write(`${line}\n`);
  }

  toolCall(fields: LogFields): void {
    this.emit("info", { event: "tool_call", ...fields });
  }

  event(event: string, detail?: string): void {
    this.emit("info", { event, detail });
  }

  error(event: string, message: string): void {
    this.emit("error", { event, detail: message });
  }
}

/**
 * Uniform tool execution wrapper.
 *
 * Responsibilities (orchestration only — no filesystem security logic):
 * - convert AppError/unknown throws into the stable result envelope
 *   (`security-model.md` §14: no stacks, no host internals);
 * - emit metadata-only logs (`security-model.md` §12);
 * - shape the MCP CallToolResult with the envelope as structured content
 *   plus a model-readable text fallback (`mcp-tools-spec.md` §2).
 */
import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorEnvelope, type ToolEnvelope } from "../core/errors.js";
import type { ToolContext } from "./context.js";

export interface ToolDefinition<TSchema extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: TSchema;
  run: (
    args: z.output<TSchema>,
    context: ToolContext,
  ) => Promise<ToolEnvelope<unknown>> | ToolEnvelope<unknown>;
}

export function describeToolError(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function countResults(data: unknown): number | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  for (const key of ["workspaces", "entries", "matches", "sections"]) {
    const value = (data as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length;
  }
  return undefined;
}

export function createToolHandler<TSchema extends z.ZodType>(
  definition: ToolDefinition<TSchema>,
  context: ToolContext,
): (args: z.output<TSchema>) => Promise<CallToolResult> {
  return async (parsedArgs) => {
    const startedAt = Date.now();
    const args = parsedArgs as Record<string, unknown>;
    const workspaceId = typeof args.workspace_id === "string" ? args.workspace_id : undefined;
    let logged = false;
    const logResult = (envelope: ToolEnvelope<unknown>): void => {
      logged = true;
      context.logger.toolCall({
        tool: definition.name,
        workspace_id: workspaceId,
        duration_ms: Date.now() - startedAt,
        result_count: envelope.ok ? countResults(envelope.data) : undefined,
        code: envelope.ok ? undefined : envelope.error.code,
        truncated: envelope.ok
          ? typeof (envelope.data as { truncated?: unknown })?.truncated === "boolean"
            ? ((envelope.data as { truncated: boolean }).truncated)
            : undefined
          : undefined,
      });
    };

    try {
      const envelope = await definition.run(parsedArgs, context);
      logResult(envelope);
      return toCallToolResult(envelope, !envelope.ok);
    } catch (thrown) {
      // Handlers normally return envelopes; this is defense in depth so no
      // raw exception ever crosses the MCP boundary.
      if (!logged) {
        context.logger.toolCall({
          tool: definition.name,
          workspace_id: workspaceId,
          duration_ms: Date.now() - startedAt,
          code: "INTERNAL_ERROR",
        });
      }
      context.logger.error("tool_failure", describeToolError(thrown));
      const envelope = errorEnvelope(thrown);
      return toCallToolResult(envelope, true);
    }
  };
}

function toCallToolResult(envelope: ToolEnvelope<unknown>, isError: boolean): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    isError,
  };
}

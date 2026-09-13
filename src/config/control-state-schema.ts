/**
 * Non-secret control state schema (`docs/v0.3-implementation-plan.md` §12,
 * `docs/v0.3-technical-architecture-rfc.md` §7.2).
 *
 * Control state holds WorkspaceLens-owned non-secret product state, strictly
 * separated from the workspace authorization config. Forbidden content by
 * contract: runtime/admin keys, tokens, ChatGPT conversation identifiers,
 * CR/plan/task state, and machine-derived connection/health "truth" — the
 * strict schema rejects unknown fields, so secret-shaped payloads cannot be
 * persisted even accidentally.
 */
import { z } from "zod";
import { ConfigError } from "../config/config-schema.js";

export const CONTROL_STATE_VERSION = 1;

export const controlStateSchema = z
  .object({
    version: z.literal(CONTROL_STATE_VERSION),
    preferences: z.object({
      /** Desired state: connect the tunnel runtime after startup. */
      autoConnect: z.boolean(),
      /** Desired state: launch the Control Runtime at login. */
      startAtLogin: z.boolean(),
    }),
  })
  .strict();

export type ControlStateDocument = z.infer<typeof controlStateSchema>;

export function defaultControlState(): ControlStateDocument {
  return { version: CONTROL_STATE_VERSION, preferences: { autoConnect: false, startAtLogin: false } };
}

/** Parse persisted control state; any structural problem fails closed. */
export function parseControlState(raw: unknown): ControlStateDocument {
  const result = controlStateSchema.safeParse(raw);
  if (!result.success) {
    throw new ConfigError("Control state is malformed or uses an unsupported version.");
  }
  return result.data;
}

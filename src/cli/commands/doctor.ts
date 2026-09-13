import { ConfigStore } from "../../config/config-store.js";
import { DiagnosticsService } from "../../application/diagnostics-service.js";
import { detectTunnelClient } from "../../integrations/openai/tunnel.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

/**
 * `doctor` — a text formatter over the shared DiagnosticsService
 * (`docs/v0.3-implementation-plan.md` §9): CLI and the future Control API
 * derive their diagnostics from ONE structured result. Never prints secrets,
 * file contents, API keys, or environment dumps; messages are bounded and
 * path-free (redaction lives in the service).
 */
export async function runDoctor(_args: readonly string[], io: CliIo): Promise<number> {
  const service = new DiagnosticsService({
    configStore: new ConfigStore(),
    detectTunnel: detectTunnelClient,
  });
  const checks = await service.run();

  for (const line of service.formatAsText(checks).split("\n")) {
    writeLine(io.out, line);
  }
  const failed = checks.filter((check) => check.status === "error").length;
  return failed === 0 ? 0 : 1;
}

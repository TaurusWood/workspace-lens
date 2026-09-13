import {
  defaultControlStatePath,
  defaultRuntimeStatePath,
  startControlRuntime,
} from "../../control/runtime.js";
import { describeError } from "../../config/config-store.js";
import { defaultConfigPath } from "../../config/config-store.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

const CONTROL_USAGE = `Usage: workspace-lens control [--port <port>]`;

/**
 * `workspace-lens control` — advanced/foreground command that runs the one
 * long-lived Control Runtime on loopback (`docs/v0.3-implementation-plan.md`
 * §7). A healthy existing runtime for the same state root is reused, never
 * duplicated. Ctrl+C (SIGINT) or SIGTERM stops the runtime gracefully; the
 * browser is never the runtime's owner.
 */
export async function runControl(args: readonly string[], io: CliIo): Promise<number> {
  let port = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port") {
      const value = args[i + 1];
      const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        writeLine(io.err, "error: --port requires a valid port number");
        writeLine(io.err, CONTROL_USAGE);
        return 2;
      }
      port = parsed;
      i += 1;
    } else if (arg !== undefined && arg.startsWith("-")) {
      writeLine(io.err, `error: Unknown option: ${arg}`);
      writeLine(io.err, CONTROL_USAGE);
      return 2;
    }
  }

  try {
    const runtime = await startControlRuntime({
      configPath: defaultConfigPath(),
      controlStatePath: defaultControlStatePath(),
      runtimeStatePath: defaultRuntimeStatePath(),
      port,
    });
    if (runtime.reused) {
      writeLine(io.out, `Reusing the running Control Runtime at ${runtime.baseUrl}`);
    } else {
      writeLine(io.out, `Control Runtime listening on ${runtime.baseUrl}`);
    }
    writeLine(io.out, "Press Ctrl+C to stop.");

    const shutdown = (signal: string): void => {
      writeLine(io.out, `\nReceived ${signal}; stopping the Control Runtime...`);
      void runtime.runtime
        .stop()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    return 0;
  } catch (error) {
    writeLine(io.err, `error: ${describeError(error)}`);
    return 1;
  }
}

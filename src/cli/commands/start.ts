import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  defaultControlStatePath,
  defaultRuntimeStatePath,
  startControlRuntime,
  type ControlRuntimeOptions,
} from "../../control/runtime.js";
import { defaultConfigPath, describeError } from "../../config/config-store.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

export interface StartOptions extends Partial<ControlRuntimeOptions> {
  browserLauncher?: (url: string) => void | Promise<void>;
}

export interface StartResult {
  url: string;
  baseUrl: string;
  reused: boolean;
  pid: number;
  instanceId: string;
  capturedCliInvocations: string[];
  runtime: {
    baseUrl: string;
    stop(): Promise<void>;
  };
}

/**
 * Open the default system browser in a platform-agnostic, non-blocking way.
 * Fails silently if unavailable (e.g. headless, SSH, CI).
 */
export async function openBrowserSafely(url: string): Promise<void> {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    } else if (platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", url], { stdio: "ignore", detached: true }).unref();
    } else {
      spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
    }
  } catch {
    // Non-fatal fallback
  }
}

/**
 * Programmatic entry point for starting or reusing the Control Runtime.
 * Used by spawnProductChild and direct API consumers.
 */
export async function runStart(options: StartOptions = {}): Promise<StartResult> {
  const configPath = options.configPath ?? defaultConfigPath();
  const controlStatePath = options.controlStatePath ?? defaultControlStatePath();
  const runtimeStatePath = options.runtimeStatePath ?? defaultRuntimeStatePath();

  const handle = await startControlRuntime({
    configPath,
    controlStatePath,
    runtimeStatePath,
    ...options,
  });

  if (typeof options.browserLauncher === "function") {
    try {
      await options.browserLauncher(handle.baseUrl);
    } catch {
      // Browser launch errors are non-fatal
    }
  }

  return {
    url: handle.baseUrl,
    baseUrl: handle.baseUrl,
    reused: handle.reused,
    pid: process.pid,
    instanceId: handle.instanceId,
    capturedCliInvocations: ["start"],
    runtime: handle.runtime,
  };
}

/**
 * CLI command entry: `workspace-lens start`
 */
export async function runStartCli(args: readonly string[], io: CliIo): Promise<number> {
  let port = 0;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--port") {
      const val = args[i + 1];
      const parsed = val !== undefined ? Number.parseInt(val, 10) : Number.NaN;
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) {
        writeLine(io.err, "error: --port requires a valid port number");
        return 2;
      }
      port = parsed;
      i += 1;
    } else if (arg !== undefined && arg.startsWith("-")) {
      writeLine(io.err, `error: Unknown option: ${arg}`);
      return 2;
    }
  }

  const runtimeStatePath = defaultRuntimeStatePath();

  try {
    // 1. Probe for an existing healthy runtime
    const runtimeStateFile = path.join(runtimeStatePath, "runtime.json");
    if (fs.existsSync(runtimeStateFile)) {
      try {
        const state = JSON.parse(fs.readFileSync(runtimeStateFile, "utf8"));
        if (state.baseUrl && typeof state.baseUrl === "string") {
          const res = await fetch(`${state.baseUrl}/healthz`, { signal: AbortSignal.timeout(1000) }).catch(() => null);
          if (res && res.status === 200) {
            writeLine(io.out, `Reusing the running Control Runtime at ${state.baseUrl}`);
            await openBrowserSafely(state.baseUrl);
            return 0;
          }
        }
      } catch {
        // State file invalid or unreachable; proceed to fresh launch
      }
    }

    // 2. Launch background control process
    const cliIndex = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../index.js");
    const childArgs = ["control"];
    if (port > 0) {
      childArgs.push("--port", String(port));
    }

    const child = spawn(process.execPath, [cliIndex, ...childArgs], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });
    child.unref();

    // 3. Poll for runtime readiness
    const deadline = Date.now() + 10000;
    let baseUrl = "";
    while (Date.now() < deadline) {
      if (fs.existsSync(runtimeStateFile)) {
        try {
          const state = JSON.parse(fs.readFileSync(runtimeStateFile, "utf8"));
          if (state.baseUrl) {
            const probe = await fetch(`${state.baseUrl}/healthz`, { signal: AbortSignal.timeout(500) }).catch(() => null);
            if (probe && probe.status === 200) {
              baseUrl = state.baseUrl;
              break;
            }
          }
        } catch {
          // Retry until ready
        }
      }
      await new Promise((r) => setTimeout(r, 100));
    }

    if (!baseUrl) {
      writeLine(io.err, "error: Control Runtime failed to start within timeout.");
      return 1;
    }

    writeLine(io.out, `Control Runtime listening on ${baseUrl}`);
    await openBrowserSafely(baseUrl);
    return 0;
  } catch (error) {
    writeLine(io.err, `error: ${describeError(error)}`);
    return 1;
  }
}

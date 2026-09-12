/**
 * Child-process harness for product-level start/control tests.
 *
 * Per the Test CR, product-level flows (`workspace-lens start`, Control
 * Runtime) run in a DEDICATED child process with HOME, XDG_CONFIG_HOME,
 * XDG_STATE_HOME and WORKSPACE_LENS_CONFIG pointed at the isolated state
 * root, and with Secret/Startup/Tunnel adapter objects inlined into the
 * generated child script — so a product implementation that ignores the
 * injected dependencies and writes the real user config, the real keychain,
 * or real LaunchAgents is caught instead of silently touching developer
 * state.
 *
 * Lifecycle protocol (leak-proof):
 *   spawn child → child signals readiness (result file: url + pid)
 *   → test probes over HTTP → test calls stop()
 *   → SIGTERM to child → child stops its runtime → parent polls the port
 *   until it refuses connections (a still-open port fails the test).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IsolatedProductEnv } from "./isolated-env.js";
import { inMemorySecretAdapter, inMemoryStartupAdapter, stubTunnelAdapter } from "./test-adapters.js";

const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist");

export interface ProductChildOptions {
  /** Which dist command module to run in the child. */
  entry: "start" | "control";
  /** Extra run options rendered into the child script (JSON-serializable). */
  extraOptions?: Record<string, unknown>;
  tunnelState?: "stopped" | "starting" | "healthy" | "unhealthy";
}

export interface ProductChild {
  /** Local WebUI/base URL reported by the product. */
  url: string;
  /** PID of the child process (also the runtime owner in this harness). */
  pid: number;
  /** Full result payload written by the child (url/pid/reused/...). */
  result: Record<string, any>;
  /**
   * SIGTERM the child, then wait for its runtime to drain the port. Pass
   * `expectDrain: false` when this child only REUSED an existing runtime
   * (it is not the owner; the owner's stop() drains the port).
   */
  stop(options?: { expectDrain?: boolean }): Promise<void>;
}

function portOf(url: string): number {
  return Number.parseInt(new URL(url).port ?? "0", 10);
}

async function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${file}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function waitPortClosed(port: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!open) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`RUNTIME LEAK: port ${port} is still accepting connections after stop`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function spawnProductChild(
  env: IsolatedProductEnv,
  options: ProductChildOptions,
): Promise<ProductChild> {
  const childDir = fs.mkdtempSync(path.join(env.stateRoot, "child-"));
  const resultFile = path.join(childDir, "result.json");
  const urlFile = path.join(childDir, "url.txt");
  const entryModule =
    options.entry === "start"
      ? path.join(DIST_ROOT, "cli/commands/start.js")
      : path.join(DIST_ROOT, "control/runtime.js");
  const entryExport = options.entry === "start" ? "runStart" : "startControlRuntime";

  // The child script inlines the SAME test adapter objects the in-process
  // harness would inject — production code sees objects, never magic strings,
  // and can never reach the real keychain/LaunchAgents/tunnel binary.
  const script = `
import fs from "node:fs";
const resultFile = ${JSON.stringify(resultFile)};
const urlFile = ${JSON.stringify(urlFile)};
try {
  const { ${entryExport} } = await import(${JSON.stringify(entryModule)});
  // Adapter objects are constructed inline (no cross-process object passing):
  // production code sees objects, never magic "test"/"stub" mode strings.
  const secretAdapter = {
    available: async () => true,
    get: async (name) => globalThis.__secretMap.get(name),
    set: async (name, value) => { globalThis.__secretMap.set(name, value); },
    delete: async (name) => { globalThis.__secretMap.delete(name); },
  };
  globalThis.__secretMap = new Map();
  const startupAdapter = {
    status: async () => ({ enabled: false, entries: [] }),
    enable: async () => {},
    disable: async () => {},
    buildDefinition: async (input) => ({ ...input, id: "workspace-lens-test-startup" }),
    reconcile: async () => ({ state: "healthy", runtimeCanStart: true }),
  };
  const tunnelState = ${JSON.stringify(options.tunnelState ?? "healthy")};
  const tunnelAdapter = {
    detect: async () => ({ installed: true, version: "test-stub" }),
    connect: async (input) => ({ alias: input.alias }),
    status: async (alias) => ({ alias, state: tunnelState }),
    stop: async () => {},
    restart: async (input) => ({ alias: input.alias }),
    invocations: () => [],
  };
  const result = await ${entryExport}({
    configPath: ${JSON.stringify(env.configPath)},
    controlStatePath: ${JSON.stringify(env.controlStatePath)},
    runtimeStatePath: ${JSON.stringify(env.runtimeStatePath)},
    secretNamespace: ${JSON.stringify(env.secretNamespace)},
    secretAdapter,
    startupAdapter,
    tunnelAdapter,
    browserLauncher: (url) => { fs.writeFileSync(urlFile, url); },
    port: 0,
    ...${JSON.stringify(options.extraOptions ?? {})},
  });
  fs.writeFileSync(resultFile, JSON.stringify({
    url: result.url ?? result.baseUrl,
    pid: process.pid,
    reused: result.reused === true,
    runtimeBaseUrl: result.runtime?.baseUrl ?? result.baseUrl ?? result.url,
    capturedCliInvocations: result.capturedCliInvocations ?? [],
  }));
  process.on("SIGTERM", () => {
    void Promise.resolve(result.runtime?.stop?.()).finally(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void Promise.resolve(result.runtime?.stop?.()).finally(() => process.exit(0));
  });
  // Keep the child alive as the runtime owner until the parent stops it.
  setInterval(() => {}, 1 << 30);
} catch (error) {
  fs.writeFileSync(resultFile, JSON.stringify({ error: String(error && error.message) }));
  process.exit(1);
}
`;
  const scriptFile = path.join(childDir, "product-child.mjs");
  fs.writeFileSync(scriptFile, script);

  const child = spawn(process.execPath, [scriptFile], {
    cwd: childDir,
    env: { ...process.env, ...env.env },
    stdio: ["ignore", "ignore", "pipe"],
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
    child.on("error", () => resolve(-1));
  });

  await waitForFile(resultFile, 30000);
  const result = JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<string, any>;
  if (result.error) {
    child.kill("SIGTERM");
    if (/Cannot find module/.test(String(result.error)) && /dist/.test(String(result.error))) {
      throw new Error(
        "BLOCKED: built dist output missing for the product child; run `npm run build` " +
          "before the v0.3 contract suite. Detail: " + String(result.error),
      );
    }
    throw new Error(`Product child failed to start: ${result.error}`);
  }
  const url: string = result.url ?? fs.readFileSync(urlFile, "utf8").trim();

  return {
    url,
    pid: result.pid,
    result,
    async stop(options: { expectDrain?: boolean } = {}): Promise<void> {
      // Stop protocol: SIGTERM → child stops its runtime → port must drain.
      child.kill("SIGTERM");
      if (options.expectDrain !== false) {
        const port = portOf(result.runtimeBaseUrl ?? url);
        if (port > 0) {
          await waitPortClosed(port);
        }
      }
      await Promise.race([exitPromise, new Promise((resolve) => setTimeout(resolve, 5000))]);
      fs.rmSync(childDir, { recursive: true, force: true });
    },
  };
}

// Re-exported so generated child scripts and tests share one adapter source.
export { inMemorySecretAdapter, inMemoryStartupAdapter, stubTunnelAdapter };

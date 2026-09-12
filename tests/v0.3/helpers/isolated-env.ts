/**
 * Isolated product environment for v0.3 contract tests.
 *
 * Product-level tests (Control Runtime, `start`, E2E) must never touch the
 * developer's real user state (`~/.config/workspace-lens`, the real runtime
 * lock, real tunnel aliases, the OS keychain, or real login-startup entries)
 * — `docs/v0.3-test-contract.md` §14 requires a clean temporary user/config
 * state. Every product-facing test receives its environment from this helper
 * and passes the returned options into the runtime/start command, which must
 * honor them instead of process-global defaults.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTempRoot } from "../../helpers/fixtures.js";

export interface IsolatedProductEnv {
  /** Temporary HOME/state root; every product artifact must live inside. */
  stateRoot: string;
  /** Isolated workspace authorization config file. */
  configPath: string;
  /** Isolated non-secret control state file. */
  controlStatePath: string;
  /** Isolated runtime state directory (lock, runtime metadata). */
  runtimeStatePath: string;
  /** Test-only secret namespace; never the user's real OS keychain entries. */
  secretNamespace: string;
  /** Environment patch (HOME/WORKSPACE_LENS_CONFIG/...) for child processes. */
  env: Record<string, string>;
  /** Recursively lists every artifact the product created in the state root. */
  listStateRootFiles(): string[];
  /** Reads a state-root file relative to the state root. */
  readStateFile(relative: string): string | undefined;
  cleanup(): void;
}

export function createIsolatedProductEnv(tag: string): IsolatedProductEnv {
  const stateRoot = makeTempRoot(`wl-v03-${tag}-env-`);
  const configPath = path.join(stateRoot, "config", "workspace-lens", "config.json");
  const controlStatePath = path.join(stateRoot, "config", "workspace-lens", "control-state.json");
  const runtimeStatePath = path.join(stateRoot, "local", "state", "workspace-lens");
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtimeStatePath, { recursive: true, mode: 0o700 });

  return {
    stateRoot,
    configPath,
    controlStatePath,
    runtimeStatePath,
    secretNamespace: `workspace-lens-v0.3-test-${tag}`,
    env: {
      HOME: stateRoot,
      WORKSPACE_LENS_CONFIG: configPath,
      WL_V03_CONTROL_STATE_PATH: controlStatePath,
      WL_V03_RUNTIME_STATE_PATH: runtimeStatePath,
    },
    listStateRootFiles(): string[] {
      const files: string[] = [];
      const walk = (dir: string): void => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(absolute);
          } else {
            files.push(path.relative(stateRoot, absolute));
          }
        }
      };
      walk(stateRoot);
      return files;
    },
    readStateFile(relative: string): string | undefined {
      const absolute = path.join(stateRoot, relative);
      return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
    },
    cleanup(): void {
      fs.rmSync(stateRoot, { recursive: true, force: true });
    },
  };
}

/**
 * Canonical product-facing options every Control Runtime / `start` invocation
 * in the v0.3 contract suite must receive: isolated state, test adapters, and
 * a no-op browser launcher. Adapters are named by the implementation plan
 * (injectable browser-launch adapter, tunnel stub, startup test adapter).
 */
export function isolatedProductOptions(env: IsolatedProductEnv): Record<string, unknown> {
  return {
    configPath: env.configPath,
    controlStatePath: env.controlStatePath,
    runtimeStatePath: env.runtimeStatePath,
    secretNamespace: env.secretNamespace,
    secretAdapter: "test",
    startupAdapter: "test",
    tunnelAdapter: "stub",
    browserLauncher: () => {},
    env: env.env,
  };
}

/** Guard: the real user config must never exist inside a test state root. */
export function assertNoRealUserState(env: IsolatedProductEnv): void {
  const realDefault = path.join(os.homedir(), ".config", "workspace-lens");
  if (realDefault.startsWith(env.stateRoot)) {
    throw new Error("Isolated env resolved into the real user home; refusing to continue");
  }
}

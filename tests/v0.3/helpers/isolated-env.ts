/**
 * Isolated product environment for v0.3 contract tests.
 *
 * Product-level tests (Control Runtime, `start`, E2E) must never touch the
 * developer's real user state (`~/.config/workspace-lens`, the real runtime
 * lock, real tunnel aliases, the OS keychain, or real login-startup entries)
 * — `docs/v0.3-test-contract.md` §14 requires a clean temporary user/config
 * state. Two complementary layers enforce this:
 *
 * 1. Isolated FILES: every artifact (config, control state, runtime state)
 *    lives inside a temporary state root, and `assertNoRealUserState` guards
 *    against accidental aliasing of the real home.
 * 2. Isolated PROCESS + ADAPTERS: product-level flows run in a dedicated
 *    child process (see `spawn-product-child.ts`) with HOME,
 *    XDG_CONFIG_HOME, XDG_STATE_HOME and WORKSPACE_LENS_CONFIG pointed at
 *    the temp state root, and with Secret/Startup/Tunnel adapter OBJECTS
 *    injected from the tests (`test-adapters.ts`) — never production
 *    "test-mode" strings and never the real OS integrations.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeTempRoot } from "../../helpers/fixtures.js";
import {
  inMemorySecretAdapter,
  inMemoryStartupAdapter,
  stubTunnelAdapter,
} from "./test-adapters.js";

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
  /** Environment patch (HOME, XDG_* vars, WORKSPACE_LENS_CONFIG) for children. */
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
      XDG_CONFIG_HOME: path.join(stateRoot, ".config"),
      XDG_DATA_HOME: path.join(stateRoot, ".local", "share"),
      XDG_STATE_HOME: path.join(stateRoot, ".local", "state"),
      WORKSPACE_LENS_CONFIG: configPath,
      // Secret stores keyed to the test namespace only.
      WORKSPACE_LENS_SECRET_NAMESPACE: `workspace-lens-v0.3-test-${tag}`,
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
 * in the v0.3 contract suite must receive: isolated state paths, injected
 * adapter OBJECTS from the tests (never production "test-mode" strings), and
 * a no-op browser launcher.
 */
export function isolatedProductOptions(env: IsolatedProductEnv): Record<string, unknown> {
  return {
    configPath: env.configPath,
    controlStatePath: env.controlStatePath,
    runtimeStatePath: env.runtimeStatePath,
    secretNamespace: env.secretNamespace,
    secretAdapter: inMemorySecretAdapter(),
    startupAdapter: inMemoryStartupAdapter(),
    tunnelAdapter: stubTunnelAdapter("stopped"),
    browserLauncher: () => {},
    env: env.env,
  };
}

/** Guard: the real user config must never exist inside a test state root. */
export function assertNoRealUserState(env: IsolatedProductEnv): void {
  const realDefault = path.join(os.homedir(), ".config", "workspace-lens");
  if (realDefault.startsWith(env.stateRoot) || env.stateRoot.startsWith(realDefault)) {
    throw new Error("Isolated env overlaps the real user home; refusing to continue");
  }
}

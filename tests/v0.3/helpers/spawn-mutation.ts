/**
 * Multi-process mutation helpers for CFG-001/002/004
 * (`docs/v0.3-test-contract.md` §5: "separate-process concurrency, not only
 * two async calls sharing one in-memory mutex").
 *
 * Child processes run plain Node against the built `dist/` output (the same
 * package shape users execute), coordinate through ready/go gate files so
 * their mutation windows genuinely overlap, and are launched concurrently.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIST_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist");

export const CHILD_EXIT_MODULE_MISSING = 3;

function waitForFile(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = (): void => {
      if (fs.existsSync(file)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`Timed out waiting for ${file}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

export interface MutationChildSpec {
  /** Unique child tag; also names its ready file. */
  tag: string;
  /** Workspace root the child adds through the application service. */
  root: string;
  id: string;
}

export interface MutationChildHandle {
  tag: string;
  exitCode: Promise<number>;
  ready: Promise<void>;
  goFile: string;
}

/**
 * Spawn one independent child process that waits for the shared go-file and
 * then adds its workspace through the shared application service. When the
 * v0.3 application module does not exist in dist/, the child exits with
 * CHILD_EXIT_MODULE_MISSING so the contract test reports RED instead of a
 * confusing spawn failure.
 */
export function spawnMutationChild(configPath: string, spec: MutationChildSpec, gateDir: string): MutationChildHandle {
  const readyFile = path.join(gateDir, `${spec.tag}.ready`);
  const goFile = path.join(gateDir, "go");
  const script = `
import fs from "node:fs";
const readyFile = ${JSON.stringify(readyFile)};
const goFile = ${JSON.stringify(goFile)};
try {
  const { ConfigStore } = await import(${JSON.stringify(path.join(DIST_ROOT, "config/config-store.js"))});
  let WorkspaceAdminService;
  try {
    ({ WorkspaceAdminService } = await import(${JSON.stringify(path.join(DIST_ROOT, "application/workspace-admin-service.js"))}));
  } catch {
    console.error("CHILD_MODULE_MISSING: application/workspace-admin-service.js not built");
    process.exit(${CHILD_EXIT_MODULE_MISSING});
  }
  const service = new WorkspaceAdminService({ configStore: new ConfigStore(${JSON.stringify(configPath)}) });
  fs.writeFileSync(readyFile, String(process.pid));
  const deadline = Date.now() + 30000;
  while (!fs.existsSync(goFile)) {
    if (Date.now() > deadline) { console.error("go gate timeout"); process.exit(4); }
    await new Promise((r) => setTimeout(r, 10));
  }
  await service.add({ root: ${JSON.stringify(spec.root)}, id: ${JSON.stringify(spec.id)} });
  process.exit(0);
} catch (error) {
  console.error("CHILD_ERROR:", error && error.message);
  process.exit(1);
}
`;
  const scriptFile = path.join(gateDir, `${spec.tag}.mutation.mjs`);
  fs.writeFileSync(scriptFile, script);
  const child = spawn(process.execPath, [scriptFile], {
    cwd: gateDir,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    waitForFile(readyFile, 30000).then(
      () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      },
      reject,
    );
    child.on("exit", (code) => {
      if (!settled && !fs.existsSync(readyFile)) {
        settled = true;
        reject(new Error(`Child ${spec.tag} exited with code ${code} before readiness: ${stderr.trim()}`));
      }
    });
  });
  const exitCode = new Promise<number>((resolve, reject) => {
    child.on("exit", (code) => resolve(code ?? -1));
    child.on("error", reject);
    // Surface module-missing/child errors through stderr on failure paths.
    void stderr;
  });
  return { tag: spec.tag, exitCode, ready, goFile };
}

/** Release all children waiting on the shared gate. */
export async function releaseChildren(children: MutationChildHandle[]): Promise<void> {
  await Promise.all(children.map((child) => child.ready));
  // Children observe the go file at most 10ms after it appears; write it once.
  fs.writeFileSync(children[0]!.goFile, "go");
}

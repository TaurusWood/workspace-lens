/**
 * Git adapter — inspection-only access through fixed, validated command
 * templates (`security-model.md` §7, `implementation-plan.md` §13).
 *
 * Rules enforced here:
 * - the executable is selected by WorkspaceLens, never by tool input;
 * - arguments are fixed templates; no caller-provided Git flags exist;
 * - processes are spawned without a shell;
 * - pagers, external diff programs, and textconv are disabled;
 * - GIT_OPTIONAL_LOCKS=0 keeps status/diff operations from writing the index.
 */
import { execFile } from "node:child_process";

const GIT_EXECUTABLE = "git";
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** Fixed configuration overrides applied to every Git invocation. */
const GIT_CONFIG_ARGS: readonly string[] = [
  "-c",
  "core.pager=cat",
  "-c",
  "core.quotepath=false",
  "-c",
  "core.abbrev=12",
];

/** Environment hardening applied to every Git invocation. */
const GIT_ENV_OVERRIDES: Readonly<Record<string, string>> = {
  GIT_OPTIONAL_LOCKS: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
};

export interface GitRunResult {
  /** Process exit code, or -1 when the process was killed/timed out. */
  code: number;
  stdout: string;
  stderr: string;
}

export class GitSpawnError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GitSpawnError";
  }
}

/**
 * Run a fixed Git command template. `args` must be built from validated,
 * typed fields only — never from raw tool input.
 */
export function runGit(cwd: string, args: readonly string[]): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      GIT_EXECUTABLE,
      [...GIT_CONFIG_ARGS, ...args],
      {
        cwd,
        shell: false,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_BUFFER_BYTES,
        windowsHide: true,
        env: { ...process.env, ...GIT_ENV_OVERRIDES },
      },
      (error, stdout, stderr) => {
        if (error === null || error === undefined) {
          resolve({ code: 0, stdout: stdout.toString(), stderr: stderr.toString() });
          return;
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code === "string") {
          // Spawn-level failure (git missing, permission denied on exec).
          reject(new GitSpawnError("Git executable is not available.", { cause: error }));
          return;
        }
        resolve({
          code: error.killed ? -1 : typeof error.code === "number" ? error.code : -1,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

/** Whether a Git working tree was detected locally. Never mutates state. */
export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    const result = await runGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
    return result.code === 0 && result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

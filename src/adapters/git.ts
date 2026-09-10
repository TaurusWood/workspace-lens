/**
 * Git adapter — inspection-only access through fixed, validated command
 * templates (`security-model.md` §7, `implementation-plan.md` §13).
 *
 * Rules enforced here:
 * - the executable is selected by WorkspaceLens, never by tool input;
 * - arguments are fixed templates built from validated, typed fields; no
 *   caller-provided Git flags exist;
 * - processes are spawned without a shell;
 * - pagers, external diff programs, and textconv filters are disabled;
 * - GIT_OPTIONAL_LOCKS=0 keeps status/diff from writing the index;
 * - Git is not a security boundary: every path that leaves the adapter is
 *   mapped back into the workspace and filtered through the AccessPolicy,
 *   so blocked paths never expose names or diff bodies.
 */
import { execFile, spawn } from "node:child_process";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { AppError } from "../core/errors.js";
import type { ServerLimits } from "../core/limits.js";
import type { AccessPolicy } from "../core/access-policy.js";
import { PathResolver } from "../core/path-resolver.js";

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
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "core.hooksPath=",
  "-c",
  "diff.external=",
  "-c",
  "diff.textconv=",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.renameLimit=10000",
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

export interface GitBoundedRunResult extends GitRunResult {
  truncated: boolean;
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

/**
 * Stream Git stdout with a strict byte ceiling. If stdout reaches byteLimit,
 * the child process is terminated immediately with SIGTERM to prevent unbounded
 * memory growth or Node maxBuffer exhaustion on multi-megabyte diffs.
 */
export function runGitBounded(
  cwd: string,
  args: readonly string[],
  byteLimit: number,
): Promise<GitBoundedRunResult> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(GIT_EXECUTABLE, [...GIT_CONFIG_ARGS, ...args], {
        cwd,
        shell: false,
        windowsHide: true,
        env: { ...process.env, ...GIT_ENV_OVERRIDES },
      });
    } catch (error) {
      reject(new GitSpawnError("Git executable is not available.", { cause: error }));
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let truncated = false;
    let killedByLimit = false;

    child.on("error", (error) => {
      reject(new GitSpawnError("Git executable is not available.", { cause: error }));
    });

    if (child.stdout === null || child.stderr === null) {
      reject(new GitSpawnError("Failed to open child process stdio pipes."));
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, GIT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      chunks.push(chunk);
      receivedBytes += chunk.length;
      if (receivedBytes >= byteLimit) {
        truncated = true;
        killedByLimit = true;
        child.kill("SIGTERM");
      }
    });

    const stderrChunks: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const stdoutBuf = Buffer.concat(chunks);
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (killedByLimit) {
        resolve({
          code: 0,
          stdout: stdoutBuf.toString("utf8"),
          stderr,
          truncated: true,
        });
        return;
      }
      resolve({
        code: signal !== null ? -1 : typeof code === "number" ? code : -1,
        stdout: stdoutBuf.toString("utf8"),
        stderr,
        truncated: false,
      });
    });
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

// ---------------------------------------------------------------------------
// v0.2 restricted commitish grammar (v0.2-mcp-tools-contract.md §2)
// ---------------------------------------------------------------------------

const REVISION_MAX_LENGTH = 200;
// ASCII letters, digits, `.`, `_`, `/`, `-`. This class alone already rejects
// `~`, `^`, `:`, `@`, backslash, whitespace, shell metacharacters, and control
// characters, so ranges, `@{...}`, `:path`, and option-like values never
// survive validation.
const REVISION_CHARSET = /^[A-Za-z0-9._/-]+$/;
const COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Validate a public revision field against the restricted commitish grammar
 * before any Git operation receives the value. Only plain commitishes
 * (HEAD, branch, tag, SHA) survive; the caller's string is data, never a
 * revision expression (`v0.2-security-contract.md` §4).
 */
export function validateRevisionInput(input: string): string {
  if (input.length === 0 || input.length > REVISION_MAX_LENGTH) {
    throw new AppError("INVALID_ARGUMENT", "Revision must be 1..200 characters long.");
  }
  if (!REVISION_CHARSET.test(input)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "Revision contains characters outside the allowed commitish grammar.",
    );
  }
  if (input.startsWith("-")) {
    throw new AppError("INVALID_ARGUMENT", "Revision must not start with '-'.");
  }
  if (input.includes("..")) {
    throw new AppError("INVALID_ARGUMENT", "Revision must not contain '..'.");
  }
  if (input.includes("//")) {
    throw new AppError("INVALID_ARGUMENT", "Revision must not contain '//'.");
  }
  if (input.endsWith("/")) {
    throw new AppError("INVALID_ARGUMENT", "Revision must not end with '/'.");
  }
  if (input.endsWith(".lock")) {
    throw new AppError("INVALID_ARGUMENT", "Revision must not end with '.lock'.");
  }
  return input;
}

function revisionNotFound(): AppError {
  return new AppError("GIT_REVISION_NOT_FOUND", "The revision did not resolve to a commit.");
}

/**
 * Resolve a validated commitish to exactly one full commit SHA through the
 * fixed `rev-parse --verify <input>^{commit}` template. `^{commit}` is
 * template syntax, not caller input: it forces a commit object and peels
 * annotated tags to their target commit.
 */
async function resolveCommitSha(toplevel: string, validated: string): Promise<string> {
  const result = await runGit(toplevel, ["rev-parse", "--verify", `${validated}^{commit}`]);
  if (result.code !== 0) {
    if (/unknown revision|bad revision|ambiguous|needed a single revision|not a commit/i.test(
      result.stderr,
    )) {
      throw revisionNotFound();
    }
    throw new AppError("GIT_OPERATION_FAILED", "The revision could not be resolved.");
  }
  const sha = result.stdout.trim();
  if (!COMMIT_SHA.test(sha)) {
    throw new AppError("GIT_OPERATION_FAILED", "The revision did not resolve to a commit.");
  }
  return sha;
}

/** Merge base of two resolved commit SHAs; Git exits 1 for unrelated histories. */
async function resolveMergeBaseSha(
  toplevel: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const result = await runGit(toplevel, ["merge-base", baseSha, headSha]);
  const sha = result.stdout.trim();
  if (result.code === 0 && COMMIT_SHA.test(sha)) {
    return sha;
  }
  if (result.code === 1) {
    throw new AppError("GIT_NO_MERGE_BASE", "The two revisions have no common merge base.");
  }
  throw new AppError("GIT_OPERATION_FAILED", "The merge base could not be resolved.");
}

// Git hardcodes the empty tree object in every repository, so root-commit
// comparisons never need to create or read a real object.
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/** Empty-tree object id for the repository's object format (root-commit base). */
async function resolveEmptyTreeSha(toplevel: string): Promise<string> {
  const result = await runGit(toplevel, ["rev-parse", "--show-object-format"]);
  if (result.code !== 0) {
    throw new AppError("GIT_OPERATION_FAILED", "The repository object format could not be read.");
  }
  switch (result.stdout.trim()) {
    case "sha1":
      return EMPTY_TREE_SHA1;
    case "sha256":
      return EMPTY_TREE_SHA256;
    default:
      throw new AppError("GIT_OPERATION_FAILED", "Unsupported repository object format.");
  }
}

// ---------------------------------------------------------------------------
// Commit metadata parsing (v0.2-requirements.md §3.1/§3.2: metadata only)
// ---------------------------------------------------------------------------

/** %H %P %an %cI %s — \x01-separated fields inside a NUL-separated record. */
const COMMIT_FORMAT = "%H%x01%P%x01%an%x01%cI%x01%s";

interface CommitMetadata {
  commit: string;
  parents: string[];
  subject: string;
  author_name: string;
  committed_at: string;
}

/** Strict ISO-8601 UTC (`2026-09-05T12:34:56Z`), locale-independent. */
function normalizeCommitTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("GIT_OPERATION_FAILED", "The commit timestamp could not be parsed.");
  }
  return parsed.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function parseCommitRecord(record: string): CommitMetadata {
  const fields = record.split("\x01");
  if (fields.length < 5 || !COMMIT_SHA.test(fields[0]!)) {
    throw new AppError("GIT_OPERATION_FAILED", "Commit metadata could not be parsed.");
  }
  return {
    commit: fields[0]!,
    parents: fields[1] === "" ? [] : fields[1]!.split(" "),
    author_name: fields[2]!,
    committed_at: normalizeCommitTimestamp(fields[3]!),
    // A subject may itself contain \x01 bytes; keep them in the subject.
    subject: fields.slice(4).join("\x01"),
  };
}

async function readCommitLog(
  toplevel: string,
  startSha: string,
  maxCount: number,
): Promise<CommitMetadata[]> {
  const result = await runGit(toplevel, [
    "log",
    "-z",
    "--no-color",
    "--no-show-signature",
    `--format=${COMMIT_FORMAT}`,
    "-n",
    String(maxCount),
    startSha,
  ]);
  if (result.code !== 0) {
    throw new AppError("GIT_OPERATION_FAILED", "Commit history could not be read.");
  }
  const commits: CommitMetadata[] = [];
  for (const record of result.stdout.split("\x00")) {
    if (record === "") continue;
    commits.push(parseCommitRecord(record));
  }
  return commits;
}

// ---------------------------------------------------------------------------
// Structured results (mcp-tools-spec.md §11/§12)
// ---------------------------------------------------------------------------

export type ChangeState =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked"
  | "conflicted"
  | "type_changed";

export interface GitStatusChange {
  path: string;
  staged: ChangeState | null;
  unstaged: ChangeState | null;
  old_path?: string;
}

export interface GitBranchInfo {
  name: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
}

export interface GitStatusResult {
  branch: GitBranchInfo;
  changes: GitStatusChange[];
  redacted_changes: number;
  clean: boolean;
}

export type DiffScope = "unstaged" | "staged" | "all";

export interface DiffSection {
  scope: "staged" | "unstaged";
  diff: string;
  files_changed: number;
  truncated: boolean;
}

export interface GitDiffResult {
  scope: DiffScope;
  sections: DiffSection[];
  redacted_files: number;
  truncated: boolean;
}

export interface GitHistoryCommit {
  commit: string;
  parents: string[];
  subject: string;
  author_name: string;
  committed_at: string;
}

export interface GitHistoryResult {
  /** Resolved full commit SHA of the start revision. */
  start: string;
  commits: GitHistoryCommit[];
  truncated: boolean;
}

export interface GitCommitResult {
  commit: string;
  parents: string[];
  subject: string;
  author_name: string;
  committed_at: string;
  /** First parent SHA, or null for a root commit (empty-tree comparison). */
  comparison_base: string | null;
  files_changed: number;
  redacted_files: number;
  diff: string;
  truncated: boolean;
}

export type GitCompareMode = "direct" | "merge_base";

/** Internal shape shared by `git_commit` and `git_compare` diff output. */
interface CommittedDiffResult {
  diff: string;
  files_changed: number;
  redacted_files: number;
  truncated: boolean;
}

export interface GitCompareResult {
  mode: GitCompareMode;
  requested_base: string;
  head: string;
  comparison_base: string;
  files_changed: number;
  redacted_files: number;
  diff: string;
  truncated: boolean;
}

export interface GitAdapterOptions {
  limits: ServerLimits;
  policy: AccessPolicy;
}

interface RepoContext {
  /** Canonical repository root; all Git output paths are relative to it. */
  toplevel: string;
  /** Canonical workspace root used for path mapping. */
  workspaceRoot: string;
  /** Workspace prefix inside the repository ("sub/" or ""), POSIX form. */
  prefix: string;
}

function mapChar(state: string): ChangeState | null {
  switch (state) {
    case " ":
      return null;
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type_changed";
    case "U":
      return "conflicted";
    default:
      return null;
  }
}

function parseBranchHeader(header: string): GitBranchInfo {
  let rest = header.replace(/^##\s+/, "").trim();
  if (rest.startsWith("HEAD (no branch)") || rest.startsWith("HEAD (no checkout)")) {
    return { name: null, detached: true, upstream: null, ahead: null, behind: null };
  }
  const noCommits = rest.match(/^No commits yet on (.+)$/);
  if (noCommits !== null) {
    return { name: noCommits[1]!, detached: false, upstream: null, ahead: null, behind: null };
  }
  let ahead: number | null = null;
  let behind: number | null = null;
  const bracket = rest.match(/\[(.+)\]\s*$/);
  if (bracket !== null) {
    rest = rest.slice(0, bracket.index).trim();
    for (const part of bracket[1]!.split(",")) {
      const match = part.trim().match(/^(ahead|behind)\s+(\d+)$/);
      if (match === null) continue;
      if (match[1] === "ahead") ahead = Number(match[2]);
      else behind = Number(match[2]);
    }
  }
  let name = rest;
  let upstream: string | null = null;
  const dots = rest.indexOf("...");
  if (dots >= 0) {
    name = rest.slice(0, dots);
    upstream = rest.slice(dots + 3) || null;
  }
  return { name: name === "" ? null : name, detached: false, upstream, ahead, behind };
}

function parseStatusEntries(zText: string): Array<{ x: string; y: string; paths: string[] }> {
  const tokens = zText.split("\0");
  const entries: Array<{ x: string; y: string; paths: string[] }> = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "") continue;
    if (token.length < 4 || token[2] !== " ") continue;
    const x = token[0]!;
    const y = token[1]!;
    if (x === "?" && y === "?") {
      entries.push({ x, y, paths: [token.slice(3)] });
      continue;
    }
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      const newPath = token.slice(3);
      const oldPath = tokens[i + 1] ?? "";
      i += 1;
      entries.push({ x, y, paths: [newPath, oldPath] }); // porcelain -z: new first, then old
      continue;
    }
    entries.push({ x, y, paths: [token.slice(3)] });
  }
  return entries;
}

export function assertReliableRenameDetection(stderr: string): void {
  if (/rename detection was skipped/i.test(stderr)) {
    throw new AppError("GIT_OPERATION_FAILED", "Rename detection could not be completed reliably.");
  }
}

interface NameStatusEntry {
  code: string;
  paths: string[]; // [old, new] for renames/copies, else [path]
}

function parseNameStatus(zText: string): NameStatusEntry[] {
  const tokens = zText.split("\0");
  const entries: NameStatusEntry[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "") continue;
    const code = token[0]!;
    if (code === "R" || code === "C") {
      const oldPath = tokens[i + 1] ?? "";
      const newPath = tokens[i + 2] ?? "";
      i += 2;
      entries.push({ code, paths: [oldPath, newPath] }); // name-status: old first, then new
      continue;
    }
    const entryPath = tokens[i + 1] ?? "";
    i += 1;
    entries.push({ code, paths: [entryPath] });
  }
  return entries;
}

/** Best-effort C-style unquote for paths quoted by Git in diff headers. */
function unquoteGitPath(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"')) {
    return text;
  }
  const body = text.slice(1, -1);
  return body.replace(/\\(?:([0-7]{3})|(.))/g, (_all, octal: string | undefined, ch: string | undefined) => {
    if (octal !== undefined) {
      return String.fromCharCode(parseInt(octal, 8));
    }
    switch (ch) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return ch ?? "";
    }
  });
}

function splitDiffSections(text: string): string[] {
  if (text.length === 0) return [];
  const sections: string[] = [];
  let currentStart = 0;
  const marker = /\n(?=diff --git )/g;
  let match: RegExpExecArray | null;
  while ((match = marker.exec(text)) !== null) {
    // Keep each section's trailing newline so reassembly is lossless.
    sections.push(text.slice(currentStart, match.index) + "\n");
    currentStart = match.index + 1;
  }
  sections.push(text.slice(currentStart));
  return sections;
}

function cutToByteBudget(text: string, budget: number): string {
  if (budget <= 0) return "";
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= budget) return text;
  let end = budget;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end -= 1;
  const slice = buffer.subarray(0, end).toString("utf8");
  const lastNewline = slice.lastIndexOf("\n");
  return lastNewline > 0 ? slice.slice(0, lastNewline) : slice;
}

export class GitAdapter {
  private readonly limits: ServerLimits;
  private readonly policy: AccessPolicy;

  constructor(options: GitAdapterOptions) {
    this.limits = options.limits;
    this.policy = options.policy;
  }

  private async requireGitOperation<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("GIT_OPERATION_FAILED", "The controlled Git operation failed.", {
        cause: error,
      });
    }
  }

  private async resolveContext(root: string): Promise<RepoContext> {
    return this.requireGitOperation(async () => {
      const result = await runGit(root, ["rev-parse", "--show-toplevel"]);
      if (result.code !== 0) {
        throw new AppError(
          "NOT_A_GIT_REPOSITORY",
          "The workspace is not inside a Git repository.",
        );
      }
      const workspaceRoot = await fsPromises.realpath(root);
      const toplevel = await fsPromises.realpath(result.stdout.trim());
      const rel = path.relative(toplevel, workspaceRoot);
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        throw new AppError("GIT_OPERATION_FAILED", "The workspace root could not be located.");
      }
      const prefix = rel === "" ? "" : `${rel.split(path.sep).join("/")}/`;
      return { toplevel, workspaceRoot, prefix };
    });
  }

  /** Map a repository-relative path from Git output to workspace-relative. */
  private toWorkspacePath(context: RepoContext, repoRelativePath: string): string | null {
    const normalized = repoRelativePath.replace(/\/+$/, "");
    const joined = path.join(context.toplevel, normalized);
    const rel = path.relative(context.workspaceRoot, joined);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
      return null; // outside the authorized workspace
    }
    if (rel === "") return ".";
    return rel.split(path.sep).join("/");
  }

  /**
   * Head metadata for `workspace_info`: branch/detached plus the short
   * HEAD commit (null on an unborn branch). Non-Git roots are reported as
   * `detected: false` instead of erroring.
   */
  async headInfo(
    root: string,
  ): Promise<{ detected: boolean; branch: GitBranchInfo; head: string | null }> {
    const branch: GitBranchInfo = {
      name: null,
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
    };
    try {
      const status = await this.status(root);
      const head = await runGit(root, ["rev-parse", "--short", "HEAD"]);
      return {
        detected: true,
        branch: status.branch,
        head: head.code === 0 ? head.stdout.trim() || null : null,
      };
    } catch (error) {
      if (error instanceof AppError && error.code === "NOT_A_GIT_REPOSITORY") {
        return { detected: false, branch, head: null };
      }
      throw error;
    }
  }

  /**
   * `git_status` (`mcp-tools-spec.md` §11): machine-readable porcelain,
   * parsed into the structured contract, with AccessPolicy applied before
   * any path crosses the boundary. Blocked changes contribute to
   * `redacted_changes` without disclosing paths.
   */
  async status(root: string): Promise<GitStatusResult> {
    return this.requireGitOperation(async () => {
      const context = await this.resolveContext(root);
      const args = [
        "-c",
        "status.showUntrackedFiles=normal",
        "status",
        "--porcelain=v1",
        "-z",
        "--branch",
      ];
      if (context.prefix !== "") {
        args.push("--", `:(literal)${context.prefix}`);
      }
      const result = await runGit(context.toplevel, args);
      if (result.code !== 0) {
        throw new AppError("GIT_OPERATION_FAILED", "Git status could not be read.");
      }

      const tokens = result.stdout.split("\0");
      const branch = parseBranchHeader(tokens[0] ?? "## HEAD (no branch)");

      const changes: GitStatusChange[] = [];
      let redacted = 0;
      for (const entry of parseStatusEntries(result.stdout)) {
        const workspacePaths: string[] = [];
        let blocked = false;
        for (const repoPath of entry.paths) {
          const wsPath = this.toWorkspacePath(context, repoPath);
          if (wsPath === null || !this.policy.isAllowed(wsPath)) {
            blocked = true;
            break;
          }
          workspacePaths.push(wsPath);
        }
        if (blocked) {
          redacted += 1;
          continue;
        }

        const change: GitStatusChange = {
          path: workspacePaths[0]!,
          staged: mapChar(entry.x),
          unstaged: mapChar(entry.y),
        };
        if (entry.x === "?" && entry.y === "?") {
          change.staged = null;
          change.unstaged = "untracked";
        }
        if (workspacePaths.length > 1) {
          change.old_path = workspacePaths[1];
        }
        changes.push(change);
      }

      return {
        branch,
        changes,
        redacted_changes: redacted,
        clean: changes.length === 0 && redacted === 0,
      };
    });
  }

  /**
   * `git_diff` (`mcp-tools-spec.md` §12): contract scopes only. Changed
   * paths are classified through AccessPolicy first; diff bodies are
   * requested only for allowed paths; the output passes a second
   * policy-based section filter and the global byte ceiling.
   */
  async diff(root: string, scope: DiffScope, pathFilter?: string): Promise<GitDiffResult> {
    return this.requireGitOperation(async () => {
      const context = await this.resolveContext(root);
      const sectionScopes: Array<"staged" | "unstaged"> =
        scope === "all" ? ["staged", "unstaged"] : [scope === "staged" ? "staged" : "unstaged"];

      let filterRepoPath: string | undefined;
      if (pathFilter !== undefined) {
        const resolver = new PathResolver(root);
        const resolved = await resolver.resolve(pathFilter);
        const decision = this.policy.decide(resolved.relativePath);
        if (decision.decision === "blocked") {
          throw new AppError(
            "PATH_BLOCKED",
            "The requested path is blocked by the workspace access policy.",
          );
        }
        if (resolved.relativePath === ".") {
          filterRepoPath = context.prefix === "" ? undefined : context.prefix.replace(/\/+$/, "");
        } else {
          filterRepoPath =
            context.prefix === ""
              ? resolved.relativePath
              : `${context.prefix}${resolved.relativePath}`;
        }
      }

      const sections: DiffSection[] = [];
      let redactedFiles = 0;
      let truncated = false;
      let budget = this.limits.maxDiffPayloadBytes;

      for (const sectionScope of sectionScopes) {
        const listingArgs = [
          "diff",
          "--name-status",
          "-z",
          "-M",
          "-C",
          "--find-copies-harder",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
        ];
        if (sectionScope === "staged") listingArgs.push("--cached");
        if (filterRepoPath !== undefined) listingArgs.push("--", `:(literal)${filterRepoPath}`);
        const listing = await runGit(context.toplevel, listingArgs);
        if (listing.code !== 0) {
          throw new AppError("GIT_OPERATION_FAILED", "Git diff paths could not be listed.");
        }
        assertReliableRenameDetection(listing.stderr);

        const allowedPathspecs: string[] = [];
        let sectionAllowedFiles = 0;
        for (const entry of parseNameStatus(listing.stdout)) {
          let blocked = false;
          for (const repoPath of entry.paths) {
            const wsPath = this.toWorkspacePath(context, repoPath);
            if (wsPath === null || !this.policy.isAllowed(wsPath)) {
              blocked = true;
              break;
            }
          }
          if (blocked) {
            redactedFiles += 1;
            continue;
          }
          sectionAllowedFiles += 1;
          for (const repoPath of entry.paths) {
            allowedPathspecs.push(`:(literal)${repoPath}`);
          }
        }

        let text = "";
        let sectionTruncated = false;
        if (allowedPathspecs.length > 0 && budget > 0) {
          const diffArgs = [
            "diff",
            "-M",
            "-C",
            "--find-copies-harder",
            "--no-color",
            "--no-ext-diff",
            "--no-textconv",
          ];
          if (sectionScope === "staged") diffArgs.push("--cached");
          diffArgs.push("--", ...allowedPathspecs);
          const diffRun = await runGitBounded(context.toplevel, diffArgs, budget);
          if (diffRun.code !== 0) {
            throw new AppError("GIT_OPERATION_FAILED", "Git diff could not be read.");
          }
          assertReliableRenameDetection(diffRun.stderr);
          text = diffRun.stdout;
          sectionTruncated = diffRun.truncated;
        }

        // Defense in depth: drop any file section whose header paths are
        // policy-blocked (rename headers can otherwise mention blocked names).
        const keptSections: string[] = [];
        for (const section of splitDiffSections(text)) {
          const headerPaths = extractDiffSectionPaths(section);
          let blocked = false;
          for (const repoPath of headerPaths) {
            const wsPath = this.toWorkspacePath(context, repoPath);
            if (wsPath === null || !this.policy.isAllowed(wsPath)) {
              blocked = true;
              break;
            }
          }
          if (blocked) {
            redactedFiles += 1;
            continue;
          }
          keptSections.push(section);
        }
        text = keptSections.join("");

        const bytes = Buffer.byteLength(text, "utf8");
        if (sectionTruncated || bytes > budget) {
          text = cutToByteBudget(text, budget);
          truncated = true;
          budget = 0;
          sections.push({
            scope: sectionScope,
            diff: text,
            files_changed: sectionAllowedFiles,
            truncated: true,
          });
          continue;
        }
        budget -= bytes;
        sections.push({
          scope: sectionScope,
          diff: text,
          files_changed: sectionAllowedFiles,
          truncated: false,
        });
      }

      return { scope, sections, redacted_files: redactedFiles, truncated };
    });
  }

  // -------------------------------------------------------------------------
  // v0.2 committed-state inspection (v0.2-mcp-tools-contract.md §4-§7)
  // -------------------------------------------------------------------------

  /**
   * Bounded, policy-filtered unified diff between two committed tree states.
   * Same defense strategy as working-tree diffs (`v0.2-security-contract.md`
   * §3): list changed paths through a fixed machine-readable operation,
   * classify every old/new path through the AccessPolicy, request diff
   * bodies only for allowed pathspecs, re-filter sections, apply the central
   * byte budget.
   *
   * With `--relative`, Git itself scopes output to the workspace subtree and
   * emits workspace-relative paths, so repository paths outside an
   * authorized workspace subdirectory never reach this code at all, and a
   * cross-boundary rename collapses to the add/delete of the inside path.
   * Blocked (sensitive) paths inside the workspace are redacted with only a
   * count returned.
   */
  private async committedDiff(
    context: RepoContext,
    baseSha: string,
    headSha: string,
  ): Promise<CommittedDiffResult> {
    const relativeArg =
      context.prefix === "" ? [] : [`--relative=${context.prefix.replace(/\/+$/, "")}`];

    const listing = await runGit(context.toplevel, [
      "diff",
      ...relativeArg,
      "--name-status",
      "-z",
      "-M",
      "-C",
      "--find-copies-harder",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      baseSha,
      headSha,
    ]);
    if (listing.code !== 0) {
      throw new AppError("GIT_OPERATION_FAILED", "Git diff paths could not be listed.");
    }
    assertReliableRenameDetection(listing.stderr);

    // Listing paths are workspace-relative (--relative output, or a root
    // workspace where repository-relative and workspace-relative coincide).
    const pathspecs: string[] = [];
    let redacted = 0;
    let allowedFilesCount = 0;
    for (const entry of parseNameStatus(listing.stdout)) {
      let blocked = false;
      for (const workspacePath of entry.paths) {
        if (!this.policy.isAllowed(workspacePath)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        redacted += 1;
        continue;
      }
      allowedFilesCount += 1;
      for (const workspacePath of entry.paths) {
        pathspecs.push(`:(literal)${context.prefix}${workspacePath}`);
      }
    }

    let text = "";
    let diffTruncated = false;
    if (pathspecs.length > 0) {
      const diffRun = await runGitBounded(
        context.toplevel,
        [
          "diff",
          ...relativeArg,
          "-M",
          "-C",
          "--find-copies-harder",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          baseSha,
          headSha,
          "--",
          ...pathspecs,
        ],
        this.limits.maxDiffPayloadBytes,
      );
      if (diffRun.code !== 0) {
        throw new AppError("GIT_OPERATION_FAILED", "Git diff could not be read.");
      }
      assertReliableRenameDetection(diffRun.stderr);
      text = diffRun.stdout;
      diffTruncated = diffRun.truncated;
    }

    // Defense in depth: drop any file section whose header paths are
    // policy-blocked (rename headers can otherwise mention blocked names).
    const keptSections: string[] = [];
    for (const section of splitDiffSections(text)) {
      let blocked = false;
      for (const workspacePath of extractDiffSectionPaths(section)) {
        if (!this.policy.isAllowed(workspacePath)) {
          blocked = true;
          break;
        }
      }
      if (blocked) {
        redacted += 1;
        continue;
      }
      keptSections.push(section);
    }
    text = keptSections.join("");

    let truncated = diffTruncated;
    if (truncated || Buffer.byteLength(text, "utf8") > this.limits.maxDiffPayloadBytes) {
      text = cutToByteBudget(text, this.limits.maxDiffPayloadBytes);
      truncated = true;
    }
    return {
      diff: text,
      files_changed: allowedFilesCount,
      redacted_files: redacted,
      truncated,
    };
  }

  /**
   * `git_history` (`v0.2-mcp-tools-contract.md` §4): bounded
   * newest-to-oldest commit metadata from a validated, resolved start
   * commit. Metadata only — no changed paths, bodies, or caller-controlled
   * formatting.
   */
  async history(
    root: string,
    startRevision: string,
    maxCommits: number,
  ): Promise<GitHistoryResult> {
    return this.requireGitOperation(async () => {
      const validated = validateRevisionInput(startRevision);
      const context = await this.resolveContext(root);
      const start = await resolveCommitSha(context.toplevel, validated);
      const bounded = Math.max(
        1,
        Math.min(Math.trunc(maxCommits), this.limits.maxGitHistoryCommits),
      );
      // One extra record powers the truncation flag without a second query.
      const fetched = await readCommitLog(context.toplevel, start, bounded + 1);
      return {
        start,
        commits: fetched.slice(0, bounded),
        truncated: fetched.length > bounded,
      };
    });
  }

  /**
   * `git_commit` (§5): one commit against its contract comparison base —
   * the first parent, or the empty tree for a root commit. Merge commits are
   * reviewed as first parent -> merge commit; no multi-parent analysis.
   */
  async commit(root: string, revision: string): Promise<GitCommitResult> {
    return this.requireGitOperation(async () => {
      const validated = validateRevisionInput(revision);
      const context = await this.resolveContext(root);
      const sha = await resolveCommitSha(context.toplevel, validated);
      const [metadata] = await readCommitLog(context.toplevel, sha, 1);
      if (metadata === undefined || metadata.commit !== sha) {
        throw new AppError("GIT_OPERATION_FAILED", "Commit metadata could not be read.");
      }
      if (metadata.parents.length === 0) {
        const emptyTree = await resolveEmptyTreeSha(context.toplevel);
        const diffResult = await this.committedDiff(context, emptyTree, sha);
        return { ...metadata, comparison_base: null, ...diffResult };
      }
      const diffResult = await this.committedDiff(context, metadata.parents[0]!, sha);
      return { ...metadata, comparison_base: metadata.parents[0]!, ...diffResult };
    });
  }

  /**
   * `git_compare` (§6): two validated, resolved committed revisions.
   * `direct` compares base -> head; `merge_base` compares
   * merge-base(base, head) -> head so feature-branch review excludes
   * unrelated post-divergence base-branch commits. Working-tree state is
   * never included.
   */
  async compare(
    root: string,
    baseRevision: string,
    headRevision: string,
    mode: GitCompareMode,
  ): Promise<GitCompareResult> {
    return this.requireGitOperation(async () => {
      const validatedBase = validateRevisionInput(baseRevision);
      const validatedHead = validateRevisionInput(headRevision);
      const context = await this.resolveContext(root);
      const requestedBase = await resolveCommitSha(context.toplevel, validatedBase);
      const head = await resolveCommitSha(context.toplevel, validatedHead);
      const comparisonBase =
        mode === "merge_base"
          ? await resolveMergeBaseSha(context.toplevel, requestedBase, head)
          : requestedBase;
      const diffResult = await this.committedDiff(context, comparisonBase, head);
      return {
        mode,
        requested_base: requestedBase,
        head,
        comparison_base: comparisonBase,
        ...diffResult,
      };
    });
  }
}

/** Extract the repository-relative paths named by one diff file section. */
function extractDiffSectionPaths(section: string): string[] {
  const paths: string[] = [];
  const lines = section.split("\n");
  const header = lines[0] ?? "";
  // Quoted form: diff --git "a/x" "b/x" (used for control characters).
  const quoted = header.match(/^diff --git ("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
  // Unquoted form; the non-greedy a-side tolerates spaces in filenames.
  const plain = header.match(/^diff --git a\/(.*?) b\/(.*)$/);
  if (quoted !== null) {
    paths.push(unquoteGitPath(quoted[1]!).replace(/^a\//, ""));
    paths.push(unquoteGitPath(quoted[2]!).replace(/^b\//, ""));
  } else if (plain !== null) {
    paths.push(plain[1]!);
    paths.push(plain[2]!);
  }
  for (const line of lines) {
    const renameFrom = line.match(/^rename from (.+)$/);
    const renameTo = line.match(/^rename to (.+)$/);
    if (renameFrom !== null) paths.push(unquoteGitPath(renameFrom[1]!));
    if (renameTo !== null) paths.push(unquoteGitPath(renameTo[1]!));
    const copyFrom = line.match(/^copy from (.+)$/);
    const copyTo = line.match(/^copy to (.+)$/);
    if (copyFrom !== null) paths.push(unquoteGitPath(copyFrom[1]!));
    if (copyTo !== null) paths.push(unquoteGitPath(copyTo[1]!));
  }
  return paths.filter((entry) => entry !== "");
}

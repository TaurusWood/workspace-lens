/**
 * PathResolver — the workspace-relative path security kernel
 * (`security-model.md` §4.3, §4.4 and `mcp-tools-spec.md` §3.2).
 *
 * Responsibilities:
 * 1. validate the platform-neutral workspace-relative path syntax;
 * 2. resolve the path against a canonical workspace root;
 * 3. verify canonical containment (realpath-based, never a string-prefix
 *    check) before anything in the workspace is touched.
 *
 * Every filesystem or Git operation must obtain its local path from this
 * resolver; tools must not duplicate or bypass it.
 */
import fsPromises from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.js";

const MAX_RELATIVE_PATH_LENGTH = 4096;

export interface ResolvedWorkspacePath {
  /** Normalized workspace-relative path (`.` for the workspace root). */
  relativePath: string;
  /** Canonical local path verified to be inside the canonical root. */
  absolutePath: string;
}

export interface ResolveOptions {
  /**
   * When true (default), a path that does not exist — including a broken
   * symlink — fails with PATH_NOT_FOUND.
   */
  mustExist?: boolean;
}

/**
 * Validate and normalize a workspace-relative path.
 *
 * `/` is the only separator; `.` denotes the workspace root. Rejected:
 * absolute paths, `..` segments, NUL characters, backslashes, and
 * Windows drive-qualified paths. Symlink containment is checked later,
 * during canonical resolution.
 */
export function validateRelativePath(input: string): string {
  if (input.length === 0) {
    throw new AppError("PATH_INVALID", "Path must not be empty.");
  }
  if (input.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new AppError("PATH_INVALID", "Path is too long.");
  }
  if (input.includes("\0")) {
    throw new AppError("PATH_INVALID", "Path must not contain NUL characters.");
  }
  if (input.includes("\\")) {
    throw new AppError("PATH_INVALID", "Path must not contain backslashes.");
  }
  if (input.startsWith("/")) {
    throw new AppError("PATH_INVALID", "Path must be workspace-relative and must not start with '/'.");
  }
  if (/^[A-Za-z]:/.test(input)) {
    throw new AppError("PATH_INVALID", "Drive-qualified paths are not valid workspace paths.");
  }

  const segments: string[] = [];
  for (const segment of input.split("/")) {
    if (segment === "" || segment === ".") {
      continue;
    }
    if (segment === "..") {
      throw new AppError("PATH_INVALID", "Path must not contain '..' segments.");
    }
    segments.push(segment);
  }
  return segments.length === 0 ? "." : segments.join("/");
}

export class PathResolver {
  constructor(readonly canonicalRoot: string) {}

  validate(input: string): string {
    return validateRelativePath(input);
  }

  /**
   * Resolve a workspace-relative path to a canonical local path and verify
   * containment of the canonical target (`security-model.md` §4.4).
   */
  async resolve(input: string, options: ResolveOptions = {}): Promise<ResolvedWorkspacePath> {
    const relativePath = validateRelativePath(input);
    const mustExist = options.mustExist ?? true;

    let rootReal: string;
    try {
      rootReal = await fsPromises.realpath(this.canonicalRoot);
    } catch (error) {
      // A missing or inaccessible root is never silently replaced by a
      // parent directory (`security-model.md` §5).
      throw new AppError("WORKSPACE_UNAVAILABLE", "The workspace root is currently unavailable.", {
        cause: error,
      });
    }

    const target = relativePath === "." ? rootReal : path.join(rootReal, relativePath);

    // Canonicalize the deepest existing ancestor, then re-join any trailing
    // (non-existent) segments. Resolving the ancestor first guarantees that
    // any symlink on the existing part of the chain is followed *before*
    // the containment decision, so escaping symlinks are rejected.
    const missingSegments: string[] = [];
    let probe = target;
    let existingReal: string;
    for (;;) {
      try {
        existingReal = await fsPromises.realpath(probe);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          // Inaccessible ancestors fail closed without revealing whether
          // the path exists.
          throw new AppError("PATH_NOT_FOUND", `Path not found in workspace: ${relativePath}`, {
            cause: error,
          });
        }
        missingSegments.unshift(path.basename(probe));
        const parent = path.dirname(probe);
        if (parent === probe) {
          throw new AppError("PATH_NOT_FOUND", `Path not found in workspace: ${relativePath}`);
        }
        probe = parent;
      }
    }

    const candidate =
      missingSegments.length === 0 ? existingReal : path.join(existingReal, ...missingSegments);

    const relFromRoot = path.relative(rootReal, candidate);
    if (
      relFromRoot === ".." ||
      relFromRoot.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relFromRoot)
    ) {
      throw new AppError(
        "PATH_OUTSIDE_WORKSPACE",
        "The requested path resolves outside the authorized workspace.",
      );
    }

    if (mustExist && missingSegments.length > 0) {
      throw new AppError("PATH_NOT_FOUND", `Path not found in workspace: ${relativePath}`);
    }

    return { relativePath, absolutePath: candidate };
  }
}

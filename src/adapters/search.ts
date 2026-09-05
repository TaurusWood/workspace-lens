/**
 * Search adapter — literal text search over eligible workspace files
 * (`security-model.md` §8, `implementation-plan.md` §12).
 *
 * The MVP contract is intentionally narrow: literal query only, validated
 * workspace-relative search roots, shared AccessPolicy, bounded results and
 * previews, deterministic ordering. Regular-expression semantics are not
 * part of the public contract.
 *
 * Implementation notes:
 * - the query is escaped into a per-line regular expression only to obtain
 *   correct 1-based columns for case-insensitive matching; it never runs as
 *   a shell or ripgrep command;
 * - files that `read_file` would refuse (policy-blocked, excluded, binary,
   invalid UTF-8, oversized) are skipped, so a blocked file cannot leak
 *   through search content or previews.
 */
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { AppError } from "../core/errors.js";
import type { ServerLimits } from "../core/limits.js";
import { PathResolver } from "../core/path-resolver.js";
import type { AccessPolicy } from "../core/access-policy.js";
import { bufferLooksBinary, decodeUtf8Text } from "./file-type.js";

export interface SearchMatch {
  path: string;
  line: number;
  column: number;
  preview: string;
}

export interface SearchOptions {
  query: string;
  /** Workspace-relative search root; defaults to the workspace root. */
  path?: string;
  /** Simple validated basename glob (`*`, `?`); never a shell fragment. */
  filePattern?: string;
  caseSensitive?: boolean;
  /** Caller ceiling, 1..limits.maxSearchResults. */
  maxResults?: number;
}

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export interface SearchAdapterOptions {
  limits: ServerLimits;
  policy: AccessPolicy;
}

const FILE_PATTERN_ALLOWED = /^[A-Za-z0-9._\-?*()[\]!+@%]+$/;

export function compileFilePattern(pattern: string): RegExp {
  if (pattern.length === 0 || pattern.length > 100) {
    throw new AppError("INVALID_ARGUMENT", "file_pattern must be a non-empty string of at most 100 characters.");
  }
  if (!FILE_PATTERN_ALLOWED.test(pattern)) {
    throw new AppError(
      "INVALID_ARGUMENT",
      "file_pattern supports simple basename globs (*, ?) and must not contain path separators or shell syntax.",
    );
  }
  let source = "^";
  for (const ch of pattern) {
    if (ch === "*") {
      source += "[^/]*";
    } else if (ch === "?") {
      source += "[^/]";
    } else {
      source += /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
    }
  }
  return new RegExp(`${source}$`);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class SearchAdapter {
  private readonly limits: ServerLimits;
  private readonly policy: AccessPolicy;

  constructor(options: SearchAdapterOptions) {
    this.limits = options.limits;
    this.policy = options.policy;
  }

  async search(root: string, options: SearchOptions): Promise<SearchResult> {
    const query = options.query;
    if (query.length === 0 || query.length > this.limits.maxQueryLength) {
      throw new AppError(
        "INVALID_ARGUMENT",
        `query must be a non-empty string of at most ${this.limits.maxQueryLength} characters.`,
      );
    }
    if (options.maxResults !== undefined &&
      (!Number.isInteger(options.maxResults) ||
        options.maxResults < 1 ||
        options.maxResults > this.limits.maxSearchResults)
    ) {
      throw new AppError(
        "INVALID_ARGUMENT",
        `max_results must be an integer between 1 and ${this.limits.maxSearchResults}.`,
      );
    }
    const fileRegex = options.filePattern !== undefined
      ? compileFilePattern(options.filePattern)
      : undefined;
    const caseSensitive = options.caseSensitive ?? true;

    const resolver = new PathResolver(root);
    const searchRoot = await resolver.resolve(options.path ?? ".");
    const decision = this.policy.decide(searchRoot.relativePath);
    if (decision.decision === "blocked") {
      throw new AppError(
        "PATH_BLOCKED",
        "The requested path is blocked by the workspace access policy.",
      );
    }
    let rootStats;
    try {
      rootStats = await fsPromises.lstat(searchRoot.absolutePath);
    } catch (error) {
      throw new AppError("PATH_NOT_FOUND", `Path not found in workspace: ${searchRoot.relativePath}`, {
        cause: error,
      });
    }
    if (!rootStats.isDirectory()) {
      throw new AppError("NOT_A_DIRECTORY", "The requested search root is not a directory.");
    }

    const queryRegex = new RegExp(escapeRegex(query), caseSensitive ? "g" : "gi");
    const callerMax = options.maxResults ?? this.limits.defaultSearchResults;
    const stopAt = this.limits.maxSearchResults + 1; // one extra proves truncation

    const matches: SearchMatch[] = [];
    let truncated = false;
    let filesScanned = 0;
    let aborted = false;

    const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
      if (aborted) return;
      let dirents: Dirent[];
      try {
        dirents = await fsPromises.readdir(absoluteDir, { withFileTypes: true });
      } catch {
        // Unreadable subtree: fail closed rather than return partial silence.
        throw new AppError("SEARCH_FAILED", "A directory could not be read during search.");
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const dirent of dirents) {
        if (aborted) return;
        const entryRelative =
          relativeDir === "." ? dirent.name : `${relativeDir}/${dirent.name}`;

        const entryDecision = this.policy.decide(entryRelative);
        if (entryDecision.decision === "blocked") {
          // Blocked sensitive / excluded entries are not searched at all.
          continue;
        }
        if (dirent.isDirectory()) {
          await walk(path.join(absoluteDir, dirent.name), entryRelative);
          continue;
        }
        if (!dirent.isFile()) {
          // Symlinks and special files are never followed during search.
          continue;
        }
        if (filesScanned >= this.limits.maxSearchFileScan) {
          truncated = true;
          aborted = true;
          return;
        }
        filesScanned += 1;

        if (fileRegex !== undefined && !fileRegex.test(dirent.name)) {
          continue;
        }

        const fileMatches = await this.scanFile(
          path.join(absoluteDir, dirent.name),
          entryRelative,
          queryRegex,
        );
        if (fileMatches.length > 0) {
          matches.push(...fileMatches);
          if (matches.length >= stopAt) {
            truncated = true;
            aborted = true;
            return;
          }
        }
      }
    };

    await walk(searchRoot.absolutePath, searchRoot.relativePath);

    matches.sort((a, b) => {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      if (a.line !== b.line) return a.line - b.line;
      return a.column - b.column;
    });

    const visible = matches.slice(0, callerMax);
    if (matches.length > callerMax) {
      truncated = true;
    }

    return { query, matches: visible, truncated };
  }

  private async scanFile(
    absolutePath: string,
    relativePath: string,
    queryRegex: RegExp,
  ): Promise<SearchMatch[]> {
    let stats;
    try {
      stats = await fsPromises.lstat(absolutePath);
    } catch {
      return []; // vanished concurrently; not searchable
    }
    if (!stats.isFile() || stats.size > this.limits.maxEligibleFileBytes) {
      // Files read_file would refuse are not searchable either.
      return [];
    }

    let buffer: Buffer;
    try {
      buffer = await fsPromises.readFile(absolutePath);
    } catch {
      return [];
    }
    if (bufferLooksBinary(buffer, this.limits.binaryProbeBytes)) {
      return [];
    }
    const decoded = decodeUtf8Text(buffer);
    if (!decoded.ok) {
      return [];
    }

    const matches: SearchMatch[] = [];
    const rawLines = decoded.text.split("\n");
    for (let lineIndex = 0; lineIndex < rawLines.length; lineIndex += 1) {
      const rawLine = rawLines[lineIndex]!;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      queryRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = queryRegex.exec(line)) !== null) {
        matches.push({
          path: relativePath,
          line: lineIndex + 1,
          column: match.index + 1,
          preview: line.slice(0, this.limits.maxSearchPreviewChars),
        });
        if (match.index === queryRegex.lastIndex) {
          queryRegex.lastIndex += 1; // zero-length safety; literal queries are >= 1 char
        }
        if (matches.length >= this.limits.maxSearchResults + 1) {
          return matches; // hard ceiling reached; caller stops scanning
        }
      }
    }
    return matches;
  }
}

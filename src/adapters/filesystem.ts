/**
 * Filesystem adapter — controlled read-only operations.
 *
 * Security: every operation enters through the shared security kernel
 * (`PathResolver` + `AccessPolicy`). Callers can only pass workspace-relative
 * paths; absolute local paths never reach this adapter
 * (`implementation-plan.md` §10: no adapter may receive a caller-controlled
 * path that bypassed the kernel).
 */
import fsPromises from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { AppError } from "../core/errors.js";
import type { ServerLimits } from "../core/limits.js";
import { PathResolver } from "../core/path-resolver.js";
import type { AccessPolicy } from "../core/access-policy.js";
import {
  bufferLooksBinary,
  classifyFileKind,
  decodeUtf8Text,
} from "./file-type.js";

export type ListedEntryKind = "file" | "directory" | "symlink";

export interface ListEntry {
  path: string;
  kind: ListedEntryKind;
  size_bytes?: number;
}

export interface ListTreeResult {
  path: string;
  entries: ListEntry[];
  truncated: boolean;
}

export interface ReadFileResult {
  path: string;
  encoding: "utf-8";
  size_bytes: number;
  line_start: number;
  line_end: number;
  content: string;
  truncated: boolean;
}

export interface FilesystemAdapterOptions {
  limits: ServerLimits;
  policy: AccessPolicy;
}

export class FilesystemAdapter {
  private readonly limits: ServerLimits;
  private readonly policy: AccessPolicy;

  constructor(options: FilesystemAdapterOptions) {
    this.limits = options.limits;
    this.policy = options.policy;
  }

  /**
   * Shared kernel decision for the requested path itself: policy-blocked
   * paths fail with PATH_BLOCKED before any content operation.
   */
  private assertPolicyAllows(relativePath: string): void {
    const decision = this.policy.decide(relativePath);
    if (decision.decision === "blocked") {
      throw new AppError(
        "PATH_BLOCKED",
        "The requested path is blocked by the workspace access policy.",
      );
    }
  }

  /**
   * List a bounded directory tree. Blocked sensitive entries are omitted,
   * dependency/build trees are omitted, and symlink targets are never
   * disclosed (`mcp-tools-spec.md` §8).
   */
  async listTree(root: string, relativePath: string, depth: number): Promise<ListTreeResult> {
    if (!Number.isInteger(depth) || depth < 1 || depth > this.limits.maxListDepth) {
      throw new AppError(
        "INVALID_ARGUMENT",
        `depth must be an integer between 1 and ${this.limits.maxListDepth}.`,
      );
    }

    const resolver = new PathResolver(root);
    const resolved = await resolver.resolve(relativePath);
    this.assertPolicyAllows(resolved.relativePath);

    let rootStats;
    try {
      rootStats = await fsPromises.lstat(resolved.absolutePath);
    } catch (error) {
      throw notFound(resolved.relativePath, error);
    }
    if (classifyFileKind(rootStats) !== "directory") {
      throw new AppError("NOT_A_DIRECTORY", "The requested path is not a directory.");
    }

    const entries: ListEntry[] = [];
    let truncated = false;

    // Deterministic breadth-first walk in sorted order; traversal never
    // follows symlinks, so symlinked directories are listed but not entered.
    interface QueueItem {
      absoluteDir: string;
      relativeDir: string;
      level: number;
    }
    const queue: QueueItem[] = [
      { absoluteDir: resolved.absolutePath, relativeDir: resolved.relativePath, level: 1 },
    ];

    walk: while (queue.length > 0) {
      const item = queue.shift()!;
      let dirents: Dirent[];
      try {
        dirents = await fsPromises.readdir(item.absoluteDir, { withFileTypes: true });
      } catch (error) {
        // Fail closed on unreadable directories instead of silently omitting
        // potentially large subtrees.
        throw notFound(resolved.relativePath, error);
      }
      dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

      for (const dirent of dirents) {
        const entryRelative =
          item.relativeDir === "." ? dirent.name : `${item.relativeDir}/${dirent.name}`;

        if (!this.policy.isAllowed(entryRelative)) {
          // Blocked sensitive / excluded entries are omitted entirely.
          continue;
        }

        const kind: ListedEntryKind | undefined = dirent.isSymbolicLink()
          ? "symlink"
          : dirent.isDirectory()
            ? "directory"
            : dirent.isFile()
              ? "file"
              : undefined; // sockets, FIFOs, devices: not listed
        if (kind === undefined) {
          continue;
        }

        if (entries.length >= this.limits.maxListEntries) {
          truncated = true;
          break walk;
        }

        const entry: ListEntry = { path: entryRelative, kind };
        if (kind === "file") {
          try {
            const stats = await fsPromises.lstat(path.join(item.absoluteDir, dirent.name));
            entry.size_bytes = stats.size;
          } catch {
            // The entry stays listed without a size; it may vanish concurrently.
          }
        }
        entries.push(entry);

        if (kind === "directory" && item.level < depth) {
          queue.push({
            absoluteDir: path.join(item.absoluteDir, dirent.name),
            relativeDir: entryRelative,
            level: item.level + 1,
          });
        }
      }
    }

    // Contract ordering: directories first, then files/symlinks, each
    // lexicographically by workspace-relative path.
    entries.sort((a, b) => {
      const kindRank = (kind: ListedEntryKind): number => (kind === "directory" ? 0 : 1);
      const rankDiff = kindRank(a.kind) - kindRank(b.kind);
      if (rankDiff !== 0) return rankDiff;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });

    return { path: resolved.relativePath, entries, truncated };
  }

  /**
   * Read bounded text content from one allowed regular file with
   * line-oriented ranges (`mcp-tools-spec.md` §9).
   */
  async readFile(
    root: string,
    relativePath: string,
    startLine: number,
    endLine: number | undefined,
  ): Promise<ReadFileResult> {
    const resolver = new PathResolver(root);
    const resolved = await resolver.resolve(relativePath);
    this.assertPolicyAllows(resolved.relativePath);

    let stats;
    try {
      stats = await fsPromises.lstat(resolved.absolutePath);
    } catch (error) {
      throw notFound(resolved.relativePath, error);
    }
    const kind = classifyFileKind(stats);
    if (kind === "directory") {
      throw new AppError("NOT_A_FILE", "The requested path is a directory.");
    }
    if (kind !== "regular") {
      throw new AppError("UNSUPPORTED_FILE_TYPE", "The requested file type is not supported.");
    }
    if (stats.size > this.limits.maxEligibleFileBytes) {
      throw new AppError("FILE_TOO_LARGE", "The file exceeds the server's eligibility limit.");
    }

    let buffer: Buffer;
    try {
      buffer = await fsPromises.readFile(resolved.absolutePath);
    } catch (error) {
      throw notFound(resolved.relativePath, error);
    }
    if (bufferLooksBinary(buffer, this.limits.binaryProbeBytes)) {
      throw new AppError("BINARY_FILE_NOT_SUPPORTED", "Binary files are not supported.");
    }
    const decoded = decodeUtf8Text(buffer);
    if (!decoded.ok) {
      throw new AppError("BINARY_FILE_NOT_SUPPORTED", "The file is not valid UTF-8 text.");
    }

    const lines = splitLines(decoded.text);
    const requestedStart = Math.max(1, startLine);
    if (endLine !== undefined && endLine < requestedStart) {
      throw new AppError("INVALID_ARGUMENT", "end_line must be greater than or equal to start_line.");
    }

    const startIndex = requestedStart - 1;
    const selected: string[] = [];
    let truncated = false;
    let payloadBytes = 0;
    const indexEnd = endLine === undefined ? lines.length : Math.min(endLine, lines.length);

    for (let i = startIndex; i < indexEnd; i += 1) {
      const line = lines[i] ?? "";
      const separatorBytes = selected.length > 0 ? 1 : 0;
      const lineBytes = Buffer.byteLength(line, "utf8");
      if (payloadBytes + separatorBytes + lineBytes > this.limits.maxReadPayloadBytes) {
        // The ceiling applies to the returned payload; a single oversized
        // line is cut at a UTF-8 boundary.
        const room = this.limits.maxReadPayloadBytes - payloadBytes - separatorBytes;
        if (room > 0) {
          const cut = truncateUtf8ToByteLimit(line, room);
          if (cut !== null) {
            selected.push(cut.text);
            payloadBytes += separatorBytes + cut.bytes;
          }
        }
        truncated = true;
        break;
      }
      selected.push(line);
      payloadBytes += separatorBytes + lineBytes;
    }

    // Requesting lines beyond the end of file returns everything available
    // and is not a ceiling truncation; `truncated` stays false in that case.

    return {
      path: resolved.relativePath,
      encoding: "utf-8",
      size_bytes: stats.size,
      line_start: requestedStart,
      line_end: selected.length === 0 ? requestedStart - 1 : requestedStart + selected.length - 1,
      content: selected.join("\n"),
      truncated,
    };
  }
}

function notFound(relativePath: string, cause: unknown): AppError {
  return new AppError("PATH_NOT_FOUND", `Path not found in workspace: ${relativePath}`, {
    cause,
  });
}

/** Split text into 1-based lines; strip a trailing empty segment and \r. */
function splitLines(text: string): string[] {
  const raw = text.split("\n");
  if (raw.length > 0 && raw[raw.length - 1] === "") {
    raw.pop();
  }
  return raw.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/** Cut a string so its UTF-8 encoding fits `maxBytes`; null when no fit. */
function truncateUtf8ToByteLimit(text: string, maxBytes: number): { text: string; bytes: number } | null {
  if (maxBytes <= 0) {
    return null;
  }
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return { text, bytes: buffer.length };
  }
  let end = maxBytes;
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) {
    end -= 1;
  }
  const cut = buffer.subarray(0, end).toString("utf8");
  return { text: cut, bytes: end };
}

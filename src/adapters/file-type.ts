/**
 * Conservative file-type classification (`security-model.md` §9).
 *
 * Device files, sockets, and named pipes are never read. Binary content is
 * detected with a conservative heuristic (NUL probe plus strict UTF-8
 * decoding) and fails closed with BINARY_FILE_NOT_SUPPORTED.
 */
import fs from "node:fs";

export type FileKind = "regular" | "directory" | "symlink" | "special";

export function classifyFileKind(stats: fs.Stats): FileKind {
  if (stats.isSymbolicLink()) return "symlink";
  if (stats.isDirectory()) return "directory";
  if (stats.isFile()) return "regular";
  return "special";
}

/** NUL-byte probe over the head of a buffer; the conservative MVP heuristic. */
export function bufferLooksBinary(buffer: Buffer, probeBytes: number): boolean {
  const end = Math.min(buffer.length, probeBytes);
  for (let i = 0; i < end; i += 1) {
    if (buffer[i] === 0) {
      return true;
    }
  }
  return false;
}

const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

export type Utf8DecodeResult = { ok: true; text: string } | { ok: false };

/** Strict UTF-8 decode; BOM is stripped from the returned text. */
export function decodeUtf8Text(buffer: Buffer): Utf8DecodeResult {
  try {
    let text = strictUtf8Decoder.decode(buffer);
    if (text.startsWith("\uFEFF")) {
      text = text.slice(1);
    }
    return { ok: true, text };
  } catch {
    return { ok: false };
  }
}

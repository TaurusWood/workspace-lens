import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bufferLooksBinary,
  classifyFileKind,
  decodeUtf8Text,
} from "../../src/adapters/file-type.js";
import { makeTempDir } from "../helpers/fixtures.js";

describe("file classification", () => {
  it("classifies regular files, directories, and symlinks", () => {
    const root = makeTempDir("wl-filetype-");
    try {
      const file = path.join(root, "file.txt");
      fs.writeFileSync(file, "text");
      const dir = path.join(root, "dir");
      fs.mkdirSync(dir);
      const link = path.join(root, "link");
      fs.symlinkSync(file, link);

      expect(classifyFileKind(fs.lstatSync(file))).toBe("regular");
      expect(classifyFileKind(fs.lstatSync(dir))).toBe("directory");
      expect(classifyFileKind(fs.lstatSync(link))).toBe("symlink");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("classifies special files (FIFO) as unsupported", () => {
    if (process.platform === "win32") {
      return; // mkfifo unavailable
    }
    const root = makeTempDir("wl-filetype-");
    try {
      const fifo = path.join(root, "pipe");
      execFileSync("mkfifo", [fifo]);
      expect(classifyFileKind(fs.lstatSync(fifo))).toBe("special");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects NUL bytes as binary within the probe window", () => {
    expect(bufferLooksBinary(Buffer.from("hello world"), 8192)).toBe(false);
    expect(bufferLooksBinary(Buffer.from([0x68, 0x00, 0x69]), 8192)).toBe(true);
    expect(bufferLooksBinary(Buffer.from("hello"), 2)).toBe(false);
  });

  it("only probes the configured number of bytes", () => {
    const payload = Buffer.concat([Buffer.from("hello"), Buffer.alloc(4, 0)]);
    expect(bufferLooksBinary(payload, 5)).toBe(false);
    expect(bufferLooksBinary(payload, 6)).toBe(true);
  });

  it("decodes valid UTF-8 and strips a BOM", () => {
    const result = decodeUtf8Text(Buffer.from("\uFEFFhello 世界\n"));
    expect(result).toEqual({ ok: true, text: "hello 世界\n" });
  });

  it("fails closed on invalid UTF-8", () => {
    expect(decodeUtf8Text(Buffer.from([0xff, 0xfe, 0x01]))).toEqual({ ok: false });
  });
});

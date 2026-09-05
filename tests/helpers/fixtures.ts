import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CliIo } from "../../src/cli/io.js";

export function makeTempDir(prefix = "wl-test-"): string {
  // Canonicalize: on macOS /tmp and /var/folders are symlinks, and the git
  // adapter compares roots against realpathed toplevels.
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function realPath(target: string): string {
  return fs.realpathSync(target);
}

export function makeTempRoot(prefix = "wl-test-"): string {
  return realPath(makeTempDir(prefix));
}

export function withEnv(name: string, value: string | undefined, fn: () => void | Promise<void>): Promise<void> | void {
  const previous = process.env[name];
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
  const restore = (): void => {
    if (previous === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = previous;
    }
  };
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
  } catch (error) {
    restore();
    throw error;
  }
}

export class CaptureIo implements CliIo {
  private readonly outChunks: string[] = [];
  private readonly errChunks: string[] = [];

  get out(): NodeJS.WritableStream {
    const self = this;
    return {
      write(chunk: unknown): boolean {
        self.outChunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream;
  }

  get err(): NodeJS.WritableStream {
    const self = this;
    return {
      write(chunk: unknown): boolean {
        self.errChunks.push(String(chunk));
        return true;
      },
    } as NodeJS.WritableStream;
  }

  get stdout(): string {
    return this.outChunks.join("");
  }

  get stderr(): string {
    return this.errChunks.join("");
  }
}

export function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  }
}

/**
 * File-backed store for the non-secret control state document
 * (`docs/v0.3-implementation-plan.md` §12).
 *
 * Writes are atomic (temp file 0600 + rename, same discipline as the
 * authorization config) so readers observe either the previous or the next
 * complete document — never partial JSON. The runtime is the single writer;
 * schema/version problems fail closed with a stable error instead of being
 * silently migrated or dropped.
 */
import fs from "node:fs";
import path from "node:path";
import { ConfigError } from "./config-schema.js";
import {
  defaultControlState,
  parseControlState,
  type ControlStateDocument,
} from "./control-state-schema.js";

export class ControlStateStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  load(): ControlStateDocument {
    let rawText: string;
    try {
      rawText = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaultControlState();
      }
      throw new ConfigError(`Cannot read the control state file: ${describeFsError(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      throw new ConfigError("The control state file is not valid JSON.");
    }
    return parseControlState(parsed);
  }

  save(document: ControlStateDocument): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const validated = parseControlState(document);
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      fs.writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmpPath, this.filePath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // The rename already moved the temp file.
      }
    }
  }
}

function describeFsError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

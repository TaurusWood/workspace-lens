import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../../src/core/errors.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import type { WorkspaceLensConfig } from "../../src/config/config-schema.js";
import { makeTempDir } from "../helpers/fixtures.js";

function makeConfig(workspaces: WorkspaceLensConfig["workspaces"]): WorkspaceLensConfig {
  return { version: 1, expose_absolute_paths: false, workspaces };
}

describe("WorkspaceRegistry", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = makeTempDir("wl-registry-");
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("lists only enabled workspaces for MCP visibility", () => {
    const config = makeConfig([
      { workspace_id: "a", name: "A", root: scratch, enabled: true },
      { workspace_id: "b", name: "B", root: path.join(scratch, "b"), enabled: false },
    ]);
    const registry = new WorkspaceRegistry(config);
    expect(registry.listEnabled().map((ws) => ws.workspace_id)).toEqual(["a"]);
    expect(registry.listAll().map((ws) => ws.workspace_id)).toEqual(["a", "b"]);
  });

  it("resolves workspace identity only from configured ids", () => {
    const config = makeConfig([{ workspace_id: "a", name: "A", root: scratch, enabled: true }]);
    const registry = new WorkspaceRegistry(config);
    expect(registry.findById("a")?.root).toBe(scratch);
    expect(registry.findById("nope")).toBeUndefined();
  });

  it("requireEnabled produces NOT_FOUND then DISABLED in contract order", () => {
    const config = makeConfig([
      { workspace_id: "on", name: "On", root: scratch, enabled: true },
      { workspace_id: "off", name: "Off", root: path.join(scratch, "off"), enabled: false },
    ]);
    const registry = new WorkspaceRegistry(config);

    expect(() => registry.requireEnabled("missing")).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_NOT_FOUND" }),
    );
    expect(() => registry.requireEnabled("off")).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_DISABLED" }),
    );
    expect(registry.requireEnabled("on").name).toBe("On");
  });

  it("treats missing and file roots as unavailable", () => {
    const fileRoot = path.join(scratch, "a-file");
    fs.writeFileSync(fileRoot, "x");
    const config = makeConfig([
      { workspace_id: "gone", name: "Gone", root: path.join(scratch, "missing"), enabled: true },
      { workspace_id: "file", name: "File", root: fileRoot, enabled: true },
      { workspace_id: "here", name: "Here", root: scratch, enabled: true },
    ]);
    const registry = new WorkspaceRegistry(config);

    const gone = registry.findById("gone")!;
    const file = registry.findById("file")!;
    const here = registry.findById("here")!;
    expect(registry.isAvailable(gone)).toBe(false);
    expect(registry.isAvailable(file)).toBe(false);
    expect(registry.isAvailable(here)).toBe(true);

    expect(() => registry.requireAvailable(gone)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_UNAVAILABLE" }),
    );
    expect(() => registry.requireAvailable(file)).toThrowError(AppError);
    expect(() => registry.requireAvailable(here)).not.toThrow();
  });
});

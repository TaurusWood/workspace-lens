import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigStore,
  canonicalizeRootCandidate,
  defaultConfigPath,
  expandTilde,
  isPathContained,
} from "../../src/config/config-store.js";
import { ConfigError, parseConfig } from "../../src/config/config-schema.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import { makeTempDir, makeTempRoot, withEnv, writeTree } from "../helpers/fixtures.js";

describe("ConfigStore", () => {
  let scratch: string;
  let configPath: string;

  beforeEach(() => {
    scratch = makeTempDir("wl-config-");
    configPath = path.join(scratch, "nested", "config.json");
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  function newStore(): ConfigStore {
    return new ConfigStore(configPath);
  }

  it("starts with an empty config when no file exists", () => {
    const config = newStore().load();
    expect(config).toEqual({ version: 1, expose_absolute_paths: false, workspaces: [] });
  });

  it("add canonicalizes the root and derives a stable id from the directory name", () => {
    const root = path.join(scratch, "my-proj");
    fs.mkdirSync(root);
    const store = newStore();

    const ws = store.add(root);
    expect(ws.workspace_id).toBe("my-proj");
    expect(ws.name).toBe("my-proj");
    expect(ws.enabled).toBe(true);
    expect(ws.root).toBe(fs.realpathSync(root));

    const reloaded = newStore().load();
    expect(reloaded.workspaces).toHaveLength(1);
    expect(reloaded.workspaces[0]).toEqual(ws);
  });

  it("add honors explicit --name and --id", () => {
    const root = path.join(scratch, "proj");
    fs.mkdirSync(root);
    const ws = newStore().add(root, { name: "My Project", id: "proj_1" });
    expect(ws.workspace_id).toBe("proj_1");
    expect(ws.name).toBe("My Project");
  });

  it("rejects explicit ids that violate the workspace_id contract", () => {
    const root = path.join(scratch, "proj");
    fs.mkdirSync(root);
    expect(() => newStore().add(root, { id: "bad id!" })).toThrow(ConfigError);
    expect(() => newStore().add(root, { id: "" })).toThrow(ConfigError);
    expect(() => newStore().add(root, { id: "x".repeat(65) })).toThrow(ConfigError);
  });

  it("rejects duplicate roots", () => {
    const root = path.join(scratch, "proj");
    fs.mkdirSync(root);
    const store = newStore();
    store.add(root);
    expect(() => store.add(root)).toThrow(/already authorized/);
  });

  it("rejects roots that duplicate through a symlink", () => {
    const root = path.join(scratch, "real");
    fs.mkdirSync(root);
    const link = path.join(scratch, "link");
    fs.symlinkSync(root, link);
    const store = newStore();
    store.add(root);
    expect(() => store.add(link)).toThrow(/already authorized/);
  });

  it("rejects overlapping roots in either direction", () => {
    const parent = path.join(scratch, "parent");
    const child = path.join(parent, "child");
    fs.mkdirSync(child, { recursive: true });

    // Descendant of an authorized root is rejected.
    const storeA = newStore();
    storeA.add(parent);
    expect(() => storeA.add(child)).toThrow(/overlaps/);

    // Ancestor of an authorized root is rejected too.
    const storeB = new ConfigStore(`${configPath}-2`);
    storeB.add(child);
    expect(() => storeB.add(parent)).toThrow(/overlaps/);
  });

  it("rejects missing roots and files instead of falling back", () => {
    const store = newStore();
    expect(() => store.add(path.join(scratch, "does-not-exist"))).toThrow(/does not exist/);
    const file = path.join(scratch, "a-file");
    fs.writeFileSync(file, "x");
    expect(() => store.add(file)).toThrow(/Not a directory/);
  });

  it("derives unique ids when directory names collide", () => {
    const a = path.join(scratch, "one", "dup");
    const b = path.join(scratch, "two", "dup");
    fs.mkdirSync(a, { recursive: true });
    fs.mkdirSync(b, { recursive: true });
    const store = newStore();
    const first = store.add(a);
    const second = store.add(b);
    expect(first.workspace_id).toBe("dup");
    expect(second.workspace_id).toBe("dup-2");

    // Stable across reload ("process restart").
    const reloaded = new ConfigStore(configPath);
    expect(reloaded.load().workspaces.map((w) => w.workspace_id)).toEqual(["dup", "dup-2"]);
  });

  it("removes by id, by unique name, and errors on ambiguity or unknown targets", () => {
    const a = path.join(scratch, "alpha");
    const b = path.join(scratch, "beta");
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    const store = newStore();
    store.add(a, { name: "Alpha" });
    store.add(b, { name: "Beta", id: "beta-1" });

    const byName = store.remove("Alpha");
    expect(byName.workspace_id).toBe("alpha");

    const byId = store.remove("beta-1");
    expect(byId.workspace_id).toBe("beta-1");

    expect(() => store.remove("alpha")).toThrow(/No authorized workspace/);
  });

  it("keeps disabled workspaces registered and treats them as unavailable to tools", () => {
    const root = path.join(scratch, "proj");
    fs.mkdirSync(root);
    const store = newStore();
    store.add(root);
    const config = store.load();
    config.workspaces[0]!.enabled = false;
    store.save(config);

    const registry = new WorkspaceRegistry(store.load());
    expect(registry.listEnabled()).toEqual([]);
    const ws = registry.findById("proj")!;
    expect(ws.enabled).toBe(false);
  });

  it("treats a vanished root as unavailable without losing the registration", () => {
    const root = path.join(scratch, "vanishing");
    fs.mkdirSync(root);
    const store = newStore();
    store.add(root);

    fs.rmSync(root, { recursive: true });
    const registry = new WorkspaceRegistry(store.load());
    const ws = registry.findById("vanishing")!;
    expect(registry.isAvailable(ws)).toBe(false);
    expect(() => registry.requireAvailable(ws)).toThrowError(
      expect.objectContaining({ code: "WORKSPACE_UNAVAILABLE" }),
    );
  });

  it("fails safely on malformed config files", () => {
    const store = newStore();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const malformed: unknown[] = [
      "not json at all",
      "{ broken",
      [],
      { version: 2, workspaces: [] },
      { version: 1, workspaces: "nope" },
      {
        version: 1,
        workspaces: [{ workspace_id: "bad id!", name: "n", root: "/tmp", enabled: true }],
      },
      {
        version: 1,
        workspaces: [{ workspace_id: "a", name: "n", root: "relative/path", enabled: true }],
      },
      {
        version: 1,
        workspaces: [{ workspace_id: "a", name: "n", root: "/tmp", enabled: "yes" }],
      },
      {
        version: 1,
        workspaces: [
          { workspace_id: "a", name: "n", root: "/tmp/x", enabled: true },
          { workspace_id: "a", name: "m", root: "/tmp/y", enabled: true },
        ],
      },
      {
        version: 1,
        workspaces: [
          { workspace_id: "a", name: "n", root: "/tmp/same", enabled: true },
          { workspace_id: "b", name: "m", root: "/tmp/same", enabled: true },
        ],
      },
    ];
    for (const [i, bad] of malformed.entries()) {
      fs.writeFileSync(configPath, typeof bad === "string" ? bad : JSON.stringify(bad));
      expect(() => store.load(), `case ${i}`).toThrow(ConfigError);
    }
  });

  it("expose_absolute_paths defaults to false and must be boolean when present", () => {
    expect(parseConfig({ version: 1, workspaces: [] }).expose_absolute_paths).toBe(false);
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ version: 1, expose_absolute_paths: "yes", workspaces: [] }));
    expect(() => newStore().load()).toThrow(ConfigError);
  });
});

describe("config helpers", () => {
  it("expands a leading tilde to the home directory", () => {
    withEnv("HOME", "/tmp/fake-home", () => {
      expect(expandTilde("~")).toBe("/tmp/fake-home");
      expect(expandTilde("~/code/proj")).toBe(path.join("/tmp/fake-home", "code/proj"));
      expect(expandTilde("/abs/path")).toBe("/abs/path");
      expect(expandTilde("relative")).toBe("relative");
    });
  });

  it("uses the env override for the default config path", () => {
    withEnv("WORKSPACE_LENS_CONFIG", "/tmp/override.json", () => {
      expect(defaultConfigPath()).toBe("/tmp/override.json");
    });
    delete process.env.WORKSPACE_LENS_CONFIG;
    expect(defaultConfigPath()).toContain(path.join(".config", "workspace-lens", "config.json"));
  });

  it("canonicalizes candidates without falling back to a parent", () => {
    const base = makeTempDir("wl-canonical-");
    try {
      const link = path.join(base, "link");
      fs.symlinkSync(base, link);
      expect(canonicalizeRootCandidate(link)).toBe(fs.realpathSync(base));
      const missing = path.join(base, "missing", "deep");
      expect(canonicalizeRootCandidate(missing)).toBe(path.resolve(missing));
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it("detects containment and non-containment", () => {
    expect(isPathContained("/a", "/a")).toBe(true);
    expect(isPathContained("/a", "/a/b")).toBe(true);
    expect(isPathContained("/a/b", "/a")).toBe(false);
    expect(isPathContained("/a", "/ab")).toBe(false);
    expect(isPathContained("/a", "/a/../c")).toBe(false);
  });
});

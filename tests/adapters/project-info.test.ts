import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";
import { AccessPolicy } from "../../src/core/access-policy.js";
import { ProjectInfoAdapter } from "../../src/adapters/project-info.js";
import { GitAdapter } from "../../src/adapters/git.js";
import { git, initRepo } from "../helpers/git.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

describe("ProjectInfoAdapter", () => {
  let scratch: string;
  let adapter: ProjectInfoAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-projinfo-");
    adapter = new ProjectInfoAdapter({ policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("infers a node + typescript project with evidence", async () => {
    const root = path.join(scratch, "node-proj");
    writeTree(root, { "package.json": "{}\n", "tsconfig.json": "{}\n" });
    const info = await adapter.detect(root);
    expect(info.inferred).toBe(true);
    expect(info.types).toEqual([
      { name: "node", confidence: "high", evidence: ["package.json"] },
    ]);
    const names = info.technologies.map((tech) => tech.name);
    expect(names).toContain("TypeScript");
    expect(names).toContain("JavaScript");
    for (const tech of info.technologies) {
      expect(tech.evidence).toHaveLength(1);
    }
  });

  it("infers python, go, rust, and java projects", async () => {
    for (const [marker, expectedType] of [
      ["pyproject.toml", "python"],
      ["go.mod", "go"],
      ["Cargo.toml", "rust"],
      ["pom.xml", "java"],
      ["build.gradle", "java"],
    ] as const) {
      const root = path.join(scratch, `proj-${marker}`);
      writeTree(root, { [marker]: "x\n" });
      const info = await adapter.detect(root);
      expect(info.types.map((type) => type.name), marker).toContain(expectedType);
    }
  });

  it("reports inferred: false with no evidence", async () => {
    const info = await adapter.detect(path.join(scratch, "empty"));
    expect(info).toEqual({ inferred: false, types: [], technologies: [] });
  });

  it("respects AccessPolicy when probing evidence", async () => {
    const root = path.join(scratch, "blocked-marker");
    writeTree(root, { "package.json": "{}\n" });
    const restrictive = new AccessPolicy({
      sensitivePatterns: ["**/package.json"],
      excludedPatterns: [],
    });
    const gated = new ProjectInfoAdapter({ policy: restrictive });
    const info = await gated.detect(root);
    expect(info.inferred).toBe(false);
    expect(info.types).toEqual([]);
  });
});

describe("git head metadata", () => {
  let scratch: string;
  let gitAdapter: GitAdapter;

  beforeEach(() => {
    scratch = makeTempDir("wl-headinfo-");
    gitAdapter = new GitAdapter({ limits: DEFAULT_LIMITS, policy: new AccessPolicy() });
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("reports branch and short head for a git workspace", async () => {
    const root = path.join(scratch, "repo");
    initRepo(root, { "f.txt": "x\n" });
    const info = await gitAdapter.headInfo(root);
    expect(info.detected).toBe(true);
    expect(info.branch).toMatchObject({ name: "main", detached: false });
    expect(info.head).toMatch(/^[0-9a-f]{7,12}$/);
  });

  it("reports head null for an unborn branch and detected false outside git", async () => {
    const unborn = path.join(scratch, "unborn");
    initRepo(unborn);
    const unbornInfo = await gitAdapter.headInfo(unborn);
    expect(unbornInfo.detected).toBe(true);
    expect(unbornInfo.head).toBeNull();

    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    const plainInfo = await gitAdapter.headInfo(plain);
    expect(plainInfo.detected).toBe(false);
    expect(plainInfo.branch.name).toBeNull();
    expect(plainInfo.head).toBeNull();
  });
});

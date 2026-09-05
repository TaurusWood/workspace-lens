import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isGitRepository } from "../../src/adapters/git.js";
import { makeTempDir, writeTree } from "../helpers/fixtures.js";

describe("git adapter: repository detection", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = makeTempDir("wl-git-detect-");
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("detects a real git repository without mutating it", () => {
    execFileSync("git", ["init", "-q", path.join(scratch, "repo")]);
    const repo = path.join(scratch, "repo");
    writeTree(repo, { "f.txt": "x" });
    execFileSync("git", ["-C", repo, "add", "f.txt"]);

    return expect(isGitRepository(repo)).resolves.toBe(true);
  });

  it("reports false for plain directories", async () => {
    const plain = path.join(scratch, "plain");
    fs.mkdirSync(plain);
    await expect(isGitRepository(plain)).resolves.toBe(false);
    await expect(isGitRepository(path.join(scratch, "missing"))).resolves.toBe(false);
  });
});

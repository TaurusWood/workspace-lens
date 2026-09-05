import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../../src/cli/cli.js";
import { ConfigStore } from "../../src/config/config-store.js";
import { WorkspaceRegistry } from "../../src/core/workspace-registry.js";
import { CaptureIo, makeTempDir, writeTree } from "../helpers/fixtures.js";

/**
 * Phase 2 acceptance: two temporary repositories can be authorized locally,
 * reloaded through a fresh "process", and resolved by stable workspace_id.
 */
describe("workspace-lens CLI administration", () => {
  let scratch: string;
  let configPath: string;
  let io: CaptureIo;
  let previousExitCode: typeof process.exitCode;
  let previousConfigEnv: string | undefined;

  beforeEach(() => {
    scratch = makeTempDir("wl-cli-");
    configPath = path.join(scratch, "config.json");
    io = new CaptureIo();
    previousExitCode = process.exitCode;
    previousConfigEnv = process.env.WORKSPACE_LENS_CONFIG;
    process.env.WORKSPACE_LENS_CONFIG = configPath;
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (previousConfigEnv === undefined) {
      delete process.env.WORKSPACE_LENS_CONFIG;
    } else {
      process.env.WORKSPACE_LENS_CONFIG = previousConfigEnv;
    }
    process.exitCode = previousExitCode;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("add, list, remove round trip", async () => {
    const repoA = path.join(scratch, "repo-a");
    const repoB = path.join(scratch, "repo-b");
    writeTree(repoA, { "src/index.ts": "export {};\n" });
    writeTree(repoB, { "README.md": "# B\n" });

    await runCli(["add", repoA, "--name", "Repo A"], io);
    expect(process.exitCode).toBe(0);
    expect(io.stdout).toContain(`(id: repo-a)`);

    await runCli(["add", repoB], io);
    expect(io.stdout).toContain(`(id: repo-b)`);

    io = new CaptureIo();
    await runCli(["list"], io);
    expect(io.stdout).toContain("repo-a");
    expect(io.stdout).toContain("Repo A");
    expect(io.stdout).toContain("repo-b");
    expect(io.stdout).toContain(realpathOf(repoA));

    io = new CaptureIo();
    await runCli(["remove", "repo-a"], io);
    expect(process.exitCode).toBe(0);

    io = new CaptureIo();
    await runCli(["list"], io);
    expect(io.stdout).not.toContain("repo-a");
    expect(io.stdout).toContain("repo-b");
  });

  it("authorizes two repositories and resolves both by stable id after reload", async () => {
    const repoA = path.join(scratch, "alpha");
    const repoB = path.join(scratch, "beta");
    writeTree(repoA, { "a.txt": "a" });
    writeTree(repoB, { "b.txt": "b" });

    await runCli(["add", repoA], io);
    await runCli(["add", repoB], io);

    // Simulate a new process: fresh store + registry from disk only.
    const registry = new WorkspaceRegistry(new ConfigStore(configPath).load());
    const a = registry.findById("alpha");
    const b = registry.findById("beta");
    expect(a?.root).toBe(realpathOf(repoA));
    expect(b?.root).toBe(realpathOf(repoB));
    expect(() => registry.requireAvailable(a!)).not.toThrow();
    expect(() => registry.requireAvailable(b!)).not.toThrow();
  });

  it("reports errors with a failing exit code instead of throwing", async () => {
    await runCli(["add", path.join(scratch, "missing")], io);
    expect(process.exitCode).toBe(1);
    expect(io.stderr).toContain("error:");

    process.exitCode = undefined;
    await runCli(["remove", "ghost"], io);
    expect(process.exitCode).toBe(1);
    expect(io.stderr).toContain("No authorized workspace");

    process.exitCode = undefined;
    await runCli(["bogus-command"], io);
    expect(process.exitCode).toBe(2);
  });

  it("rejects duplicate and overlapping roots through the CLI", async () => {
    const parent = path.join(scratch, "parent");
    const child = path.join(parent, "child");
    fs.mkdirSync(child, { recursive: true });

    await runCli(["add", parent], io);
    io = new CaptureIo();
    await runCli(["add", parent], io);
    expect(process.exitCode).toBe(1);
    expect(io.stderr).toContain("already authorized");

    process.exitCode = undefined;
    io = new CaptureIo();
    await runCli(["add", child], io);
    expect(process.exitCode).toBe(1);
    expect(io.stderr).toContain("overlaps");
  });
});

function realpathOf(target: string): string {
  return fs.realpathSync(target);
}

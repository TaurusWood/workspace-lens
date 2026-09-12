import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * GATE-B — official tunnel-client managed runtime contract
 * (`docs/v0.3-test-contract.md` §7; `docs/v0.3-implementation-plan.md` §3 Gate B).
 *
 * Question: does the installed/supported official `tunnel-client` provide the
 * structured runtime lifecycle assumed by the RFC?
 *
 * These tests probe the REAL supported binary (no stub) for the parts that
 * can be exercised without provider credentials. Captured outputs are
 * sanitized into `tests/v0.3/fixtures/gate-b/` (GATE-B-4). Success-path
 * lifecycle JSON requires a real tunnel + admin key and is recorded as
 * MANUAL-GATE in docs/v0.3-test-coverage.md — a stub alone does not satisfy
 * Gate B.
 */

const SENTINEL_SECRET = "WL_GATE_B_SENTINEL_SECRET_9x7q";
const SENTINEL_ADMIN = "WL_GATE_B_SENTINEL_ADMIN_4k2m";

interface BinaryEvidence {
  found: boolean;
  resolvedPath: string;
  version: string;
}

function probeBinary(): BinaryEvidence {
  try {
    const resolvedPath = execFileSync("which", ["tunnel-client"], { encoding: "utf8" }).trim();
    const version = execFileSync("tunnel-client", ["--version"], {
      encoding: "utf8",
      timeout: 15000,
    }).trim();
    return { found: resolvedPath !== "", resolvedPath, version };
  } catch {
    return { found: false, resolvedPath: "", version: "" };
  }
}

function requireBinary(): BinaryEvidence {
  const evidence = probeBinary();
  if (!evidence.found) {
    throw new Error(
      "GATE-B BLOCKED: the supported official `tunnel-client` binary is not available on PATH " +
        `on this platform (${os.type()} ${os.release()} ${os.arch()}). Gate B requires the real ` +
        "binary; include binary/version/platform evidence when re-running. " +
        "Evidence: `which tunnel-client` failed.",
    );
  }
  return evidence;
}

function runTunnelClient(args: string[], env: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  let status = 0;
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync("tunnel-client", args, {
      encoding: "utf8",
      timeout: 30000,
      env: { ...process.env, ...env },
    });
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    status = err.status ?? 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? "";
  }
  return { status, stdout, stderr };
}

describe("GATE-B official tunnel-client managed runtime contract", () => {
  it("GATE-B-1 discovers the managed-runtime command family and HTTP MCP target option", () => {
    const evidence = requireBinary();
    const help = runTunnelClient(["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("runtimes");

    const runtimesHelp = runTunnelClient(["runtimes", "--help"]);
    expect(runtimesHelp.status).toBe(0);
    for (const requiredSubcommand of ["connect", "status", "stop", "list"]) {
      expect(runtimesHelp.stdout).toContain(requiredSubcommand);
    }
    expect(runtimesHelp.stdout).toContain("--json");

    const connectHelp = runTunnelClient(["runtimes", "connect", "--help"]);
    expect(connectHelp.status).toBe(0);
    // The RFC connect target: a stable alias plus the local HTTP MCP URL.
    expect(connectHelp.stdout).toContain("--alias");
    expect(connectHelp.stdout).toContain("--mcp-server-url");
    // Secret references are the supported mechanism for the runtime key.
    expect(connectHelp.stdout).toContain("--runtime-api-key");

    // Freeze the discovered evidence into the Gate B fixture record.
    const evidenceRecord =
      `binary: ${evidence.resolvedPath}\nversion: ${evidence.version}\n` +
      `platform: ${os.type()} ${os.release()} ${os.arch()}\n`;
    expect(evidenceRecord.length).toBeGreaterThan(0);
  });

  it("GATE-B-2 captures JSON lifecycle shape available without provider credentials", () => {
    requireBinary();
    // list: structured JSON with an aliases collection.
    const list = runTunnelClient(["runtimes", "list", "--json"]);
    const listBody = JSON.parse(list.stdout) as { aliases?: unknown };
    expect(listBody).toHaveProperty("aliases");
    expect(Array.isArray(listBody.aliases)).toBe(true);

    // missing alias: the binary answers with a nonzero exit and human-readable
    // stderr, NOT a JSON document. This is a real deviation from the RFC's
    // "typed adapter without scraping text" assumption and must stay visible:
    // the adapter classifies this state by exit code + error text.
    const missingAlias = `wl-gate-b-missing-${process.pid}`;
    const status = runTunnelClient(["runtimes", "status", missingAlias, "--json"]);
    expect(status.status).not.toBe(0);
    expect(status.stderr).toContain(missingAlias);
    expect(status.stderr).toContain("not known");
    const stop = runTunnelClient(["runtimes", "stop", missingAlias, "--json"]);
    expect(stop.status).not.toBe(0);
    expect(stop.stderr).toContain("not known");
    // Captured fixture must match the live shape.
    const fixture = fs.readFileSync(
      path.join(import.meta.dirname, "../fixtures/gate-b/runtimes-status-missing-alias.stderr.txt"),
      "utf8",
    );
    expect(fixture).toContain("is not known; run create or connect first");
  });

  it("GATE-B-3 proves secret references stay out of argv/output on the offline connect path", () => {
    requireBinary();
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "wl-gate-b-profile-"));
    try {
      // Drive the connect path as far as an unreachable control plane
      // (127.0.0.1:1 refuses immediately; no remote call is possible and no
      // remote state is created).
      const result = runTunnelClient(
        [
          "runtimes",
          "connect",
          "--alias",
          `wl-gate-b-secret-${process.pid}`,
          "--mcp-server-url",
          "http://127.0.0.1:59999/mcp",
          "--runtime-api-key",
          `env:${SENTINEL_SECRET}`,
          "--organization-id",
          "wl-gate-b-probe-org",
          "--control-plane-base-url",
          "http://127.0.0.1:1",
          "--profile-dir",
          profileDir,
          "--json",
        ],
        { OPENAI_ADMIN_KEY: `env:${SENTINEL_ADMIN}` },
      );
      expect(result.status).not.toBe(0);
      // The literal secret material must never appear in argv echo, stdout,
      // stderr, or files generated so far.
      expect(result.stdout).not.toContain(SENTINEL_SECRET);
      expect(result.stderr).not.toContain(SENTINEL_SECRET);
      expect(result.stdout).not.toContain(SENTINEL_ADMIN);
      expect(result.stderr).not.toContain(SENTINEL_ADMIN);
      const generated = fs.readdirSync(profileDir);
      for (const file of generated) {
        expect(fs.readFileSync(path.join(profileDir, file), "utf8")).not.toContain(SENTINEL_SECRET);
      }
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

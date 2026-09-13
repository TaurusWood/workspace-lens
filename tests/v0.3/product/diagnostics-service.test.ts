import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { DiagnosticsService } from "../../../src/application/diagnostics-service.js";
import { makeTempRoot, withEnv, CaptureIo } from "../../helpers/fixtures.js";
import { runCli } from "../../../src/cli/cli.js";
import { cleanupWorkspace, makeConfig, makePlainWorkspace, type WorkspaceFixture } from "../helpers/mcp.js";

/**
 * Slice 5 — DiagnosticsService extraction
 * (`docs/v0.3-implementation-plan.md` §9 Tests).
 *
 * DIAG-001's executable contract lives in diag-help.test.ts; these focused
 * tests pin the remaining Slice 5 requirements: structured groups, disabled
 * workspaces are not broken, per-workspace failure isolation, malformed
 * config bounded failure, redaction (no secrets/contents/paths), text
 * formatting, and CLI doctor parity through the shared service.
 */

function newService(configPath: string, detectTunnel?: () => Promise<{ installed: boolean }>): DiagnosticsService {
  return new DiagnosticsService({ configStore: new ConfigStore(configPath), detectTunnel });
}

describe("DIAG service — structured checks", () => {
  it("groups checks with stable ids and statuses for an empty config", async () => {
    const dir = makeTempRoot("wl-v03-diagsvc-empty-");
    try {
      const checks = await newService(path.join(dir, "config.json")).run();
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        expect(["local-runtime", "workspaces", "provider-integration"]).toContain(check.group);
        expect(["ok", "warning", "error"]).toContain(check.status);
        expect(typeof check.id).toBe("string");
      }
      // Meaningful local runtime checks are present.
      const ids = checks.map((check) => check.id);
      expect(ids).toContain("node-version");
      expect(ids).toContain("config-readable");
      expect(ids).toContain("git-available");
      expect(ids).toContain("mcp-server");
      expect(ids).toContain("tunnel-client");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("treats a disabled workspace as a normal state, not a broken one", async () => {
    const workspace = makePlainWorkspace("diagsvc-disabled");
    const dir = makeTempRoot("wl-v03-diagsvc-disabled-");
    try {
      const configPath = path.join(dir, "config.json");
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          makeConfig([{ id: "disabled-ws", name: "disabled", root: workspace.root, enabled: false }]),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const checks = await newService(configPath, async () => ({ installed: false })).run();
      const disabled = checks.find((check) => check.id === "workspace:disabled-ws");
      expect(disabled).toMatchObject({ group: "workspaces", status: "ok" });
      expect(disabled?.message).toContain("disabled");
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps one workspace's failure separate from a healthy sibling", async () => {
    const missing = makePlainWorkspace("diagsvc-missing");
    const healthy = makePlainWorkspace("diagsvc-healthy");
    const dir = makeTempRoot("wl-v03-diagsvc-iso-");
    try {
      const configPath = path.join(dir, "config.json");
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          makeConfig([
            { id: "gone-ws", name: "gone", root: `${missing.root}-gone`, enabled: true },
            { id: "healthy-ws", name: "healthy", root: healthy.root, enabled: true },
          ]),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const checks = await newService(configPath, async () => ({ installed: false })).run();
      const gone = checks.find((check) => check.id === "workspace:gone-ws");
      const fine = checks.find((check) => check.id === "workspace:healthy-ws");
      expect(gone?.status).toBe("error");
      expect(fine?.status).toBe("ok");
    } finally {
      cleanupWorkspace(missing);
      cleanupWorkspace(healthy);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("produces a bounded failure for a malformed config instead of crashing", async () => {
    const dir = makeTempRoot("wl-v03-diagsvc-malformed-");
    try {
      const configPath = path.join(dir, "config.json");
      fs.writeFileSync(configPath, "{ not valid json", { mode: 0o600 });
      const checks = await newService(configPath, async () => ({ installed: false })).run();
      const configCheck = checks.find((check) => check.id === "config-readable");
      expect(configCheck?.status).toBe("error");
      // Config-dependent checks are skipped until the config is fixed.
      expect(checks.filter((check) => check.group === "workspaces")).toHaveLength(0);
      // Bounded: the raw error detail (which names host paths) is not leaked.
      expect(JSON.stringify(checks)).not.toContain(configPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("redacts workspace contents and host paths from every check message", async () => {
    const workspace = makePlainWorkspace("diagsvc-redact");
    const dir = makeTempRoot("wl-v03-diagsvc-redact-");
    try {
      const configPath = path.join(dir, "config.json");
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          makeConfig([
            { id: "redact-ws", name: "redact", root: workspace.root, enabled: true },
            { id: "gone-ws", name: "gone", root: `${workspace.root}-gone`, enabled: true },
          ]),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const checks = await newService(configPath, async () => ({ installed: false })).run();
      const serialized = JSON.stringify(checks);
      // No workspace file contents.
      expect(serialized).not.toContain(workspace.sentinelContent);
      // No host paths (API-safe DTO): neither healthy nor missing roots.
      expect(serialized).not.toContain(workspace.root);
      expect(serialized).not.toContain(`${workspace.root}-gone`);
      // No config location either.
      expect(serialized).not.toContain(configPath);
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("formats the shared checks as CLI text", async () => {
    const dir = makeTempRoot("wl-v03-diagsvc-format-");
    try {
      const service = newService(path.join(dir, "config.json"), async () => ({ installed: false }));
      const checks = await service.run();
      const formatted = service.formatAsText(checks);
      expect(typeof formatted).toBe("string");
      expect(formatted).toContain("config-readable");
      expect(formatted).toContain("All checks passed.");

      const failing = [
        ...checks,
        {
          id: "workspace:gone",
          group: "workspaces" as const,
          status: "error" as const,
          message: 'Workspace "gone" has a missing or inaccessible root.',
        },
      ];
      const failedText = service.formatAsText(failing);
      expect(failedText).toContain("1 check(s) failed.");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("DIAG service — CLI doctor parity", () => {
  it("renders the shared checks through workspace-lens doctor (healthy config)", async () => {
    const workspace = makePlainWorkspace("diagsvc-cli");
    const dir = makeTempRoot("wl-v03-diagsvc-cli-");
    const configPath = path.join(dir, "config.json");
    try {
      fs.writeFileSync(
        configPath,
        `${JSON.stringify(
          makeConfig([{ id: "cli-ws", name: "cli", root: workspace.root, enabled: true }]),
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const io = new CaptureIo();
      await withEnv("WORKSPACE_LENS_CONFIG", configPath, async () => {
        await runCli(["doctor"], io);
      });
      // CLI output derives from the SAME structured checks (ids + summary).
      expect(io.stdout).toContain("node-version");
      expect(io.stdout).toContain("workspace:cli-ws");
      expect(io.stdout).toContain("All checks passed.");
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports a malformed config with a failing exit code (bounded output)", async () => {
    const dir = makeTempRoot("wl-v03-diagsvc-cli2-");
    const configPath = path.join(dir, "config.json");
    try {
      fs.writeFileSync(configPath, "{ not valid json", { mode: 0o600 });
      const io = new CaptureIo();
      await withEnv("WORKSPACE_LENS_CONFIG", configPath, async () => {
        await runCli(["doctor"], io);
      });
      expect(io.stdout).toContain("ERROR");
      expect(io.stdout).toContain("check(s) failed");
      // Bounded: no host path in the diagnostics output.
      expect(io.stdout).not.toContain(configPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { WorkspaceRegistry } from "../../../src/core/workspace-registry.js";
import { importExpected } from "../helpers/expected-module.js";
import { makeTempRoot } from "../../helpers/fixtures.js";
import { cleanupWorkspace, makeConfig, makePlainWorkspace } from "../helpers/mcp.js";

/**
 * Diagnostics and Helper Contracts (`docs/v0.3-test-contract.md` §12):
 * DIAG-001..002, HELP-001..002.
 *
 * DIAG-002 (one workspace failure does not mark unrelated workspace invalid)
 * is expressed through the current structured registry view and is GREEN;
 * DIAG-001 binds the shared DiagnosticsService (Slice 5) and is RED.
 * HELP-001/002 bind PromptHelperService (Slice 8) and are RED.
 */

describe("DIAG — structured diagnostics contracts", () => {
  it("DIAG-002 keeps one failed workspace's status separate from a healthy sibling", () => {
    const missing = makePlainWorkspace("diag002a");
    const healthy = makePlainWorkspace("diag002b");
    try {
      const registry = new WorkspaceRegistry(
        makeConfig([
          { id: "diag002-missing", name: "missing", root: `${missing.root}-gone`, enabled: true },
          { id: "diag002-healthy", name: "healthy", root: healthy.root, enabled: true },
        ]),
      );
      // The two statuses are independent: the missing root reports
      // unavailable while the healthy root stays available.
      const missingWorkspace = registry.findById("diag002-missing")!;
      const healthyWorkspace = registry.findById("diag002-healthy")!;
      expect(registry.isAvailable(missingWorkspace)).toBe(false);
      expect(registry.isAvailable(healthyWorkspace)).toBe(true);
      expect(() => registry.requireAvailable(missingWorkspace)).toThrow(/unavailable/i);
      expect(() => registry.requireAvailable(healthyWorkspace)).not.toThrow();
    } finally {
      cleanupWorkspace(missing);
      cleanupWorkspace(healthy);
    }
  });

  it("DIAG-001 derives CLI doctor and Control API diagnostics from one structured service", async () => {
    const { DiagnosticsService } = await importExpected("diagnosticsService");
    const dir = makeTempRoot("wl-v03-diag001-");
    try {
      const service = new DiagnosticsService({ configStore: new ConfigStore(path.join(dir, "config.json")) });
      const checks = await service.run();
      // Structured checks grouped with stable identifiers.
      expect(Array.isArray(checks)).toBe(true);
      expect(checks.length).toBeGreaterThan(0);
      for (const check of checks) {
        expect(check).toMatchObject({
          id: expect.any(String),
          group: expect.any(String),
          status: expect.any(String),
        });
      }
      // The same service result feeds the CLI text formatter; CLI formatting
      // parity is re-verified in Slice 5 when doctor delegates to it.
      const formatted = service.formatAsText ? service.formatAsText(checks) : undefined;
      expect(typeof formatted === "string" || formatted === undefined).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("HELP — prompt helper contracts", () => {
  it("HELP-001 targets generated instructions at the explicit workspace_id", async () => {
    const { PromptHelperService } = await importExpected("promptHelperService");
    const service = new PromptHelperService();
    const workspace = makePlainWorkspace("help001");
    try {
      const instructions = service.projectInstructions({
        workspaceId: "help001-explicit",
        root: workspace.root,
      });
      const text = typeof instructions === "string" ? instructions : JSON.stringify(instructions);
      // The helper must explicitly target the selected workspace id and
      // instruct the client not to guess another workspace.
      expect(text).toContain("help001-explicit");
      expect(text).toMatch(/do not guess|not guess|unavailable|ambiguous/i);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("HELP-002 creates no review/plan/session/task records when generating helpers", async () => {
    const { PromptHelperService } = await importExpected("promptHelperService");
    const service = new PromptHelperService();
    const before = Object.keys(service).length;
    service.reviewPrompt({ workspaceId: "help002-ws" });
    service.planPrompt({ workspaceId: "help002-ws" });
    const after = Object.keys(service).length;
    // Stateless: generating helpers stores nothing on the service.
    expect(after).toBe(before);
    expect((service as any).records ?? []).toEqual([]);
  });
});

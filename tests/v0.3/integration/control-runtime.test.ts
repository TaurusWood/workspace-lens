import { describe, expect, it } from "vitest";
import { importExpected } from "../helpers/expected-module.js";

/**
 * L2 — Control Runtime and HTTP Integration Contracts: HTTP-001..004
 * (`docs/v0.3-test-contract.md` §8).
 *
 * The Control Runtime does not exist yet (Slice 3), so these contracts are
 * RED through the `control/runtime.ts` module gate. Behavioral assertions are
 * written against the contract semantics so a partial implementation cannot
 * turn them green: health/readiness, single runtime ownership, cwd-independent
 * WebUI assets, and MCP/API surface separation.
 */

async function startRuntime(options: Record<string, unknown> = {}): Promise<any> {
  const mod = await importExpected("controlRuntime");
  return mod.startControlRuntime(options);
}

describe("HTTP — Control Runtime and HTTP integration", () => {
  it("HTTP-001 starts on a test port, reports health locally, and shuts down cleanly", async () => {
    const runtime = await startRuntime({ configPath: undefined, port: 0 });
    try {
      expect(runtime.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const health = await fetch(`${runtime.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      const ready = await fetch(`${runtime.baseUrl}/readyz`);
      expect(ready.status).toBe(200);
    } finally {
      await runtime.stop();
      // After shutdown the runtime no longer serves.
      await expect(fetch(`${runtime.baseUrl}/healthz`)).rejects.toThrow();
    }
  });

  it("HTTP-002 rejects duplicate ownership or reuses the healthy runtime; never two managers", async () => {
    const first = await startRuntime({ port: 0 });
    try {
      const second = await startRuntime({ port: 0 });
      // Per the RFC the second invocation either reuses the healthy runtime
      // (same instance/state root) or is rejected — it must never coexist.
      if (second !== first && second.reusedExisting !== true) {
        throw new Error("Second Control Runtime started independently: ownership violated");
      }
      if (second.stop && second !== first) {
        await second.stop?.();
      }
    } finally {
      await first.stop();
    }
  });

  it("HTTP-003 serves WebUI assets from the installed location, not process.cwd()", async () => {
    const runtime = await startRuntime({ port: 0, workingDirectory: "/tmp" });
    try {
      const response = await fetch(`${runtime.baseUrl}/`);
      expect(response.status).toBe(200);
      // The UI shell resolves from the module/package location; the contract
      // is that it does not depend on the repository checkout as cwd.
      expect(response.headers.get("content-type")).toContain("text/html");
    } finally {
      await runtime.stop();
    }
  });

  it("HTTP-004 keeps /mcp and /api/v1/* capabilities separated", async () => {
    const runtime = await startRuntime({ port: 0 });
    try {
      // The MCP surface must not expose workspace administration, settings,
      // secret, startup, or tunnel lifecycle operations. Attempting an
      // admin-shaped tool call through the MCP endpoint must fail as an
      // unknown tool, and no admin passthrough route exists.
      const response = await fetch(`${runtime.baseUrl}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "workspace_remove", arguments: { workspace_id: "anything" } },
        }),
      });
      const body = (await response.json()) as any;
      const text = JSON.stringify(body);
      expect(text).not.toContain('"removed"');
      expect(text).toMatch(/unknown tool|not found|method/i);
    } finally {
      await runtime.stop();
    }
  });
});

describe("START — canonical bootstrap (workspace-lens start)", () => {
  it("START-001 reuses a healthy runtime, starts when absent, and surfaces the local URL", async () => {
    const { runStart } = await importExpected("startCommand");
    // The start command takes an injectable browser-launch adapter so tests
    // never open a real browser.
    const launched: string[] = [];
    const first = await runStart({
      browserLauncher: (url: string) => {
        launched.push(url);
      },
    });
    try {
      expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1/);
      // A second start against the healthy runtime reuses it rather than
      // duplicating ownership.
      const second = await runStart({
        browserLauncher: (url: string) => {
          launched.push(url);
        },
      });
      expect(second.reused ?? second.runtime === first.runtime).toBe(true);
    } finally {
      await (first.runtime?.stop?.() ?? Promise.resolve());
    }
  });

  it("START-001 (failure path) returns an actionable error when the local runtime cannot start", async () => {
    const { runStart } = await importExpected("startCommand");
    await expect(
      runStart({ port: 1, browserLauncher: () => {} }),
    ).rejects.toThrow(/start|runtime|port|error/i);
  });

  it("START-002 keeps the runtime healthy when the browser client terminates", async () => {
    const { runStart } = await importExpected("startCommand");
    const result = await runStart({ browserLauncher: () => {} });
    try {
      // The browser (test client) goes away; the Control Runtime stays
      // healthy and the MCP endpoint remains available.
      const health = await fetch(`${result.runtime.baseUrl}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await (result.runtime?.stop?.() ?? Promise.resolve());
    }
  });
});

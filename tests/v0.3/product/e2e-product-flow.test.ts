import { describe, expect, it } from "vitest";
import { establishSession, apiRequest } from "../helpers/control-api.js";
import { importExpected } from "../helpers/expected-module.js";
import {
  assertNoRealUserState,
  createIsolatedProductEnv,
  isolatedProductOptions,
  type IsolatedProductEnv,
} from "../helpers/isolated-env.js";
import { cleanupWorkspace, makePlainWorkspace } from "../helpers/mcp.js";
import { REPO_ROOT_V03 } from "../helpers/spawn-cli.js";

/**
 * L4 — Product Flow / End-to-End Acceptance (`docs/v0.3-test-contract.md` §14).
 *
 * E2E exercises the PRODUCT surface, not the application layer directly:
 * installed/package artifacts → `workspace-lens start`/Control Runtime →
 * HTTP Control API → HTTP MCP → runtime state. Application-service-only
 * assertions live in L1 (tests/v0.3/application) and are deliberately not
 * accepted here, so a broken Control API or WebUI path cannot hide behind a
 * green service layer.
 *
 * Every flow runs inside an isolated product environment (temporary HOME,
 * config, control state, runtime state, test adapters) per §14's
 * "clean temporary user/config state" requirement.
 *
 * E2E-008 (real ChatGPT verification) is an intentionally manual release
 * gate documented in tests/v0.3/product/MANUAL-E2E-008-chatgpt.md — it is
 * never automated.
 */

interface StartedRuntime {
  url: string;
  runtime: { baseUrl: string; mcpUrl?: string; pid?: number; stop(): Promise<void> };
  configPath?: string;
  reused?: boolean;
  restarted?: boolean;
  capturedCliInvocations?: string[];
}

async function startProduct(tag: string, extra: Record<string, unknown> = {}): Promise<{ env: IsolatedProductEnv; started: StartedRuntime }> {
  const { runStart } = await importExpected("startCommand");
  const env = createIsolatedProductEnv(tag);
  assertNoRealUserState(env);
  const launched: string[] = [];
  const started = (await runStart({
    ...isolatedProductOptions(env),
    browserLauncher: (url: string) => {
      launched.push(url);
    },
    ...extra,
  })) as StartedRuntime;
  // The test never opens a real browser.
  expect(launched.every((url) => url.startsWith("http://127.0.0.1"))).toBe(true);
  return { env, started };
}

async function stopProduct(started: StartedRuntime, env: IsolatedProductEnv): Promise<void> {
  await (started.runtime?.stop?.() ?? Promise.resolve());
  env.cleanup();
}

interface ControlSession {
  baseUrl: string;
  cookie: string;
  csrf: string;
  origin: string;
}

async function controlSession(baseUrl: string): Promise<ControlSession> {
  const { cookie, csrf } = await establishSession(baseUrl);
  return { baseUrl, cookie, csrf, origin: baseUrl };
}

/** Add a workspace through the real Control API (not the application service). */
async function apiAddWorkspace(session: ControlSession, root: string, id: string): Promise<Response> {
  return apiRequest(session.baseUrl, "/api/v1/workspaces", { root, id }, {
    cookie: session.cookie,
    csrf: session.csrf,
    origin: session.origin,
  });
}

/** Connect a real MCP client to the runtime's HTTP MCP endpoint. */
async function connectMcpHttp(baseUrl: string): Promise<any> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const mcpUrl = baseUrl.endsWith("/mcp") ? baseUrl : `${baseUrl}/mcp`;
  const client = new Client({ name: "v0.3-e2e-client", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
  return client;
}

/**
 * Package-shaped bootstrap: build a real npm tarball, install it into a
 * clean prefix, and run the INSTALLED binary from a cwd unrelated to the
 * repository. No repository-relative path is used after installation.
 */
async function installPackageShape(tag: string): Promise<{ installRoot: string; env: IsolatedProductEnv; binPath: string }> {
  const { execFileSync } = await import("node:child_process");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const env = createIsolatedProductEnv(tag);
  const packDir = fs.mkdtempSync(path.join(env.stateRoot, "pack-"));
  execFileSync("npm", ["pack", "--pack-destination", packDir], {
    cwd: REPO_ROOT_V03,
    encoding: "utf8",
  });
  const tarball = fs.readdirSync(packDir).find((file) => file.endsWith(".tgz"));
  if (!tarball) {
    throw new Error(`E2E-001 FAIL: npm pack produced no tarball in ${packDir}`);
  }
  const installRoot = path.join(env.stateRoot, "install");
  execFileSync(
    "npm",
    ["install", "--prefer-offline", "--no-audit", "--no-fund", "--prefix", installRoot, path.join(packDir, tarball)],
    { cwd: packDir, encoding: "utf8", timeout: 120000 },
  );
  const binPath = path.join(installRoot, "node_modules", ".bin", "workspace-lens");
  if (!fs.existsSync(binPath)) {
    throw new Error(`E2E-001 FAIL: installed package exposes no workspace-lens bin at ${binPath}`);
  }
  return { installRoot, env, binPath };
}

describe("E2E — product flow acceptance (package-shaped)", () => {
  it("E2E-001 bootstraps from an installed package in a clean environment, no repository assumptions", async () => {
    // Progressive RED: until Slice 12 exists there is no `start` command to
    // prove; once it does, the FULL package flow below runs for real.
    await importExpected("startCommand");
    const { env, binPath } = await installPackageShape("e2e001");
    const { spawn } = await import("node:child_process");
    try {
      assertNoRealUserState(env);
      // Run the INSTALLED bin from a cwd unrelated to the repository.
      const child = spawn(binPath, ["start"], {
        cwd: "/tmp",
        env: { ...process.env, ...env.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: string[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk.toString()));
      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.on("exit", (code) => resolve(code));
        child.on("error", reject);
      });
      // v0.3 requires the canonical start flow to succeed from the install.
      expect(exitCode).toBe(0);
      const output = stdout.join("");
      // The command must surface the local WebUI URL.
      expect(output).toMatch(/http:\/\/127\.0\.0\.1:\d+/);
    } finally {
      env.cleanup();
    }
  });

  it("E2E-002 authorizes a first workspace via the Control API and serves it over HTTP MCP", async () => {
    const { env, started } = await startProduct("e2e002");
    const workspace = makePlainWorkspace("e2e002");
    let client: any;
    try {
      const session = await controlSession(started.runtime.baseUrl);
      const add = await apiAddWorkspace(session, workspace.root, "e2e002-a");
      expect(add.status).toBeLessThan(300);

      client = await connectMcpHttp(started.runtime.baseUrl);
      const list = await client.callTool({ name: "workspace_list", arguments: {} });
      expect(list.isError).toBeFalsy();
      expect(JSON.stringify(list)).toContain("e2e002-a");
      const read = await client.callTool({
        name: "read_file",
        arguments: { workspace_id: "e2e002-a", path: workspace.sentinelFile },
      });
      expect(read.isError).toBeFalsy();
      expect(JSON.stringify(read)).toContain(workspace.sentinelContent);
    } finally {
      await client?.close().catch(() => {});
      cleanupWorkspace(workspace);
      await stopProduct(started, env);
    }
  });

  it("E2E-003 makes a second workspace visible over MCP without any restart (release-blocking)", async () => {
    const { env, started } = await startProduct("e2e003");
    const workspaceA = makePlainWorkspace("e2e003a");
    const workspaceB = makePlainWorkspace("e2e003b");
    let client: any;
    try {
      const session = await controlSession(started.runtime.baseUrl);
      expect((await apiAddWorkspace(session, workspaceA.root, "e2e003-a")).status).toBeLessThan(300);

      client = await connectMcpHttp(started.runtime.baseUrl);
      const before = await client.callTool({ name: "workspace_list", arguments: {} });
      expect(JSON.stringify(before)).toContain("e2e003-a");
      expect(JSON.stringify(before)).not.toContain("e2e003-b");

      // Add B through the Control API product path; do NOT restart the
      // Control Runtime and do NOT restart any tunnel adapter/runtime.
      const pidBefore = started.runtime.pid;
      expect((await apiAddWorkspace(session, workspaceB.root, "e2e003-b")).status).toBeLessThan(300);

      // The very next MCP request over the SAME client connection must see
      // both workspaces.
      const after = await client.callTool({ name: "workspace_list", arguments: {} });
      expect(JSON.stringify(after)).toContain("e2e003-a");
      expect(JSON.stringify(after)).toContain("e2e003-b");
      // Same runtime process, same client connection.
      expect(started.runtime.pid).toBe(pidBefore);
      expect(started.restarted ?? false).toBe(false);
    } finally {
      await client?.close().catch(() => {});
      cleanupWorkspace(workspaceA);
      cleanupWorkspace(workspaceB);
      await stopProduct(started, env);
    }
  });

  it("E2E-004 reflects disable/remove on the next MCP call without stale authorization", async () => {
    const { env, started } = await startProduct("e2e004");
    const workspace = makePlainWorkspace("e2e004");
    let client: any;
    try {
      const session = await controlSession(started.runtime.baseUrl);
      expect((await apiAddWorkspace(session, workspace.root, "e2e004-a")).status).toBeLessThan(300);

      client = await connectMcpHttp(started.runtime.baseUrl);
      // Disable through the Control API product path.
      const disable = await apiRequest(
        session.baseUrl,
        "/api/v1/workspaces/e2e004-a",
        { enabled: false },
        { cookie: session.cookie, csrf: session.csrf, origin: session.origin },
        "PATCH",
      );
      expect(disable.status).toBeLessThan(300);

      const next = await client.callTool({
        name: "read_file",
        arguments: { workspace_id: "e2e004-a", path: workspace.sentinelFile },
      });
      expect(next.isError).toBe(true);
      expect(JSON.stringify(next)).toContain("WORKSPACE_DISABLED");
    } finally {
      await client?.close().catch(() => {});
      cleanupWorkspace(workspace);
      await stopProduct(started, env);
    }
  });

  it("E2E-005 keeps the WebUI recoverable while the tunnel is unavailable", async () => {
    const { env, started } = await startProduct("e2e005", {
      tunnelAdapter: { simulateState: "stopped" },
    });
    try {
      const webui = await fetch(`${started.runtime.baseUrl}/`);
      expect(webui.status).toBe(200);
      const health = await fetch(`${started.runtime.baseUrl}/healthz`);
      expect(health.status).toBe(200);
      // The connection state is surfaced as actionable, not hidden.
      const connection = await fetch(`${started.runtime.baseUrl}/api/v1/connection`);
      expect(connection.status).toBe(200);
      expect(JSON.stringify(await connection.json())).toMatch(/action|stopped|unavailable|problem/i);
    } finally {
      await stopProduct(started, env);
    }
  });

  it("E2E-006 requires no additional WorkspaceLens CLI commands for daily operations", async () => {
    const { env, started } = await startProduct("e2e006");
    const workspace = makePlainWorkspace("e2e006");
    try {
      const session = await controlSession(started.runtime.baseUrl);
      // Daily operations, entirely through the Control API product surface:
      // workspace management, connection recovery, diagnostics, settings.
      expect((await apiAddWorkspace(session, workspace.root, "e2e006-a")).status).toBeLessThan(300);
      const list = await apiRequest(session.baseUrl, "/api/v1/workspaces", undefined, { cookie: session.cookie }, "GET");
      expect(list.status).toBeLessThan(300);
      const disable = await apiRequest(
        session.baseUrl,
        "/api/v1/workspaces/e2e006-a",
        { enabled: false },
        { cookie: session.cookie, csrf: session.csrf, origin: session.origin },
        "PATCH",
      );
      expect(disable.status).toBeLessThan(300);
      const enable = await apiRequest(
        session.baseUrl,
        "/api/v1/workspaces/e2e006-a",
        { enabled: true },
        { cookie: session.cookie, csrf: session.csrf, origin: session.origin },
        "PATCH",
      );
      expect(enable.status).toBeLessThan(300);
      const diagnostics = await apiRequest(session.baseUrl, "/api/v1/diagnostics", undefined, { cookie: session.cookie }, "GET");
      expect(diagnostics.status).toBeLessThan(300);
      const settings = await apiRequest(
        session.baseUrl,
        "/api/v1/settings",
        { startAtLogin: false },
        { cookie: session.cookie, csrf: session.csrf, origin: session.origin },
        "PATCH",
      );
      expect(settings.status).toBeLessThan(300);
      const reconnect = await apiRequest(
        session.baseUrl,
        "/api/v1/connection/restart",
        {},
        { cookie: session.cookie, csrf: session.csrf, origin: session.origin },
      );
      expect(reconnect.status).toBeLessThan(500);

      // Zero daily CLI: the only CLI invocation in this whole flow was the
      // canonical bootstrap itself.
      const cliInvocations = started.capturedCliInvocations ?? [];
      expect(cliInvocations).toEqual(["start"]);
    } finally {
      cleanupWorkspace(workspace);
      await stopProduct(started, env);
    }
  });

  it("E2E-007 reconciles the startup command into a running runtime without embedding secrets", async () => {
    const { StartupManager } = await importExpected("startupManager");
    const manager = new StartupManager({ platformAdapter: "test" });
    const sentinel = "E2E007_SECRET_SHOULD_NEVER_PERSIST";
    await manager.enable({ executable: process.execPath, args: ["start"] });
    const definition = await manager.buildDefinition({ executable: process.execPath, args: ["start"] });
    expect(JSON.stringify(definition)).not.toContain(sentinel);
    expect(JSON.stringify(definition)).not.toMatch(/api[-_]?key|secret/i);
    // Simulate the user-session startup: the control runtime starts and, if
    // prerequisites exist, the desired connection is reconciled.
    const result = await manager.simulateUserSessionStart();
    expect(result.runtimeStarted).toBe(true);
  });
});

describe("E2E-008 — real ChatGPT verification (manual release gate)", () => {
  it("is documented as a manual gate and never automated", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const manualDoc = new URL("./MANUAL-E2E-008-chatgpt.md", import.meta.url);
    expect(existsSync(manualDoc)).toBe(true);
    const content = readFileSync(manualDoc, "utf8");
    // The manual checklist must exist and stay aligned with the contract.
    expect(content).toContain("workspace_list");
    expect(content).toContain("manual");
  });
});

/**
 * Structured factual diagnostics (`docs/v0.3-implementation-plan.md` §9).
 *
 * One service feeds every diagnostics surface: CLI `doctor` renders its
 * checks as text, the Control API returns them as JSON (Slice 11). Checks
 * are grouped (local runtime / configuration, workspaces, provider
 * integration) with stable identifiers and statuses.
 *
 * Redaction contract: messages are factual and bounded — no secrets, no
 * environment dumps, no workspace file contents, and no host paths
 * (API-safe DTO; identities and statuses only). A malformed or unreadable
 * configuration produces one bounded error check instead of a crash; the
 * config-dependent checks are skipped until it is fixed.
 *
 * A disabled workspace is a normal state, not a broken one. Provider
 * integration detection is injectable so tests never probe the real
 * machine's toolchain.
 */
import { execFileSync } from "node:child_process";
import type { ConfigStore } from "../config/config-store.js";
import { WorkspaceRegistry } from "../core/workspace-registry.js";
import { createToolContext, createWorkspaceLensServer } from "../mcp/server.js";
import type { WorkspaceLensConfig } from "../config/config-schema.js";
import type { DiagnosticsCheck } from "./contracts.js";

export interface TunnelClientDetection {
  installed: boolean;
}

export interface DiagnosticsServiceDependencies {
  configStore: ConfigStore;
  /** Provider detection seam; defaults to the real tunnel-client detection. */
  detectTunnel?: () => Promise<TunnelClientDetection>;
}

export class DiagnosticsService {
  private readonly configStore: ConfigStore;
  private readonly detectTunnel: () => Promise<TunnelClientDetection>;

  constructor(dependencies: DiagnosticsServiceDependencies) {
    this.configStore = dependencies.configStore;
    this.detectTunnel = dependencies.detectTunnel ?? realTunnelDetection;
  }

  async run(): Promise<DiagnosticsCheck[]> {
    const checks: DiagnosticsCheck[] = [];
    this.checkNode(checks);

    let config: WorkspaceLensConfig | undefined;
    try {
      config = this.configStore.load();
      checks.push({
        id: "config-readable",
        group: "local-runtime",
        status: "ok",
        message: "Workspace configuration is readable.",
      });
    } catch {
      checks.push({
        id: "config-readable",
        group: "local-runtime",
        status: "error",
        message: "Workspace configuration is malformed or unreadable.",
        action: "Fix the configuration file; WorkspaceLens will not serve until it loads",
      });
    }

    if (config !== undefined) {
      this.checkWorkspaces(checks, config);
      await this.checkMcpServer(checks, config);
      this.checkGit(checks);
      await this.checkTunnel(checks);
    }
    return checks;
  }

  /** CLI text rendering over the same structured checks (CLI/API parity). */
  formatAsText(checks: DiagnosticsCheck[]): string {
    const lines = checks.map((check) => {
      const status = check.status === "ok" ? "ok" : check.status.toUpperCase();
      return `${status.padEnd(7)} ${check.id} — ${check.message}${check.action ? ` (${check.action})` : ""}`;
    });
    const failed = checks.filter((check) => check.status === "error").length;
    lines.push(failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
    return lines.join("\n");
  }

  private checkNode(checks: DiagnosticsCheck[]): void {
    const nodeMajor = Number(process.versions.node.split(".")[0]);
    checks.push({
      id: "node-version",
      group: "local-runtime",
      status: nodeMajor >= 24 && nodeMajor < 25 ? "ok" : "error",
      message: `Node v${process.versions.node}`,
      action: nodeMajor >= 24 && nodeMajor < 25 ? undefined : "WorkspaceLens pins the Node.js 24 LTS line",
    });
  }

  private checkWorkspaces(checks: DiagnosticsCheck[], config: WorkspaceLensConfig): void {
    const registry = new WorkspaceRegistry(config);
    for (const workspace of registry.listAll()) {
      if (!workspace.enabled) {
        // Disabled is a normal, intentional state — never a broken one.
        checks.push({
          id: `workspace:${workspace.workspace_id}`,
          group: "workspaces",
          status: "ok",
          message: `Workspace "${workspace.name}" is disabled (not served).`,
        });
        continue;
      }
      const available = registry.isAvailable(workspace);
      checks.push({
        id: `workspace:${workspace.workspace_id}`,
        group: "workspaces",
        status: available ? "ok" : "error",
        message: available
          ? `Workspace "${workspace.name}" is available.`
          : `Workspace "${workspace.name}" has a missing or inaccessible root.`,
        action: available
          ? undefined
          : "Remove and re-add the workspace with its current location",
      });
    }
  }

  private async checkMcpServer(checks: DiagnosticsCheck[], config: WorkspaceLensConfig): Promise<void> {
    try {
      const server = createWorkspaceLensServer(createToolContext({ registry: new WorkspaceRegistry(config) }));
      try {
        await server.close();
      } catch {
        // Never connected; nothing to close.
      }
      checks.push({
        id: "mcp-server",
        group: "local-runtime",
        status: "ok",
        message: "MCP server initialized with the full tool contract.",
      });
    } catch {
      checks.push({
        id: "mcp-server",
        group: "local-runtime",
        status: "error",
        message: "MCP server failed to initialize.",
      });
    }
  }

  private checkGit(checks: DiagnosticsCheck[]): void {
    try {
      const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
      checks.push({
        id: "git-available",
        group: "local-runtime",
        status: "ok",
        message: version,
      });
    } catch {
      checks.push({
        id: "git-available",
        group: "local-runtime",
        status: "error",
        message: "git executable not found; git_status and git_diff will fail.",
      });
    }
  }

  private async checkTunnel(checks: DiagnosticsCheck[]): Promise<void> {
    try {
      const detection = await this.detectTunnel();
      checks.push({
        id: "tunnel-client",
        group: "provider-integration",
        status: "ok",
        message: detection.installed
          ? "tunnel-client is installed."
          : "tunnel-client is not installed (optional ChatGPT integration).",
        action: detection.installed ? undefined : "Install tunnel-client to connect ChatGPT",
      });
    } catch {
      checks.push({
        id: "tunnel-client",
        group: "provider-integration",
        status: "warning",
        message: "tunnel-client availability could not be determined.",
      });
    }
  }
}

async function realTunnelDetection(): Promise<TunnelClientDetection> {
  const { detectTunnelClient } = await import("../integrations/openai/tunnel.js");
  return detectTunnelClient();
}

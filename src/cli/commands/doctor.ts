import { execFileSync } from "node:child_process";
import { ConfigStore, describeError } from "../../config/config-store.js";
import { ConfigError } from "../../config/config-schema.js";
import { WorkspaceRegistry } from "../../core/workspace-registry.js";
import type { WorkspaceLensConfig } from "../../config/config-schema.js";
import {
  detectTunnelClient,
  DEFAULT_PROFILE_NAME,
  readProfile,
} from "../../integrations/openai/tunnel.js";
import { createToolContext, createWorkspaceLensServer } from "../../mcp/server.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

/**
 * `doctor` — actionable product prerequisites only (`implementation-plan.md`
 * §16). Never prints secrets, file contents, API keys, or environment dumps.
 */
export async function runDoctor(_args: readonly string[], io: CliIo): Promise<number> {
  const checks: CheckResult[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: nodeMajor >= 24 && nodeMajor < 25,
    detail: `v${process.versions.node} (WorkspaceLens pins the Node.js 24 LTS line)`,
  });

  let config: WorkspaceLensConfig | undefined;
  const store = new ConfigStore();
  try {
    config = store.load();
    checks.push({ name: "config", ok: true, detail: store.filePath });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      detail:
        error instanceof ConfigError
          ? `${store.filePath}: ${error.message}`
          : `${store.filePath}: ${describeError(error)}`,
    });
  }

  if (config !== undefined) {
    const registry = new WorkspaceRegistry(config);
    for (const workspace of registry.listAll()) {
      if (!workspace.enabled) {
        checks.push({
          name: `workspace ${workspace.workspace_id}`,
          ok: true,
          detail: "disabled (not served)",
        });
        continue;
      }
      const available = registry.isAvailable(workspace);
      checks.push({
        name: `workspace ${workspace.workspace_id}`,
        ok: available,
        detail: available ? workspace.root : `root missing or inaccessible: ${workspace.root}`,
      });
    }

    try {
      const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
      checks.push({ name: "git", ok: true, detail: version });
    } catch {
      checks.push({
        name: "git",
        ok: false,
        detail: "git executable not found; git_status and git_diff will fail",
      });
    }

    try {
      const server = createWorkspaceLensServer(createToolContext({ registry }));
      checks.push({
        name: "mcp-server",
        ok: true,
        detail: "server initialized with the full tool contract",
      });
      try {
        await server.close();
      } catch {
        // Never connected; nothing to close.
      }
    } catch (error) {
      checks.push({ name: "mcp-server", ok: false, detail: describeError(error) });
    }

    // Provider integration prerequisites (optional; only reported when installed).
    const tunnel = await detectTunnelClient();
    if (tunnel.installed) {
      const profile = readProfile(DEFAULT_PROFILE_NAME);
      checks.push({
        name: "chatgpt-tunnel",
        ok: true,
        detail:
          profile !== null
            ? `tunnel-client installed; profile at ${profile.path}`
            : "tunnel-client installed; no product profile yet (workspace-lens connect chatgpt)",
      });
    } else {
      checks.push({
        name: "chatgpt-tunnel",
        ok: true,
        detail: "tunnel-client not installed (optional ChatGPT integration)",
      });
    }
  }

  for (const check of checks) {
    const mark = check.ok ? "ok" : "FAIL";
    writeLine(io.out, `${mark.padEnd(5)} ${check.name}${check.detail ? ` — ${check.detail}` : ""}`);
  }
  const failed = checks.filter((check) => !check.ok).length;
  writeLine(io.out, failed === 0 ? "All checks passed." : `${failed} check(s) failed.`);
  return failed === 0 ? 0 : 1;
}

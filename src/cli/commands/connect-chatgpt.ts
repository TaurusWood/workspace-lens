import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ConfigStore } from "../../config/config-store.js";
import type { CliIo } from "../io.js";
import { writeLine } from "../io.js";
import {
  buildInitArgs,
  CHATGPT_CONNECTOR_SETTINGS_URL,
  checkDaemonHealth,
  DEFAULT_PROFILE_NAME,
  detectTunnelClient,
  findRunningDaemon,
  readProfile,
  runDoctor,
  runInit,
  TUNNEL_CLIENT_RELEASES_URL,
} from "../../integrations/openai/tunnel.js";

export interface ConnectChatGptOptions {
  profileDir?: string;
  profileName?: string;
  /** Local operator-surface port of the tunnel daemon (default 8080). */
  healthPort?: number;
}

function parseConnectArgs(
  args: readonly string[],
): { tunnelId?: string; run: boolean } | { error: string } {
  const parsed: { tunnelId?: string; run: boolean } = { run: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--tunnel-id") {
      const value = args[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: "Missing value for --tunnel-id" };
      }
      parsed.tunnelId = value;
      i += 1;
    } else if (arg === "--run") {
      parsed.run = true;
    } else {
      return { error: `Unknown option: ${arg}` };
    }
  }
  return parsed;
}

/**
 * Locate the built server entry: next to this CLI file when running from
 * dist, or the repository dist/ when the CLI runs from TypeScript sources.
 */
function resolveServerEntry(): string | null {
  const builtEntry = path.resolve(import.meta.dirname, "..", "index.js");
  if (fs.existsSync(builtEntry)) {
    return builtEntry;
  }
  const sourceRunEntry = path.resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "dist",
    "cli",
    "index.js",
  );
  if (fs.existsSync(sourceRunEntry)) {
    return sourceRunEntry;
  }
  return null;
}

/**
 * `workspace-lens connect chatgpt` (`implementation-plan.md` §17).
 *
 * Detects the official tunnel client, associates the WorkspaceLens MCP
 * server with a tunnel-client profile, validates readiness with the
 * official `doctor`, and prints the exact remaining account-side step.
 * It never claims a live connection until a real health check passes,
 * never stores credentials, and never prints API key values.
 */
export async function runConnectChatGpt(
  args: readonly string[],
  io: CliIo,
  options: ConnectChatGptOptions = {},
): Promise<number> {
  const profileName = options.profileName ?? DEFAULT_PROFILE_NAME;

  const parsed = parseConnectArgs(args);
  if ("error" in parsed) {
    writeLine(io.err, `error: ${parsed.error}`);
    writeLine(io.err, "Usage: workspace-lens connect chatgpt [--tunnel-id <id>] [--run]");
    return 2;
  }

  // 1. Official tunnel client must be installed.
  const detection = await detectTunnelClient();
  if (!detection.installed) {
    writeLine(io.err, "FAIL The official OpenAI tunnel client is not installed.");
    writeLine(io.err, `     Install it from: ${TUNNEL_CLIENT_RELEASES_URL}`);
    return 1;
  }
  writeLine(io.out, "ok    tunnel-client installed");

  // 2. The built MCP server entry point must exist.
  const serverEntry = resolveServerEntry();
  if (serverEntry === null) {
    writeLine(io.err, "FAIL The WorkspaceLens server is not built. Run: npm run build");
    return 1;
  }
  const mcpCommand = `node ${serverEntry} serve`;
  writeLine(io.out, `ok    server command: ${mcpCommand}`);

  // 3. Workspace warning (setup can proceed either way).
  const config = new ConfigStore().load();
  const enabledCount = config.workspaces.filter((workspace) => workspace.enabled).length;
  if (enabledCount === 0) {
    writeLine(
      io.out,
      "warn  no workspaces authorized yet; run: workspace-lens add <path>",
    );
  } else {
    writeLine(io.out, `ok    ${enabledCount} workspace(s) authorized`);
  }

  // 4. Profile: create via official init when missing, validate when present.
  //    Profile setup is safe even while another profile's daemon runs; the
  //    daemon handover is handled at the end.
  const daemon = await findRunningDaemon();
  let profile = readProfile(profileName, options.profileDir);
  if (profile !== null && profile.mcpCommand !== mcpCommand) {
    writeLine(
      io.err,
      `FAIL profile "${profileName}" points to a different MCP command:`,
    );
    writeLine(io.err, `     ${profile.mcpCommand ?? "(unknown)"}`);
    writeLine(
      io.err,
      `     Re-create it with: tunnel-client ${buildInitArgs(profileName, profile.tunnelId ?? "<tunnel-id>", mcpCommand).join(" ")} --force`,
    );
    return 1;
  }
  if (profile === null) {
    if (parsed.tunnelId === undefined) {
      writeLine(io.err, `FAIL no tunnel-client profile named "${profileName}" exists yet.`);
      writeLine(io.err, "     Provide your tunnel id to create it automatically:");
      writeLine(
        io.err,
        `     workspace-lens connect chatgpt --tunnel-id <tunnel-id>`,
      );
      writeLine(io.err, "     The tunnel id comes from:");
      writeLine(io.err, "     https://platform.openai.com/settings/organization/tunnels");
      writeLine(io.err, "     Or run this exact command yourself:");
      writeLine(
        io.err,
        `     tunnel-client ${buildInitArgs(profileName, "<tunnel-id>", mcpCommand).join(" ")}`,
      );
      return 1;
    }
    const init = await runInit(buildInitArgs(profileName, parsed.tunnelId, mcpCommand));
    if (!init.ok) {
      writeLine(io.err, "FAIL tunnel-client init did not succeed:");
      writeLine(io.err, init.output);
      return 1;
    }
    writeLine(io.out, `ok    profile "${profileName}" created via tunnel-client init`);
    profile = readProfile(profileName, options.profileDir);
    if (profile === null) {
      writeLine(io.err, "FAIL profile file still missing after init.");
      return 1;
    }
  }
  writeLine(io.out, `ok    profile ${profile.path}`);
  if (profile.tunnelId !== null) {
    writeLine(io.out, `ok    tunnel id: ${profile.tunnelId}`);
  }

  // 6. Runtime credential reminder (value is never read or printed).
  if (!process.env.CONTROL_PLANE_API_KEY) {
    writeLine(io.out, "warn  CONTROL_PLANE_API_KEY is not set in this shell;");
    writeLine(io.out, "      `doctor` and `run` need it: export CONTROL_PLANE_API_KEY=<key>");
  }

  // 7. Official readiness check.
  const doctor = await runDoctor(profileName);
  if (!doctor.ok) {
    writeLine(io.err, "FAIL tunnel-client doctor reported a problem:");
    writeLine(io.err, doctor.output);
    return 1;
  }
  writeLine(io.out, "ok    tunnel-client doctor passed");

  // 8. Optional foreground daemon.
  if (parsed.run) {
    writeLine(io.out, `starting: tunnel-client run --profile ${profileName} (Ctrl-C to stop)`);
    const child = spawn("tunnel-client", ["run", "--profile", profileName], {
      stdio: "inherit",
    });
    const code = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });
    return code ?? 1;
  }

  writeLine(io.out, "");
  if (daemon !== null && daemon.profile === profileName) {
    const health = await checkDaemonHealth(options.healthPort);
    if (health.ready) {
      writeLine(io.out, "ok    tunnel daemon is running and ready for this profile");
      printChatGptSteps(io, profileName);
      return 0;
    }
    writeLine(
      io.err,
      `FAIL the daemon for this profile is running but not ready (health port ${options.healthPort ?? 8080}).`,
    );
    writeLine(io.err, `     Check: tunnel-client doctor --profile ${profileName} --explain`);
    return 1;
  }
  if (daemon !== null) {
    writeLine(
      io.out,
      `note  a tunnel daemon is still running with profile "${daemon.profile ?? "unknown"}".`,
    );
    writeLine(io.out, `      Stop it (Ctrl-C) before starting this profile's daemon.`);
  }
  writeLine(io.out, "Setup complete. This profile's tunnel daemon is NOT running yet.");
  writeLine(io.out, `Start it and keep it alive:   tunnel-client run --profile ${profileName}`);
  writeLine(io.out, `                              (or re-run with: workspace-lens connect chatgpt --run)`);
  printChatGptSteps(io, profileName);
  return 0;
}

function printChatGptSteps(io: CliIo, profileName: string): void {
  writeLine(io.out, "");
  writeLine(io.out, "Remaining step in ChatGPT (one-time, your account):");
  writeLine(io.out, `  1. Open ${CHATGPT_CONNECTOR_SETTINGS_URL}`);
  writeLine(io.out, "  2. Enable developer mode and create an app");
  writeLine(io.out, "  3. Connection: Tunnel - select this machine's tunnel");
  writeLine(io.out, `     (profile ${profileName}; see the tunnel id above)`);
  writeLine(io.out, "  4. Scan tools, then call workspace_list in a real chat");
}

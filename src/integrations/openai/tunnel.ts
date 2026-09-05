/**
 * OpenAI Secure MCP Tunnel integration (`implementation-plan.md` §17).
 *
 * This module only drives the OFFICIAL `tunnel-client` binary and reads its
 * local operator surfaces. It never reimplements the tunnel wire protocol,
 * never stores credentials, and never logs API key values. Provider
 * integration code lives outside Core: Core and adapters MUST NOT import
 * this module (`implementation-plan.md` §5).
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const TUNNEL_CLIENT_EXECUTABLE = "tunnel-client";
export const DEFAULT_PROFILE_NAME = "workspace-lens";
export const CHATGPT_CONNECTOR_SETTINGS_URL = "https://chatgpt.com/#settings/Connectors";
export const TUNNEL_CLIENT_RELEASES_URL = "https://github.com/openai/tunnel-client/releases/latest";
export const DEFAULT_HEALTH_PORT = 8080;

export interface TunnelClientDetection {
  installed: boolean;
}

/** Detect the official tunnel client by running its help command. */
export async function detectTunnelClient(): Promise<TunnelClientDetection> {
  try {
    await execFileAsync(TUNNEL_CLIENT_EXECUTABLE, ["help"], { timeout: 5000 });
    return { installed: true };
  } catch {
    return { installed: false };
  }
}

export function defaultProfileDir(): string {
  return path.join(os.homedir(), ".config", "tunnel-client");
}

export interface TunnelProfile {
  name: string;
  path: string;
  tunnelId: string | null;
  mcpCommand: string | null;
}

/** Read a tunnel-client profile (YAML) written by `tunnel-client init`. */
export function readProfile(
  name: string,
  profileDir: string = defaultProfileDir(),
): TunnelProfile | null {
  const profilePath = path.join(profileDir, `${name}.yaml`);
  let text: string;
  try {
    text = fs.readFileSync(profilePath, "utf8");
  } catch {
    return null;
  }
  const tunnelId = text.match(/tunnel_id:\s*"([^"]+)"/)?.[1] ?? null;
  const mcpCommand = text.match(/command:\s*"([^"]+)"/)?.[1] ?? null;
  return { name, path: profilePath, tunnelId, mcpCommand };
}

/** The exact init arguments for a product profile (pure, testable). */
export function buildInitArgs(
  profileName: string,
  tunnelId: string,
  mcpCommand: string,
): string[] {
  return [
    "init",
    "--sample",
    "sample_mcp_stdio_local",
    "--profile",
    profileName,
    "--tunnel-id",
    tunnelId,
    "--mcp-command",
    mcpCommand,
  ];
}

export interface DaemonHealth {
  live: boolean;
  ready: boolean;
}

async function probe(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return null;
    return (await response.text()).trim();
  } catch {
    return null;
  }
}

/** Check the local operator surfaces of a running tunnel daemon. */
export async function checkDaemonHealth(port: number = DEFAULT_HEALTH_PORT): Promise<DaemonHealth> {
  const [live, ready] = await Promise.all([
    probe(`http://127.0.0.1:${port}/healthz`),
    probe(`http://127.0.0.1:${port}/readyz`),
  ]);
  return { live: live !== null, ready: ready !== null };
}

export interface RunningDaemon {
  pid: string;
  profile: string | null;
}

/** Find a running `tunnel-client run` daemon and its profile, if any. */
export async function findRunningDaemon(): Promise<RunningDaemon | null> {
  try {
    const { stdout } = await execFileAsync("pgrep", ["-fl", "tunnel-client"], { timeout: 5000 });
    for (const line of stdout.split("\n")) {
      const match = line.match(/^(\d+)\s+(.*)$/);
      if (match === null) continue;
      const commandLine = match[2]!;
      if (!commandLine.includes(" run ")) continue;
      const profile = commandLine.match(/--profile\s+([^\s]+)/)?.[1] ?? null;
      return { pid: match[1]!, profile };
    }
    return null;
  } catch {
    return null;
  }
}

/** Run `tunnel-client doctor --explain` for a profile. */
export async function runDoctor(
  profileName: string,
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(
      TUNNEL_CLIENT_EXECUTABLE,
      ["doctor", "--profile", profileName, "--explain"],
      { timeout: 30_000 },
    );
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "doctor failed";
    return { ok: false, output };
  }
}

/** Run `tunnel-client init` to create a product profile. */
export async function runInit(
  args: readonly string[],
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(TUNNEL_CLIENT_EXECUTABLE, [...args], {
      timeout: 30_000,
    });
    return { ok: true, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() || err.message || "init failed";
    return { ok: false, output };
  }
}

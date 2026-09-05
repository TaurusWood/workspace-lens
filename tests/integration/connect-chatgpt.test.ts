import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runConnectChatGpt } from "../../src/cli/commands/connect-chatgpt.js";
import { CHATGPT_CONNECTOR_SETTINGS_URL } from "../../src/integrations/openai/tunnel.js";
import { CaptureIo, makeTempDir, withEnv } from "../helpers/fixtures.js";

/**
 * Phase 10: the connect chatgpt flow drives only the official tunnel-client
 * (stubbed here) — validating detection, exact init arguments, profile
 * validation, doctor gating, and the no-overclaiming success output.
 */
describe("workspace-lens connect chatgpt", () => {
  let scratch: string;
  let stubDir: string;
  let stubLog: string;
  let profileDir: string;
  let configPath: string;
  let io: CaptureIo;
  let previousPath: string | undefined;

  const stubScript = `#!/bin/sh
echo "$@" >> "$WL_STUB_LOG"
case "$1" in
  help) exit 0 ;;
  init)
    prev=""; mc=""; tid=""
    for a in "$@"; do
      if [ "$prev" = "--mcp-command" ]; then mc="$a"; fi
      if [ "$prev" = "--tunnel-id" ]; then tid="$a"; fi
      prev="$a"
    done
    # Shell builtins only: the test PATH contains no external binaries.
    printf 'tunnel:\\n  tunnel_id: "%s"\\n  commands:\\n      command: "%s"\\n' "$tid" "$mc" \\
      > "$WL_STUB_PROFILE_DIR/workspace-lens.yaml"
    exit 0 ;;
  doctor) [ -n "$WL_STUB_DOCTOR_FAIL" ] && exit 1; exit 0 ;;
esac
exit 0
`;

  function installStubs(options: { withPgrep?: string } = {}): void {
    fs.writeFileSync(path.join(stubDir, "tunnel-client"), stubScript, { mode: 0o755 });
    if (options.withPgrep !== undefined) {
      fs.writeFileSync(
        path.join(stubDir, "pgrep"),
        `#!/bin/sh\necho "${options.withPgrep}"\n`,
        { mode: 0o755 },
      );
    }
    process.env.PATH = stubDir;
  }

  beforeEach(() => {
    scratch = makeTempDir("wl-connect-");
    stubDir = path.join(scratch, "bin");
    fs.mkdirSync(stubDir);
    stubLog = path.join(scratch, "stub.log");
    profileDir = path.join(scratch, "profiles");
    fs.mkdirSync(profileDir, { recursive: true });
    configPath = path.join(scratch, "config.json");
    io = new CaptureIo();
    previousPath = process.env.PATH;
    process.env.WL_STUB_LOG = stubLog;
    process.env.WL_STUB_PROFILE_DIR = profileDir;
    process.env.WORKSPACE_LENS_CONFIG = configPath;
    delete process.env.CONTROL_PLANE_API_KEY;
  });

  afterEach(() => {
    process.env.PATH = previousPath;
    delete process.env.WL_STUB_LOG;
    delete process.env.WL_STUB_PROFILE_DIR;
    delete process.env.WL_STUB_DOCTOR_FAIL;
    delete process.env.WORKSPACE_LENS_CONFIG;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("fails with the official install path when tunnel-client is missing", async () => {
    process.env.PATH = path.join(scratch, "empty-bin");
    fs.mkdirSync(path.join(scratch, "empty-bin"));
    const code = await runConnectChatGpt([], io, { profileDir });
    expect(code).toBe(1);
    expect(io.stderr).toContain("tunnel client is not installed");
    expect(io.stderr).toContain("tunnel-client/releases/latest");
  });

  it("prints the exact init command when no profile exists and no tunnel id is given", async () => {
    installStubs();
    const code = await runConnectChatGpt([], io, { profileDir });
    expect(code).toBe(1);
    expect(io.stderr).toContain("--sample sample_mcp_stdio_local");
    expect(io.stderr).toContain("--profile workspace-lens");
    expect(io.stderr).toContain("--tunnel-id <tunnel-id>");
    expect(io.stderr).toContain("serve");
    expect(io.stderr).toContain("platform.openai.com/settings/organization/tunnels");
    // Nothing beyond the help probe was executed.
    const logged = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8") : "";
    expect(logged).not.toContain("init");
  });

  it("creates the profile via official init with the full serve command", async () => {
    installStubs();
    const code = await runConnectChatGpt(["--tunnel-id", "tunnel_test123"], io, { profileDir });
    expect(code).toBe(0);

    const logged = fs.readFileSync(stubLog, "utf8");
    expect(logged).toContain("init");
    expect(logged).toContain("--sample sample_mcp_stdio_local");
    expect(logged).toContain("--tunnel-id tunnel_test123");
    expect(logged).toMatch(/--mcp-command node \S+dist\/cli\/index\.js serve/);

    expect(io.stdout).toContain('profile "workspace-lens" created');
    expect(io.stdout).toContain("tunnel id: tunnel_test123");
    expect(io.stdout).toContain("tunnel-client doctor passed");
    // No overclaiming: daemon is not running yet, and this is stated.
    expect(io.stdout).toContain("NOT running yet");
    expect(io.stdout).toContain("tunnel-client run --profile workspace-lens");
    expect(io.stdout).toContain(CHATGPT_CONNECTOR_SETTINGS_URL);
    expect(io.stdout).toContain("CONTROL_PLANE_API_KEY is not set");
  });

  it("refuses a profile whose mcp-command differs and prints the force command", async () => {
    installStubs();
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, "workspace-lens.yaml"),
      'tunnel:\n  tunnel_id: "tunnel_old"\n  commands:\n      command: "node /old/gate0.js"\n',
    );
    const code = await runConnectChatGpt([], io, { profileDir });
    expect(code).toBe(1);
    expect(io.stderr).toContain("different MCP command");
    expect(io.stderr).toContain("node /old/gate0.js");
    expect(io.stderr).toContain("--force");
  });

  it("gates success on the official doctor check", async () => {
    installStubs();
    process.env.WL_STUB_DOCTOR_FAIL = "1";
    const code = await runConnectChatGpt(["--tunnel-id", "tunnel_test123"], io, { profileDir });
    expect(code).toBe(1);
    expect(io.stderr).toContain("doctor reported a problem");
  });

  it("completes setup and hands over from a running foreign-profile daemon", async () => {
    installStubs({ withPgrep: "999 /opt/tc/tunnel-client run --profile workspace-lens-gate0" });
    const code = await runConnectChatGpt(["--tunnel-id", "tunnel_x"], io, {
      profileDir,
      healthPort: 1,
    });
    // Setup itself succeeds; the daemon handover is an explicit instruction.
    expect(code).toBe(0);
    expect(io.stdout).toContain('profile "workspace-lens-gate0"');
    expect(io.stdout).toContain("Stop it (Ctrl-C) before starting");
    expect(io.stdout).toContain("Setup complete");
    expect(io.stdout).toContain("NOT running yet");
    expect(io.stdout).toContain("tunnel-client run --profile workspace-lens");
  });

  it("reports a not-ready daemon for this profile without re-running init", async () => {
    installStubs({ withPgrep: "777 /opt/tc/tunnel-client run --profile workspace-lens" });
    // A matching profile must exist for the daemon branch to be reached.
    const serverEntry = path.resolve(import.meta.dirname, "..", "..", "dist", "cli", "index.js");
    fs.writeFileSync(
      path.join(profileDir, "workspace-lens.yaml"),
      `tunnel:\n  tunnel_id: "tunnel_existing"\n  commands:\n      command: "node ${serverEntry} serve"\n`,
    );
    // Port 1 has no local operator surface in tests, so the not-ready branch runs.
    const code = await runConnectChatGpt([], io, { profileDir, healthPort: 1 });
    expect(code).toBe(1);
    expect(io.stderr).toContain("running but not ready");
    const logged = fs.existsSync(stubLog) ? fs.readFileSync(stubLog, "utf8") : "";
    expect(logged).not.toContain("init");
  });

  it("never writes the API key anywhere in output", async () => {
    installStubs();
    await withEnv("CONTROL_PLANE_API_KEY", "sk-super-secret-value", async () => {
      const code = await runConnectChatGpt(["--tunnel-id", "tunnel_test123"], io, { profileDir });
      expect(code).toBe(0);
      expect(io.stdout).not.toContain("sk-super-secret-value");
      expect(io.stderr).not.toContain("sk-super-secret-value");
    });
  });
});

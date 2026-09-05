import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildInitArgs,
  checkDaemonHealth,
  defaultProfileDir,
  detectTunnelClient,
  findRunningDaemon,
  readProfile,
} from "../../src/integrations/openai/tunnel.js";
import { makeTempDir } from "../helpers/fixtures.js";

describe("tunnel integration helpers", () => {
  describe("buildInitArgs", () => {
    it("produces the exact official init arguments", () => {
      expect(
        buildInitArgs("workspace-lens", "tunnel_abc", "node /srv/dist/cli/index.js serve"),
      ).toEqual([
        "init",
        "--sample",
        "sample_mcp_stdio_local",
        "--profile",
        "workspace-lens",
        "--tunnel-id",
        "tunnel_abc",
        "--mcp-command",
        "node /srv/dist/cli/index.js serve",
      ]);
    });
  });

  describe("detectTunnelClient", () => {
    let stubDir: string;
    let previousPath: string | undefined;

    beforeEach(() => {
      stubDir = makeTempDir("wl-stub-");
      previousPath = process.env.PATH;
    });

    afterEach(() => {
      process.env.PATH = previousPath;
      fs.rmSync(stubDir, { recursive: true, force: true });
    });

    function stubClient(script: string): void {
      const stub = path.join(stubDir, "tunnel-client");
      fs.writeFileSync(stub, script, { mode: 0o755 });
      process.env.PATH = stubDir;
    }

    it("detects an installed client (real or stub)", async () => {
      stubClient("#!/bin/sh\nexit 0\n");
      await expect(detectTunnelClient()).resolves.toEqual({ installed: true });
    });

    it("reports not-installed when the binary is missing", async () => {
      process.env.PATH = stubDir;
      await expect(detectTunnelClient()).resolves.toEqual({ installed: false });
    });
  });

  describe("readProfile", () => {
    let profileDir: string;

    beforeEach(() => {
      profileDir = makeTempDir("wl-profiles-");
    });

    afterEach(() => {
      fs.rmSync(profileDir, { recursive: true, force: true });
    });

    it("parses tunnel id and mcp command from a profile file", () => {
      fs.writeFileSync(
        path.join(profileDir, "workspace-lens.yaml"),
        [
          "tunnel:",
          '  tunnel_id: "tunnel_6a9b91b"',
          "  commands:",
          '      command: "node /srv/dist/cli/index.js serve"',
        ].join("\n"),
      );
      const profile = readProfile("workspace-lens", profileDir)!;
      expect(profile.tunnelId).toBe("tunnel_6a9b91b");
      expect(profile.mcpCommand).toBe("node /srv/dist/cli/index.js serve");
      expect(profile.path).toBe(path.join(profileDir, "workspace-lens.yaml"));
    });

    it("returns null for a missing profile", () => {
      expect(readProfile("nope", profileDir)).toBeNull();
    });

    it("keeps a deterministic default profile dir under the home directory", () => {
      expect(defaultProfileDir()).toContain(".config/tunnel-client");
    });
  });

  describe("checkDaemonHealth", () => {
    let server: http.Server;
    let port: number;

    afterEach(async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("reports live and ready for a healthy daemon", async () => {
      server = http.createServer((request, response) => {
        response.end(request.url === "/readyz" ? "ready" : "live");
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      port = (server.address() as { port: number }).port;
      await expect(checkDaemonHealth(port)).resolves.toEqual({ live: true, ready: true });
    });

    it("reports not-healthy when nothing listens", async () => {
      await expect(checkDaemonHealth(1)).resolves.toEqual({ live: false, ready: false });
    });
  });

  describe("findRunningDaemon", () => {
    let stubDir: string;
    let previousPath: string | undefined;

    beforeEach(() => {
      stubDir = makeTempDir("wl-pgrep-");
      previousPath = process.env.PATH;
    });

    afterEach(() => {
      process.env.PATH = previousPath;
      fs.rmSync(stubDir, { recursive: true, force: true });
    });

    it("parses the running daemon's profile from pgrep output", async () => {
      const pgrep = path.join(stubDir, "pgrep");
      fs.writeFileSync(
        pgrep,
        '#!/bin/sh\necho "1234 /opt/tc/tunnel-client run --profile workspace-lens"\n',
        { mode: 0o755 },
      );
      process.env.PATH = stubDir;
      await expect(findRunningDaemon()).resolves.toEqual({
        pid: "1234",
        profile: "workspace-lens",
      });
    });

    it("returns null when pgrep finds nothing", async () => {
      process.env.PATH = stubDir;
      await expect(findRunningDaemon()).resolves.toBeNull();
    });
  });
});

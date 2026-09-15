import { describe, expect, it } from "vitest";
import { runStart } from "../../../src/cli/commands/start.js";
import { createIsolatedProductEnv, isolatedProductOptions } from "../helpers/isolated-env.js";

describe("Start command (Slice 12 focused)", () => {
  it("launches the runtime and invokes browserLauncher with the loopback url", async () => {
    const env = createIsolatedProductEnv("start-cmd-focused");
    let launcherUrl = "";
    let result: any;
    try {
      result = await runStart({
        ...isolatedProductOptions(env),
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        browserLauncher: (url) => {
          launcherUrl = url;
        },
      });

      expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1/);
      expect(result.reused).toBe(false);
      expect(typeof result.pid).toBe("number");
      expect(typeof result.instanceId).toBe("string");
      expect(result.capturedCliInvocations).toEqual(["start"]);
      expect(launcherUrl).toBe(result.url);

      const health = await fetch(`${result.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await result?.runtime?.stop?.().catch(() => {});
      env.cleanup();
    }
  });

  it("treats browserLauncher failure as non-fatal", async () => {
    const env = createIsolatedProductEnv("start-cmd-browser-fail");
    let result: any;
    try {
      result = await runStart({
        ...isolatedProductOptions(env),
        configPath: env.configPath,
        controlStatePath: env.controlStatePath,
        runtimeStatePath: env.runtimeStatePath,
        browserLauncher: () => {
          throw new Error("browser crashed");
        },
      });

      expect(result.url).toMatch(/^http:\/\/127\.0\.0\.1/);
      const health = await fetch(`${result.url}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await result?.runtime?.stop?.().catch(() => {});
      env.cleanup();
    }
  });
});

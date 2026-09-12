import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { WorkspaceRegistry } from "../../../src/core/workspace-registry.js";
import { makeTempRoot } from "../../helpers/fixtures.js";
import { makePlainWorkspace } from "../helpers/mcp.js";

/**
 * REG-004 — existing config remains readable
 * (`docs/v0.3-test-contract.md` §4).
 *
 * A valid v0.2 `config.json` with authorized workspaces must load through
 * the current configuration path with no re-authorization and no destructive
 * migration. The file shape used here is exactly what v0.2 `ConfigStore.save`
 * and `workspace-lens add` produce on disk.
 */
describe("REG-004 existing config remains readable", () => {
  it("loads a v0.2 config.json without re-authorization or migration", () => {
    const workspace = makePlainWorkspace("reg004");
    const configDir = makeTempRoot("wl-v03-reg004-config-");
    const configPath = path.join(configDir, "config.json");
    try {
      // Hand-written v0.2 on-disk shape (as produced by v0.2 `add`).
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            version: 1,
            expose_absolute_paths: false,
            workspaces: [
              {
                workspace_id: "reg004-ws",
                name: "reg004",
                root: workspace.root,
                enabled: true,
              },
            ],
          },
          null,
          2,
        ),
      );

      const store = new ConfigStore(configPath);
      const config = store.load();
      expect(config.version).toBe(1);
      expect(config.workspaces).toHaveLength(1);
      expect(config.workspaces[0]).toMatchObject({
        workspace_id: "reg004-ws",
        root: workspace.root,
        enabled: true,
      });

      // The registry built from the loaded config serves the workspace as
      // authorized and enabled: no re-authorization step exists or runs.
      const registry = new WorkspaceRegistry(config);
      const registered = registry.requireEnabled("reg004-ws");
      expect(registered.root).toBe(workspace.root);
      expect(registry.isAvailable(registered)).toBe(true);
      // The config file was not rewritten by loading.
      const before = fs.statSync(configPath).mtimeMs;
      store.load();
      expect(fs.statSync(configPath).mtimeMs).toBe(before);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
      fs.rmSync(workspace.root, { recursive: true, force: true });
    }
  });
});

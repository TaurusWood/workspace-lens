import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { makeTempRoot } from "../../helpers/fixtures.js";
import { cleanupWorkspace, makeConfig, makePlainWorkspace } from "../helpers/mcp.js";
import { importExpected } from "../helpers/expected-module.js";

/**
 * L1 — Application and Configuration Contracts: APP-001..006
 * (`docs/v0.3-test-contract.md` §5).
 *
 * These contracts bind the shared `WorkspaceAdminService` (Slice 0/1), the
 * interface CLI and WebUI must both call. The service module does not exist
 * yet, so every test is RED through `importExpected`; once the module lands,
 * the full behavioral assertions below run against the real service.
 * Constructor shape follows the implementation plan ("callable directly from
 * tests with injected stores/adapters"): the service receives the injected
 * `ConfigStore`.
 */

interface WorkspaceAdminServiceLike {
  list(): unknown[];
  add(input: { root: string; name?: string; id?: string }): {
    workspace_id: string;
    root: string;
    enabled: boolean;
  };
  rename(workspaceId: string, displayName: string): unknown;
  disable(workspaceId: string): unknown;
  enable(workspaceId: string): unknown;
  remove(workspaceId: string): unknown;
}

async function makeService(configPath: string): Promise<WorkspaceAdminServiceLike> {
  const mod = await importExpected("workspaceAdminService");
  return new mod.WorkspaceAdminService({ configStore: new ConfigStore(configPath) });
}

function newConfigFile(): string {
  const dir = makeTempRoot("wl-v03-app-config-");
  return path.join(dir, "config.json");
}

describe("APP — workspace administration through the shared application service", () => {
  it("APP-001 adds a workspace through the shared application service", async () => {
    const workspace = makePlainWorkspace("app001");
    const configPath = newConfigFile();
    try {
      const service = await makeService(configPath);
      const added = await service.add({ root: workspace.root, name: "app001" });

      expect(service.list()).toHaveLength(1);
      expect(added.workspace_id).toBe("app001");
      // Root is canonicalized on save.
      expect(added.root).toBe(workspace.root);
      // Enabled by default.
      expect(added.enabled).toBe(true);
      // Stable id assignment according to existing rules: the on-disk entry
      // matches what the service returned.
      const persisted = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(persisted.workspaces).toHaveLength(1);
      expect(persisted.workspaces[0]).toMatchObject({ workspace_id: added.workspace_id, root: added.root });
      // No user workspace file was modified by authorization.
      expect(fs.readFileSync(path.join(workspace.root, workspace.sentinelFile), "utf8")).toBe(
        workspace.sentinelContent,
      );
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("APP-002 rejects duplicate, symlink-equivalent, descendant, and ancestor authorization", async () => {
    const workspace = makePlainWorkspace("app002");
    const configPath = newConfigFile();
    try {
      const service = await makeService(configPath);
      await service.add({ root: workspace.root });

      // Duplicate root.
      await expect(service.add({ root: workspace.root })).rejects.toThrow();

      // Symlink-equivalent duplicate points at the same canonical root.
      const link = path.join(path.dirname(workspace.root), `app002-link-${Date.now()}`);
      fs.symlinkSync(workspace.root, link, "dir");
      try {
        await expect(service.add({ root: link })).rejects.toThrow();
      } finally {
        fs.unlinkSync(link);
      }

      // Descendant of an authorized root.
      const child = path.join(workspace.root, "child-dir");
      fs.mkdirSync(child);
      await expect(service.add({ root: child })).rejects.toThrow();

      // Ancestor of an authorized root.
      const parent = path.dirname(workspace.root);
      await expect(service.add({ root: parent })).rejects.toThrow();

      // Existing authorization unchanged after every rejection.
      expect(service.list()).toHaveLength(1);
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("APP-003 renames the display name without changing identity or root", async () => {
    const workspace = makePlainWorkspace("app003");
    const configPath = newConfigFile();
    try {
      const service = await makeService(configPath);
      const added = await service.add({ root: workspace.root, id: "app003-ws" });
      await service.rename(added.workspace_id, "renamed-display");
      const after = service.list().find((ws: any) => ws.workspace_id === added.workspace_id) as any;
      expect(after.workspace_id).toBe(added.workspace_id);
      expect(after.root).toBe(added.root);
      expect(after.name).toBe("renamed-display");
      expect(after.enabled).toBe(added.enabled);
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("APP-004 disables immediately; re-enabling revalidates the existing root", async () => {
    const workspace = makePlainWorkspace("app004");
    const configPath = newConfigFile();
    try {
      const service = await makeService(configPath);
      const added = await service.add({ root: workspace.root, id: "app004-ws" });

      await service.disable(added.workspace_id);
      const disabled = service.list().find((ws: any) => ws.workspace_id === added.workspace_id) as any;
      expect(disabled.enabled).toBe(false);

      // Disabled workspace is unavailable to subsequent MCP content
      // operations: a registry built from the current config must reject it.
      const { WorkspaceRegistry } = await import("../../../src/core/workspace-registry.js");
      const registryOf = () => new WorkspaceRegistry(new ConfigStore(configPath).load());
      expect(() => registryOf().requireEnabled(added.workspace_id)).toThrow(/disabled/i);

      // Re-enabling must REVALIDATE the root, not just flip the flag: with
      // the root gone, enable must fail (or leave the workspace unavailable)
      // — silently enabling a missing root would fail the contract.
      fs.rmSync(workspace.root, { recursive: true, force: true });
      type EnableOutcome = "rejected" | "kept-disabled" | "wrongly-enabled";
      let outcome: EnableOutcome;
      try {
        await service.enable(added.workspace_id);
        const afterBlindEnable = service
          .list()
          .find((ws: any) => ws.workspace_id === added.workspace_id) as any;
        outcome = afterBlindEnable.enabled === false ? "kept-disabled" : "wrongly-enabled";
      } catch {
        outcome = "rejected"; // acceptable variant: enable rejected outright
      }
      expect(outcome).not.toBe("wrongly-enabled");

      // Once the root exists again, enabling succeeds and revalidates.
      fs.mkdirSync(workspace.root, { recursive: true });
      fs.writeFileSync(path.join(workspace.root, workspace.sentinelFile), workspace.sentinelContent);
      await service.enable(added.workspace_id);
      const enabled = service.list().find((ws: any) => ws.workspace_id === added.workspace_id) as any;
      expect(enabled.enabled).toBe(true);
      expect(enabled.root).toBe(workspace.root);
      // The revalidated registry view serves the workspace again.
      expect(registryOf().isAvailable(registryOf().findById(added.workspace_id)!)).toBe(true);
      // No user workspace file was modified by the revalidation.
      expect(
        fs.readFileSync(path.join(workspace.root, workspace.sentinelFile), "utf8"),
      ).toBe(workspace.sentinelContent);
    } finally {
      fs.rmSync(workspace.root, { recursive: true, force: true });
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("APP-005 removes authorization only and leaves local files untouched", async () => {
    const workspace = makePlainWorkspace("app005");
    const configPath = newConfigFile();
    try {
      const service = await makeService(configPath);
      const added = await service.add({ root: workspace.root, id: "app005-ws" });
      await service.remove(added.workspace_id);
      expect(service.list()).toHaveLength(0);
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).workspaces).toHaveLength(0);
      // Underlying directory and files remain untouched.
      expect(fs.readFileSync(path.join(workspace.root, workspace.sentinelFile), "utf8")).toBe(
        workspace.sentinelContent,
      );
    } finally {
      cleanupWorkspace(workspace);
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });

  it("APP-006 fails closed when a registered root disappears; never falls back", async () => {
    const workspace = makePlainWorkspace("app006");
    const configPath = newConfigFile();
    try {
      const service = await makeService(configPath);
      const added = await service.add({ root: workspace.root, id: "app006-ws" });
      // The registered root disappears.
      fs.rmSync(workspace.root, { recursive: true, force: true });

      // The workspace reports unavailable/error through the registry view of
      // the current config...
      const { WorkspaceRegistry } = await import("../../../src/core/workspace-registry.js");
      const registry = new WorkspaceRegistry(new ConfigStore(configPath).load());
      const registered = registry.findById(added.workspace_id);
      expect(registered).toBeDefined();
      expect(registry.isAvailable(registered!)).toBe(false);
      // ...and never falls back to a parent directory or another workspace:
      // the configured root is still the original (now missing) path.
      expect(registered!.root).toBe(workspace.root);
      expect(() => registry.requireAvailable(registered!)).toThrow(/unavailable/i);

      // A sibling workspace in the parent directory stays a distinct
      // authorization; the missing workspace does not inherit it.
      const sibling = makeConfig([{ id: "app006-sibling", root: path.dirname(workspace.root) }]);
      expect(sibling.workspaces[0]!.root).not.toBe(registered!.root);
    } finally {
      fs.rmSync(path.dirname(configPath), { recursive: true, force: true });
    }
  });
});

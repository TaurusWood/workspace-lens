import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigStore } from "../../../src/config/config-store.js";
import { WorkspaceAdminService } from "../../../src/application/workspace-admin-service.js";
import {
  assertNoRealUserState,
  createIsolatedProductEnv,
  type IsolatedProductEnv,
} from "../helpers/isolated-env.js";
import { spawnProductChild, type ProductChild } from "../helpers/spawn-product-child.js";
import { establishSession, apiRequest } from "../helpers/control-api.js";
import { cleanupWorkspace, makePlainWorkspace } from "../helpers/mcp.js";

/**
 * Slice 8 — Workspace + Helper Control API
 * (`docs/v0.3-implementation-plan.md` §11 Tests).
 *
 * The workspace routes were introduced with the security gate (Slice 7);
 * these focused tests pin the full API lifecycle over HTTP (add/list/
 * rename/enable/disable/remove), the intent-level mutation property (a
 * browser session cannot overwrite a concurrent CLI change because no
 * whole-config payload ever travels), immutable identity, and the stateless
 * prompt helpers (HELP-001/002 through the Control API surface).
 */

async function withRuntime(
  tag: string,
  run: (child: ProductChild, env: IsolatedProductEnv) => Promise<void>,
): Promise<void> {
  const env = createIsolatedProductEnv(tag);
  let child: ProductChild | undefined;
  try {
    assertNoRealUserState(env);
    child = await spawnProductChild(env, { entry: "control" });
    await run(child, env);
  } finally {
    await child?.stop();
    env.cleanup();
  }
}

describe("CONTROL API — workspace administration over HTTP", () => {
  it("drives the full workspace lifecycle through the privileged API", async () => {
    const workspace = makePlainWorkspace("api-lifecycle");
    await withRuntime("apilifecycle", async (child, env) => {
      const session = await establishSession(child.url);
      const origin = child.url;

      // Add.
      const added = await apiRequest(
        child.url,
        "/api/v1/workspaces",
        { root: workspace.root, id: "lifecycle-ws", name: "lifecycle" },
        { cookie: session.cookie, csrf: session.csrf, origin },
      );
      expect(added.status).toBe(201);
      const addedBody = (await added.json()) as any;
      expect(addedBody.workspace).toMatchObject({ workspace_id: "lifecycle-ws", enabled: true });

      // List.
      const list = await fetch(`${child.url}/api/v1/workspaces`, { headers: { cookie: session.cookie } });
      const listBody = (await list.json()) as any;
      expect(listBody.workspaces).toHaveLength(1);
      expect(listBody.workspaces[0]).toMatchObject({ workspace_id: "lifecycle-ws", available: true });

      // Rename keeps identity/root/enabled.
      const renamed = await apiRequest(
        child.url,
        "/api/v1/workspaces/lifecycle-ws",
        { name: "renamed" },
        { cookie: session.cookie, csrf: session.csrf, origin },
        "PATCH",
      );
      expect(renamed.status).toBe(200);
      const renamedBody = (await renamed.json()) as any;
      expect(renamedBody.workspace).toMatchObject({ workspace_id: "lifecycle-ws", name: "renamed", enabled: true });

      // Disable then re-enable.
      const disabled = await apiRequest(
        child.url,
        "/api/v1/workspaces/lifecycle-ws",
        { enabled: false },
        { cookie: session.cookie, csrf: session.csrf, origin },
        "PATCH",
      );
      expect((await disabled.json()) as any).toMatchObject({ workspace: { enabled: false } });
      const enabled = await apiRequest(
        child.url,
        "/api/v1/workspaces/lifecycle-ws",
        { enabled: true },
        { cookie: session.cookie, csrf: session.csrf, origin },
        "PATCH",
      );
      expect((await enabled.json()) as any).toMatchObject({ workspace: { enabled: true } });

      // Remove (authorization only; local files untouched).
      const removed = await apiRequest(
        child.url,
        "/api/v1/workspaces/lifecycle-ws",
        {},
        { cookie: session.cookie, csrf: session.csrf, origin },
        "DELETE",
      );
      expect(removed.status).toBe(200);
      const after = await fetch(`${child.url}/api/v1/workspaces`, { headers: { cookie: session.cookie } });
      expect(((await after.json()) as any).workspaces).toHaveLength(0);
      expect(fs.existsSync(path.join(workspace.root, workspace.sentinelFile))).toBe(true);
    });
    cleanupWorkspace(workspace);
  });

  it("keeps a concurrent CLI mutation intact across an API rename (no whole-config overwrite)", async () => {
    const workspaceA = makePlainWorkspace("api-stale-a");
    const workspaceB = makePlainWorkspace("api-stale-b");
    await withRuntime("apistale", async (child, env) => {
      const session = await establishSession(child.url);
      const origin = child.url;
      const api = new WorkspaceAdminService({ configStore: new ConfigStore(env.configPath) });
      await api.add({ root: workspaceA.root, id: "stale-a", name: "a" });

      // The browser session opens the workspaces page (reads state)...
      await fetch(`${child.url}/api/v1/workspaces`, { headers: { cookie: session.cookie } });
      // ...while a CLI-shaped mutation lands...
      await api.add({ root: workspaceB.root, id: "stale-b", name: "b" });
      // ...and the browser then renames A with an INTENT payload (no config
      // document travels, so B cannot be lost).
      const renamed = await apiRequest(
        child.url,
        "/api/v1/workspaces/stale-a",
        { name: "a-renamed" },
        { cookie: session.cookie, csrf: session.csrf, origin },
        "PATCH",
      );
      expect(renamed.status).toBe(200);

      const config = new ConfigStore(env.configPath).load();
      const ids = config.workspaces.map((ws) => ws.workspace_id);
      expect(ids).toEqual(expect.arrayContaining(["stale-a", "stale-b"]));
      const entry = config.workspaces.find((ws) => ws.workspace_id === "stale-a");
      expect(entry?.name).toBe("a-renamed");
    });
    cleanupWorkspace(workspaceA);
    cleanupWorkspace(workspaceB);
  });

  it("keeps workspace identity and root immutable through every API mutation", async () => {
    const workspace = makePlainWorkspace("api-immutable");
    await withRuntime("apiimmutable", async (child, env) => {
      const session = await establishSession(child.url);
      const origin = child.url;
      const admin = new WorkspaceAdminService({ configStore: new ConfigStore(env.configPath) });
      const added = await admin.add({ root: workspace.root, id: "immutable-ws", name: "original" });

      await apiRequest(child.url, "/api/v1/workspaces/immutable-ws", { name: "renamed" }, { cookie: session.cookie, csrf: session.csrf, origin }, "PATCH");
      await apiRequest(child.url, "/api/v1/workspaces/immutable-ws", { enabled: false }, { cookie: session.cookie, csrf: session.csrf, origin }, "PATCH");
      await apiRequest(child.url, "/api/v1/workspaces/immutable-ws", { enabled: true }, { cookie: session.cookie, csrf: session.csrf, origin }, "PATCH");

      const persisted = new ConfigStore(env.configPath).load().workspaces[0]!;
      expect(persisted.workspace_id).toBe(added.workspace_id);
      expect(persisted.root).toBe(added.root);
      expect(persisted.root).toBe(workspace.root);
    });
    cleanupWorkspace(workspace);
  });
});

describe("CONTROL API — prompt helpers", () => {
  it("generates the three helpers against the explicit workspace_id", async () => {
    const workspace = makePlainWorkspace("api-helpers");
    await withRuntime("apihelpers", async (child, env) => {
      const session = await establishSession(child.url);
      const origin = child.url;
      const admin = new WorkspaceAdminService({ configStore: new ConfigStore(env.configPath) });
      await admin.add({ root: workspace.root, id: "helpers-ws", name: "helpers" });

      for (const route of ["project-instructions", "review-prompt", "plan-prompt"]) {
        const response = await apiRequest(
          child.url,
          `/api/v1/helpers/${route}`,
          { workspace_id: "helpers-ws" },
          { cookie: session.cookie, csrf: session.csrf, origin },
        );
        expect(response.status).toBe(200);
        const body = (await response.json()) as any;
        // HELP-001: the helper explicitly targets the workspace id and forbids
        // guessing another one.
        expect(body.prompt).toContain("helpers-ws");
        expect(body.prompt).toMatch(/do not guess|not guess/i);
        // No volatile repository state, contents, or host paths in helpers.
        expect(body.prompt).not.toContain(workspace.sentinelContent);
        expect(body.prompt).not.toContain(workspace.root);
      }
    });
    cleanupWorkspace(workspace);
  });

  it("rejects unknown workspaces and malformed DTOs for helpers", async () => {
    await withRuntime("apihelpers-bad", async (child) => {
      const session = await establishSession(child.url);
      const origin = child.url;
      const unknown = await apiRequest(
        child.url,
        "/api/v1/helpers/project-instructions",
        { workspace_id: "ghost-ws" },
        { cookie: session.cookie, csrf: session.csrf, origin },
      );
      expect(unknown.status).toBe(404);

      const malformed = await apiRequest(
        child.url,
        "/api/v1/helpers/project-instructions",
        { workspace_id: "bad id" },
        { cookie: session.cookie, csrf: session.csrf, origin },
      );
      expect(malformed.status).toBe(400);
    });
  });
});

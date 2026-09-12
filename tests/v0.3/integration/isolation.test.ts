import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  callTool,
  cleanupWorkspace,
  connectClient,
  makeConfig,
  makeGitWorkspace,
  makePlainWorkspace,
  type GitWorkspaceFixture,
} from "../helpers/mcp.js";

/**
 * Live Configuration and Workspace Isolation: ISO-001..003
 * (`docs/v0.3-test-contract.md` §6).
 *
 * These contracts are already supported by the v0.2 Core (per-request
 * workspace resolution by explicit id; the registry has no global "current
 * workspace") and therefore run GREEN. They must stay green as v0.3 makes
 * authorization live — §15 assigns them to Slice 2 alongside LIVE-*.
 */

describe("ISO — concurrent workspace isolation", () => {
  it("ISO-001 keeps concurrent filesystem reads for A and B isolated by sentinel content", async () => {
    const workspaceA = makePlainWorkspace("iso001a");
    const workspaceB = makePlainWorkspace("iso001b");
    try {
      const { client } = await connectClient(
        makeConfig([
          { id: "iso001-a", root: workspaceA.root },
          { id: "iso001-b", root: workspaceB.root },
        ]),
      );

      // Issue concurrent read/list/search requests to both workspaces.
      const [readA, readB, listA, listB, searchA, searchB] = await Promise.all([
        callTool(client, "read_file", { workspace_id: "iso001-a", path: workspaceA.sentinelFile }),
        callTool(client, "read_file", { workspace_id: "iso001-b", path: workspaceB.sentinelFile }),
        callTool(client, "list_files", { workspace_id: "iso001-a" }),
        callTool(client, "list_files", { workspace_id: "iso001-b" }),
        callTool(client, "search_workspace", { workspace_id: "iso001-a", query: "SENTINEL-CONTENT" }),
        callTool(client, "search_workspace", { workspace_id: "iso001-b", query: "SENTINEL-CONTENT" }),
      ]);

      const payloadA = JSON.stringify([readA, listA, searchA]);
      const payloadB = JSON.stringify([readB, listB, searchB]);
      // Every A response contains A-only content and no B-only content, and
      // vice versa.
      expect(readA.isError).toBeFalsy();
      expect(readB.isError).toBeFalsy();
      expect(payloadA).toContain(workspaceA.sentinelContent);
      expect(payloadA).not.toContain(workspaceB.sentinelContent);
      expect(payloadB).toContain(workspaceB.sentinelContent);
      expect(payloadB).not.toContain(workspaceA.sentinelContent);
      await client.close();
    } finally {
      cleanupWorkspace(workspaceA);
      cleanupWorkspace(workspaceB);
    }
  });

  it("ISO-002 keeps concurrent Git operations isolated per repository", async () => {
    const repoA: GitWorkspaceFixture = makeGitWorkspace("iso002a");
    const repoB: GitWorkspaceFixture = makeGitWorkspace("iso002b");
    try {
      // Distinct branches and commits per repository.
      const { git } = await import("../../helpers/git.js");
      git(repoA.root, "checkout", "-q", "-b", repoA.branch);
      git(repoB.root, "checkout", "-q", "-b", repoB.branch);

      const { client } = await connectClient(
        makeConfig([
          { id: "iso002-a", root: repoA.root },
          { id: "iso002-b", root: repoB.root },
        ]),
      );
      const [statusA, statusB, historyA, historyB] = await Promise.all([
        callTool(client, "git_status", { workspace_id: "iso002-a" }),
        callTool(client, "git_status", { workspace_id: "iso002-b" }),
        callTool(client, "git_history", { workspace_id: "iso002-a" }),
        callTool(client, "git_history", { workspace_id: "iso002-b" }),
      ]);

      expect(statusA.isError).toBeFalsy();
      expect(statusB.isError).toBeFalsy();
      const branchA = (statusA.structuredContent as any).data.branch;
      const branchB = (statusB.structuredContent as any).data.branch;
      expect(branchA.name).toBe(repoA.branch);
      expect(branchB.name).toBe(repoB.branch);
      // Each result reflects only its requested repository.
      expect(JSON.stringify(historyA)).not.toContain(repoB.commitMessage);
      expect(JSON.stringify(historyB)).not.toContain(repoA.commitMessage);
      await client.close();
    } finally {
      cleanupWorkspace(repoA);
      cleanupWorkspace(repoB);
    }
  });

  it("ISO-003 never redirects a failing workspace to a valid sibling under concurrency", async () => {
    const workspaceA = makePlainWorkspace("iso003a");
    const workspaceB = makePlainWorkspace("iso003b");
    try {
      const { client } = await connectClient(
        makeConfig([
          { id: "iso003-a", root: workspaceA.root },
          { id: "iso003-b", root: workspaceB.root },
        ]),
      );
      // Make A invalid while B remains valid; request both concurrently.
      fs.rmSync(workspaceA.root, { recursive: true, force: true });
      const [resultA, resultB] = await Promise.all([
        callTool(client, "read_file", { workspace_id: "iso003-a", path: workspaceA.sentinelFile }),
        callTool(client, "read_file", { workspace_id: "iso003-b", path: workspaceB.sentinelFile }),
      ]);
      expect(resultA.isError).toBe(true);
      expect(JSON.stringify(resultA)).toContain("WORKSPACE_UNAVAILABLE");
      expect(resultB.isError).toBeFalsy();
      expect(JSON.stringify(resultB)).toContain(workspaceB.sentinelContent);
      // A never fell through to B's content or any other workspace.
      expect(JSON.stringify(resultA)).not.toContain(workspaceB.sentinelContent);
      expect(JSON.stringify(resultA)).not.toContain("iso003-b");
      await client.close();
    } finally {
      cleanupWorkspace(workspaceB);
      // workspaceA.root was already removed as part of the scenario itself.
    }
  });
});

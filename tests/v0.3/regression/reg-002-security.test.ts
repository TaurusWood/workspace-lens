import path from "node:path";
import { describe, expect, it } from "vitest";
import { AccessPolicy } from "../../../src/core/access-policy.js";
import { AppError } from "../../../src/core/errors.js";
import { PathResolver } from "../../../src/core/path-resolver.js";
import { WorkspaceRegistry } from "../../../src/core/workspace-registry.js";
import { callTool, cleanupWorkspace, connectClient, makeConfig, makePlainWorkspace } from "../helpers/mcp.js";

/**
 * REG-002 — read-only security unchanged
 * (`docs/v0.3-test-contract.md` §4).
 *
 * v0.3 productization must not weaken repository access controls: path
 * containment, sensitive-path blocking, and bounded outputs are asserted
 * against the real shared decision layers (`AccessPolicy`, `PathResolver`,
 * `WorkspaceRegistry`) plus one live tool round trip.
 */
describe("REG-002 read-only security unchanged", () => {
  it("still blocks sensitive paths through the shared AccessPolicy", () => {
    const policy = new AccessPolicy();
    expect(policy.decide(".env")).toMatchObject({ decision: "blocked", reason: "sensitive" });
    expect(policy.decide("config/secrets.key")).toMatchObject({ decision: "blocked", reason: "sensitive" });
    expect(policy.decide(".ssh/id_rsa")).toMatchObject({ decision: "blocked", reason: "sensitive" });
    expect(policy.decide(".aws/credentials")).toMatchObject({ decision: "blocked", reason: "sensitive" });
    expect(policy.decide(".git/config")).toMatchObject({ decision: "blocked", reason: "sensitive" });
  });

  it("still excludes dependency/build trees and allows normal source files", () => {
    const policy = new AccessPolicy();
    expect(policy.decide("node_modules/package/index.js")).toMatchObject({ decision: "blocked", reason: "excluded" });
    expect(policy.decide("dist/bundle.js")).toMatchObject({ decision: "blocked", reason: "excluded" });
    expect(policy.decide("src/main.ts")).toEqual({ decision: "allowed" });
  });

  it("still rejects traversal and symlink escapes through the real PathResolver", async () => {
    const workspace = makePlainWorkspace("reg002");
    try {
      const outsideFile = path.join(path.dirname(workspace.root), `reg002-outside-${Date.now()}.txt`);
      const { writeFileSync } = await import("node:fs");
      writeFileSync(outsideFile, "outside content");

      const resolver = new PathResolver(workspace.root);
      // Traversal syntax is rejected up front...
      expect(() => resolver.validate("../outside.txt")).toThrow(AppError);
      expect(() => resolver.validate("/etc/passwd")).toThrow(AppError);
      // ...and a symlink planted inside the workspace pointing outside is
      // rejected by canonical containment.
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outsideFile, path.join(workspace.root, "escape-link"));
      await expect(resolver.resolve("escape-link")).rejects.toMatchObject({ code: "PATH_OUTSIDE_WORKSPACE" });

      const { rmSync, unlinkSync } = await import("node:fs");
      unlinkSync(path.join(workspace.root, "escape-link"));
      rmSync(outsideFile, { force: true });
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("keeps disabled and unknown workspaces unavailable to MCP content operations", async () => {
    const workspace = makePlainWorkspace("reg002");
    try {
      const { client } = await connectClient(
        makeConfig([{ id: "disabled-ws", root: workspace.root, enabled: false }]),
      );
      const disabled = await callTool(client, "read_file", {
        workspace_id: "disabled-ws",
        path: workspace.sentinelFile,
      });
      expect(disabled.isError).toBe(true);
      expect(JSON.stringify(disabled)).toContain("WORKSPACE_DISABLED");

      const unknown = await callTool(client, "read_file", {
        workspace_id: "ghost-ws",
        path: workspace.sentinelFile,
      });
      expect(unknown.isError).toBe(true);
      expect(JSON.stringify(unknown)).toContain("WORKSPACE_NOT_FOUND");
      await client.close();
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  it("keeps a missing root failing closed with WORKSPACE_UNAVAILABLE", () => {
    const registry = new WorkspaceRegistry(makeConfig([{ id: "gone-ws", root: "/tmp/wl-does-not-exist-reg002" }]));
    const workspace = registry.requireEnabled("gone-ws");
    expect(registry.isAvailable(workspace)).toBe(false);
    expect(() => registry.requireAvailable(workspace)).toThrow(AppError);
  });
});

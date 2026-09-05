import { z } from "zod";
import { isGitRepository } from "../../adapters/git.js";
import { successEnvelope } from "../../core/errors.js";
import type { ToolDefinition } from "../tool-runner.js";
import { workspaceListSchema } from "../schemas.js";

/**
 * `workspace_list` (`mcp-tools-spec.md` §6): registry only, no filesystem
 * scanning, no caller-controlled registration. Roots are never exposed.
 */
export const workspaceListTool: ToolDefinition<typeof workspaceListSchema> = {
  name: "workspace_list",
  description: "List locally authorized workspaces available for read-only inspection.",
  inputSchema: workspaceListSchema,
  run: async (_args, context) => {
    const workspaces: Array<{
      workspace_id: string;
      name: string;
      available: boolean;
      git: boolean;
    }> = [];
    for (const workspace of context.registry.listEnabled()) {
      const available = context.registry.isAvailable(workspace);
      workspaces.push({
        workspace_id: workspace.workspace_id,
        name: workspace.name,
        available,
        git: available ? await isGitRepository(workspace.root) : false,
      });
    }
    return successEnvelope({ workspaces });
  },
};

export type WorkspaceListArgs = z.output<typeof workspaceListSchema>;

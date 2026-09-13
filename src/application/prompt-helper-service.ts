/**
 * Prompt helper application service
 * (`docs/v0.3-implementation-plan.md` §11, `docs/v0.3-test-contract.md` §12).
 *
 * Generates the three optional copy helpers (Project Instructions / Review
 * Prompt / Plan Prompt) from stable workspace identity. Stateless by
 * contract (HELP-002): no saved prompt library, no workflow/session/task
 * records, no mutable service state.
 *
 * Content contract (HELP-001): the generated text explicitly targets the
 * selected `workspace_id` and instructs the reasoning client not to guess
 * another workspace when the target is unavailable or ambiguous. Helpers
 * contain no volatile repository state, file contents, or secrets.
 */
import { ConfigError, WORKSPACE_ID_MAX_LENGTH, WORKSPACE_ID_PATTERN } from "../config/config-schema.js";
import type { PromptHelperInput } from "./contracts.js";

export class PromptHelperService {
  projectInstructions(input: PromptHelperInput): string {
    const workspaceId = requireWorkspaceId(input);
    return [
      `Project Instructions — workspace \`${workspaceId}\``,
      "",
      `Use the WorkspaceLens MCP server with workspace_id \`${workspaceId}\` for every request in this project.`,
      `Resolve files, Git history, and search ONLY inside this workspace.`,
      `If the workspace \`${workspaceId}\` is unavailable, disabled, or the identifier is ambiguous, stop and ask which workspace to use — do not guess another workspace.`,
    ].join("\n");
  }

  reviewPrompt(input: PromptHelperInput): string {
    const workspaceId = requireWorkspaceId(input);
    return [
      `Review the current changes in workspace \`${workspaceId}\`.`,
      `Use git_status, git_diff, and git_history with workspace_id \`${workspaceId}\`; do not guess another workspace.`,
      `Summarize the intent of the change, list concrete risks, and point out missing tests. Stay factual — report only what the repository shows.`,
    ].join("\n");
  }

  planPrompt(input: PromptHelperInput): string {
    const workspaceId = requireWorkspaceId(input);
    return [
      `Plan the implementation for the request against workspace \`${workspaceId}\`.`,
      `Inspect the relevant files and history with workspace_id \`${workspaceId}\` before proposing steps; do not guess another workspace.`,
      `Produce a short ordered plan with verifiable steps and call out anything that needs a decision.`,
    ].join("\n");
  }
}

function requireWorkspaceId(input: PromptHelperInput): string {
  const workspaceId = input.workspaceId;
  if (
    typeof workspaceId !== "string" ||
    workspaceId.length === 0 ||
    workspaceId.length > WORKSPACE_ID_MAX_LENGTH ||
    !WORKSPACE_ID_PATTERN.test(workspaceId)
  ) {
    throw new ConfigError("A valid workspace_id is required to generate a helper.");
  }
  return workspaceId;
}

/**
 * Public MCP input schemas (`mcp-tools-spec.md` §6-§12).
 *
 * Every schema is a strict object: unknown properties are rejected before a
 * tool handler runs. No schema accepts roots, commands, shells, or raw
 * search/Git arguments (`mcp-tools-spec.md` §5.3).
 */
import { z } from "zod";
import { DEFAULT_LIMITS } from "../core/limits.js";

export const workspaceIdSchema = z.string().min(1).max(64);

export const workspaceListSchema = z.strictObject({});

export const workspaceInfoSchema = z.strictObject({
  workspace_id: workspaceIdSchema,
});

export const listFilesSchema = z.strictObject({
  workspace_id: workspaceIdSchema,
  path: z.string().min(1).max(4096).optional(),
  depth: z.number().int().min(1).max(DEFAULT_LIMITS.maxListDepth).optional(),
});

export const readFileSchema = z.strictObject({
  workspace_id: workspaceIdSchema,
  path: z.string().min(1).max(4096),
  start_line: z.number().int().min(1).optional(),
  end_line: z.number().int().min(1).optional(),
});

export const searchWorkspaceSchema = z.strictObject({
  workspace_id: workspaceIdSchema,
  query: z.string().min(1).max(DEFAULT_LIMITS.maxQueryLength),
  path: z.string().min(1).max(4096).optional(),
  file_pattern: z.string().min(1).max(100).optional(),
  case_sensitive: z.boolean().optional(),
  max_results: z.number().int().min(1).max(DEFAULT_LIMITS.maxSearchResults).optional(),
});

export const gitStatusSchema = z.strictObject({
  workspace_id: workspaceIdSchema,
});

export const gitDiffSchema = z.strictObject({
  workspace_id: workspaceIdSchema,
  scope: z.enum(["unstaged", "staged", "all"]).optional(),
  path: z.string().min(1).max(4096).optional(),
});

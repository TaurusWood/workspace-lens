/**
 * Central server-enforced output limits (`mcp-tools-spec.md` §14 and
 * `security-model.md` §10).
 *
 * These are the recommended MVP defaults. Tool callers can only lower the
 * caller-selectable ceilings; they can never raise or disable the hard
 * server ceilings defined here.
 */
export interface ServerLimits {
  /** Files larger than this are not eligible for reading or search. */
  maxEligibleFileBytes: number;
  /** Hard byte ceiling for the `read_file` returned payload. */
  maxReadPayloadBytes: number;
  /** Hard ceiling for `list_files` entries. */
  maxListEntries: number;
  /** Hard maximum for the `list_files.depth` argument. */
  maxListDepth: number;
  /** Hard ceiling for `search_workspace` matches. */
  maxSearchResults: number;
  /** Default caller-facing search result count. */
  defaultSearchResults: number;
  /** Hard byte ceiling for the combined `git_diff` payload. */
  maxDiffPayloadBytes: number;
  /** Bounded length of a search preview line. */
  maxSearchPreviewChars: number;
  /** Maximum search query length. */
  maxQueryLength: number;
  /** Maximum number of files a single search may scan (runaway guard). */
  maxSearchFileScan: number;
  /** Bytes probed from a file head when classifying it as binary. */
  binaryProbeBytes: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxEligibleFileBytes: 1024 * 1024, // 1 MiB
  maxReadPayloadBytes: 128 * 1024, // 128 KiB
  maxListEntries: 2000,
  maxListDepth: 5,
  maxSearchResults: 100,
  defaultSearchResults: 50,
  maxDiffPayloadBytes: 256 * 1024, // 256 KiB
  maxSearchPreviewChars: 200,
  maxQueryLength: 500,
  maxSearchFileScan: 20000,
  binaryProbeBytes: 8192,
};

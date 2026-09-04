# WorkspaceLens MCP Tools Specification

Status: Draft contract for MVP (`v0.1`).

This document defines the public MCP tool contract exposed by WorkspaceLens. It specifies tool names, inputs, outputs, error semantics, and cross-tool behavior.

The contract intentionally does **not** bind WorkspaceLens to a particular MCP transport, connector, handshake, or model provider. MCP protocol integration may evolve independently as long as these WorkspaceLens tool semantics remain intact.

When this document uses **MUST**, **MUST NOT**, **SHOULD**, and **MAY**, those terms describe implementation requirements.

## 1. Design Principles

The MVP tool surface is intentionally small:

```text
workspace_list
workspace_info
list_files
read_file
search_workspace
git_status
git_diff
```

The tools expose semantic read operations, not low-level system primitives.

WorkspaceLens MUST NOT expose tools such as:

```text
shell
exec
run_command
git
git_command
filesystem
write_file
apply_patch
```

The model selects *what it wants to inspect*. WorkspaceLens controls *how that inspection is performed safely*.

## 2. MCP Compatibility

Each WorkspaceLens tool MUST be advertised through MCP with a machine-readable input schema.

Where the MCP SDK/host supports structured tool results, WorkspaceLens SHOULD return structured content matching this specification. A human/model-readable text representation MAY also be included as a fallback.

Application errors SHOULD be represented as tool errors (`isError: true` or the equivalent mechanism supported by the active MCP SDK) and SHOULD include the stable WorkspaceLens error object defined below.

Malformed input rejected by the MCP SDK before the tool handler executes may use the SDK's native schema-validation error format.

WorkspaceLens SHOULD use the current stable official MCP SDK rather than implementing protocol framing manually unless a concrete compatibility requirement justifies doing otherwise.

## 3. Common Types

### 3.1 `workspace_id`

A `workspace_id` identifies one locally authorized workspace.

Contract:

```text
Type: string
Length: 1..64
Recommended pattern: ^[A-Za-z0-9._-]+$
```

A tool caller cannot create or change a workspace by choosing a new ID. Unknown IDs fail with `WORKSPACE_NOT_FOUND`.

### 3.2 Workspace-relative path

All public `path` fields use a platform-neutral, workspace-relative path syntax.

Rules:

- `/` is the API path separator on all operating systems;
- `.` represents the workspace root where a directory path is accepted;
- paths MUST NOT begin with `/`;
- paths MUST NOT contain `..` segments;
- paths MUST NOT contain NUL characters;
- Windows drive-qualified and UNC paths are invalid;
- backslashes SHOULD be rejected rather than interpreted as path separators;
- the server MUST still perform canonical containment checks after parsing.

Examples:

```text
Valid:
.
src
src/index.ts
packages/api/src/server.ts

Invalid:
/Users/me/project/src/index.ts
../secret
src/../../secret
C:\Users\me\secret
\\server\share\file
```

### 3.3 Result envelope

Successful structured results SHOULD use:

```json
{
  "ok": true,
  "data": {}
}
```

Application-level failures SHOULD use:

```json
{
  "ok": false,
  "error": {
    "code": "PATH_BLOCKED",
    "message": "The requested path is blocked by the workspace access policy.",
    "retryable": false
  }
}
```

The `message` is explanatory and is not a stable API field for programmatic matching. `code` is stable within the same major WorkspaceLens tool-contract version.

### 3.4 Truncation

Any successful operation that may return partial data MUST include:

```json
{
  "truncated": false
}
```

If output is shortened because of server limits, `truncated` MUST be `true`.

The server MUST NOT silently truncate content.

## 4. Common Error Codes

| Code | Meaning | Retryable |
| --- | --- | --- |
| `INVALID_ARGUMENT` | Input passed schema validation but violates a semantic constraint | No |
| `WORKSPACE_NOT_FOUND` | `workspace_id` is not configured | No |
| `WORKSPACE_DISABLED` | Workspace exists but is disabled | No |
| `WORKSPACE_UNAVAILABLE` | Configured root is missing or inaccessible | Maybe |
| `PATH_INVALID` | Path syntax is invalid | No |
| `PATH_OUTSIDE_WORKSPACE` | Canonical resolution escapes the authorized root | No |
| `PATH_BLOCKED` | AccessPolicy denies the path | No |
| `PATH_NOT_FOUND` | Requested path does not exist | Maybe |
| `NOT_A_FILE` | Operation requires a regular file | No |
| `NOT_A_DIRECTORY` | Operation requires a directory | No |
| `BINARY_FILE_NOT_SUPPORTED` | File is classified as binary | No |
| `UNSUPPORTED_FILE_TYPE` | Filesystem object is not an allowed text file type | No |
| `FILE_TOO_LARGE` | File exceeds the server's hard eligibility limit | No |
| `NOT_A_GIT_REPOSITORY` | Git operation requested for a non-Git workspace | No |
| `GIT_OPERATION_FAILED` | Controlled Git inspection failed | Maybe |
| `SEARCH_FAILED` | Controlled search operation failed | Maybe |
| `INTERNAL_ERROR` | Unexpected internal failure | Maybe |

Internal stack traces, absolute unrelated host paths, environment variables, and raw command lines MUST NOT be returned in MCP error messages.

## 5. Cross-Tool Contract

These rules apply to every MVP tool.

### 5.1 Authorization order

Before reading workspace data, the implementation MUST conceptually perform:

```text
validate input
    |
resolve workspace_id
    |
verify workspace enabled/available
    |
resolve relative path (if any)
    |
canonical containment check
    |
AccessPolicy decision
    |
execute read-only adapter operation
    |
apply output limits
    |
return structured result
```

### 5.2 Shared AccessPolicy

`list_files`, `read_file`, `search_workspace`, and `git_diff` MUST share the same sensitive-path policy.

A blocked file cannot become readable through another tool.

### 5.3 No absolute root control

No tool in this specification accepts:

```text
root
cwd
working_directory
absolute_path
command
args
shell
```

as caller-controlled execution primitives.

### 5.4 Untrusted data

Tool descriptions SHOULD state that workspace contents are untrusted data and may contain prompt-injection-like text.

WorkspaceLens returns data; it does not interpret repository text as instructions.

---

# 6. Tool: `workspace_list`

## Purpose

Return the workspaces that the local user has explicitly authorized and enabled for WorkspaceLens.

This tool does not scan the filesystem for repositories and does not allow the caller to register a workspace.

## Input

```json
{}
```

Input schema MUST reject unknown properties.

## Success output

```json
{
  "ok": true,
  "data": {
    "workspaces": [
      {
        "workspace_id": "workspace-lens",
        "name": "WorkspaceLens",
        "available": true,
        "git": true
      }
    ]
  }
}
```

Fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `workspace_id` | string | Stable local identifier used by all other tools |
| `name` | string | Human-readable display name |
| `available` | boolean | Whether the configured root is currently accessible |
| `git` | boolean | Whether a Git working tree/repository was detected locally |

Workspace roots SHOULD NOT be exposed by default. See `workspace_info` for the optional path disclosure behavior.

## Errors

`workspace_list` should normally succeed even when an individual configured root is unavailable; the affected entry returns `available: false`.

Unexpected failure: `INTERNAL_ERROR`.

## Side effects

None.

---

# 7. Tool: `workspace_info`

## Purpose

Return read-only metadata about one authorized workspace, including Git state and best-effort project/technology detection.

## Input

```json
{
  "workspace_id": "workspace-lens"
}
```

Schema:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "workspace_id": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
    }
  },
  "required": ["workspace_id"]
}
```

## Success output

```json
{
  "ok": true,
  "data": {
    "workspace_id": "workspace-lens",
    "name": "WorkspaceLens",
    "root_path": null,
    "git": {
      "detected": true,
      "branch": "main",
      "detached": false,
      "head": "832de4f"
    },
    "project": {
      "inferred": true,
      "types": [
        {
          "name": "node",
          "confidence": "high",
          "evidence": ["package.json"]
        }
      ],
      "technologies": [
        {
          "name": "TypeScript",
          "category": "language",
          "confidence": "high",
          "evidence": ["tsconfig.json"]
        }
      ]
    }
  }
}
```

### Path disclosure

`root_path` MUST be `null` or omitted by default.

An implementation MAY return the canonical absolute root path only when the local user has explicitly enabled a setting equivalent to `expose_absolute_paths`.

The model never needs the absolute root path in order to call other WorkspaceLens tools.

### Project detection semantics

Project type and technology stack detection are best-effort inference, not authoritative facts.

Detection output MUST make this distinction explicit using `inferred: true` and SHOULD provide evidence paths when practical.

`confidence` values, if present, MUST be one of:

```text
low | medium | high
```

Project detection MUST respect AccessPolicy and MUST NOT inspect blocked sensitive files merely to improve detection.

## Errors

- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_DISABLED`
- `WORKSPACE_UNAVAILABLE`
- `INTERNAL_ERROR`

## Side effects

None.

---

# 8. Tool: `list_files`

## Purpose

List a bounded directory tree inside one authorized workspace.

## Input

```json
{
  "workspace_id": "workspace-lens",
  "path": "src",
  "depth": 2
}
```

Fields:

| Field | Required | Type | Default | Contract |
| --- | --- | --- | --- | --- |
| `workspace_id` | Yes | string | — | Authorized workspace ID |
| `path` | No | string | `.` | Workspace-relative directory path |
| `depth` | No | integer | `2` | Recursive depth, `1..5` |

Unknown properties MUST be rejected.

## Success output

```json
{
  "ok": true,
  "data": {
    "workspace_id": "workspace-lens",
    "path": "src",
    "entries": [
      {
        "path": "src/index.ts",
        "kind": "file",
        "size_bytes": 4210
      },
      {
        "path": "src/security",
        "kind": "directory"
      }
    ],
    "truncated": false
  }
}
```

`kind` MUST be one of:

```text
file | directory | symlink
```

The tool MUST NOT expose symlink targets as absolute host paths.

Blocked sensitive entries SHOULD be omitted from the listing.

Ordering SHOULD be deterministic: directories first, then files, each lexicographically by workspace-relative path.

The server MUST enforce a hard maximum entry count.

## Errors

- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_DISABLED`
- `WORKSPACE_UNAVAILABLE`
- `PATH_INVALID`
- `PATH_OUTSIDE_WORKSPACE`
- `PATH_BLOCKED`
- `PATH_NOT_FOUND`
- `NOT_A_DIRECTORY`
- `INTERNAL_ERROR`

## Side effects

None.

---

# 9. Tool: `read_file`

## Purpose

Read UTF-8/text content from one allowed regular file in an authorized workspace.

The operation is line-oriented so large source files can be inspected incrementally without increasing the per-call output ceiling.

## Input

```json
{
  "workspace_id": "workspace-lens",
  "path": "src/server.ts",
  "start_line": 1,
  "end_line": 200
}
```

Fields:

| Field | Required | Type | Default | Contract |
| --- | --- | --- | --- | --- |
| `workspace_id` | Yes | string | — | Authorized workspace ID |
| `path` | Yes | string | — | Workspace-relative file path |
| `start_line` | No | integer | `1` | 1-based, minimum `1` |
| `end_line` | No | integer | server bounded | 1-based inclusive line number |

If both line fields are supplied, `end_line` MUST be greater than or equal to `start_line`.

The caller cannot increase the server's hard byte/line ceiling.

## Success output

```json
{
  "ok": true,
  "data": {
    "workspace_id": "workspace-lens",
    "path": "src/server.ts",
    "encoding": "utf-8",
    "size_bytes": 18342,
    "line_start": 1,
    "line_end": 200,
    "content": "...",
    "truncated": false
  }
}
```

`truncated: true` means more requested/available content exists beyond what was returned because the server output ceiling was reached.

A file exceeding the server's hard eligibility limit MUST fail with `FILE_TOO_LARGE` rather than allowing unlimited chunk-by-chunk extraction from a file category the server has chosen not to expose.

Binary and special files are not supported.

## Errors

- `INVALID_ARGUMENT`
- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_DISABLED`
- `WORKSPACE_UNAVAILABLE`
- `PATH_INVALID`
- `PATH_OUTSIDE_WORKSPACE`
- `PATH_BLOCKED`
- `PATH_NOT_FOUND`
- `NOT_A_FILE`
- `BINARY_FILE_NOT_SUPPORTED`
- `UNSUPPORTED_FILE_TYPE`
- `FILE_TOO_LARGE`
- `INTERNAL_ERROR`

## Side effects

None.

---

# 10. Tool: `search_workspace`

## Purpose

Search textual code/project content within an authorized workspace.

The MVP search contract is intentionally narrower than a raw regular-expression or command-line search interface.

## Input

```json
{
  "workspace_id": "workspace-lens",
  "query": "AccessPolicy",
  "path": "src",
  "file_pattern": "*.ts",
  "case_sensitive": true,
  "max_results": 50
}
```

Fields:

| Field | Required | Type | Default | Contract |
| --- | --- | --- | --- | --- |
| `workspace_id` | Yes | string | — | Authorized workspace ID |
| `query` | Yes | string | — | Literal text, length `1..500` |
| `path` | No | string | `.` | Workspace-relative search root |
| `file_pattern` | No | string | none | Simple implementation-defined glob filter, never shell syntax |
| `case_sensitive` | No | boolean | `true` | Literal-match case behavior |
| `max_results` | No | integer | `50` | Caller ceiling, `1..100`; server hard ceiling still applies |

Regular-expression semantics are NOT part of the MVP contract.

The server MUST treat `query` as literal text.

`file_pattern` MUST be passed through a validated glob abstraction. It MUST NOT be interpreted as a shell fragment or raw search-tool argument.

## Success output

```json
{
  "ok": true,
  "data": {
    "workspace_id": "workspace-lens",
    "query": "AccessPolicy",
    "matches": [
      {
        "path": "src/security/access-policy.ts",
        "line": 42,
        "column": 14,
        "preview": "export class AccessPolicy {"
      }
    ],
    "truncated": false
  }
}
```

Requirements:

- paths MUST be workspace-relative;
- blocked paths MUST not be searched or returned;
- binary files MUST not be returned;
- preview length MUST be bounded;
- matches SHOULD be ordered deterministically by path, then line, then column;
- `truncated` MUST be `true` when more matches exist than returned.

If `ripgrep` is used internally, raw ripgrep flags are not part of this public contract.

## Errors

- `INVALID_ARGUMENT`
- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_DISABLED`
- `WORKSPACE_UNAVAILABLE`
- `PATH_INVALID`
- `PATH_OUTSIDE_WORKSPACE`
- `PATH_BLOCKED`
- `PATH_NOT_FOUND`
- `NOT_A_DIRECTORY`
- `SEARCH_FAILED`
- `INTERNAL_ERROR`

## Side effects

None.

---

# 11. Tool: `git_status`

## Purpose

Return the current local Git working-tree state without modifying the repository and without network access.

## Input

```json
{
  "workspace_id": "workspace-lens"
}
```

Unknown properties MUST be rejected.

## Success output

```json
{
  "ok": true,
  "data": {
    "workspace_id": "workspace-lens",
    "branch": {
      "name": "main",
      "detached": false,
      "upstream": "origin/main",
      "ahead": 1,
      "behind": 0
    },
    "changes": [
      {
        "path": "src/server.ts",
        "staged": null,
        "unstaged": "modified"
      },
      {
        "path": "src/new-file.ts",
        "staged": null,
        "unstaged": "untracked"
      }
    ],
    "redacted_changes": 1,
    "clean": false
  }
}
```

Change-state values, when present, MUST be one of:

```text
added
modified
deleted
renamed
copied
untracked
conflicted
type_changed
```

For rename/copy records, an implementation MAY add `old_path`, subject to the same AccessPolicy.

`ahead`, `behind`, and `upstream` MAY be `null` when no upstream exists or the information is unavailable locally. `git_status` MUST NOT contact a remote to refresh them.

### Sensitive paths

For paths blocked by AccessPolicy, the MVP SHOULD increment `redacted_changes` instead of returning the sensitive path. File contents are never returned by this tool.

`clean` MUST be `false` if redacted changes exist, even when the visible `changes` array is empty.

## Errors

- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_DISABLED`
- `WORKSPACE_UNAVAILABLE`
- `NOT_A_GIT_REPOSITORY`
- `GIT_OPERATION_FAILED`
- `INTERNAL_ERROR`

## Side effects

None. No network access.

---

# 12. Tool: `git_diff`

## Purpose

Return a bounded textual Git diff for the current authorized workspace.

The tool exposes semantic diff scopes rather than arbitrary Git arguments.

## Input

```json
{
  "workspace_id": "workspace-lens",
  "scope": "all",
  "path": "src"
}
```

Fields:

| Field | Required | Type | Default | Contract |
| --- | --- | --- | --- | --- |
| `workspace_id` | Yes | string | — | Authorized workspace ID |
| `scope` | No | enum | `all` | `unstaged`, `staged`, or `all` |
| `path` | No | string | none | Optional workspace-relative file/directory filter |

No raw Git flags are accepted.

## Scope semantics

### `unstaged`

Changes in the working tree relative to the index.

Conceptually equivalent to Git's normal unstaged diff semantics.

### `staged`

Changes in the index relative to `HEAD`.

### `all`

Return both staged and unstaged sections, preserving their distinction.

The implementation MUST NOT silently collapse `all` into a representation that makes staged/unstaged state ambiguous.

Untracked file content is not returned by `git_diff`; callers use `git_status` to discover untracked files and `read_file` to inspect an allowed file explicitly.

## Success output

For a single scope:

```json
{
  "ok": true,
  "data": {
    "workspace_id": "workspace-lens",
    "scope": "unstaged",
    "sections": [
      {
        "scope": "unstaged",
        "diff": "diff --git ...",
        "files_changed": 2,
        "truncated": false
      }
    ],
    "redacted_files": 0,
    "truncated": false
  }
}
```

For `scope: "all"`, `sections` SHOULD contain at most two entries in this order:

```text
staged
unstaged
```

Global `truncated` MUST be `true` if any section is truncated or omitted because the server-wide diff output ceiling was reached.

### Sensitive paths

Before diff text crosses the MCP boundary, WorkspaceLens MUST apply AccessPolicy to affected paths.

Diff content for blocked files MUST NOT be returned.

`redacted_files` counts affected blocked paths without revealing their contents. Implementations SHOULD avoid returning blocked filenames themselves.

### Safe Git invocation

The public tool contract is semantic. If implemented with the Git CLI, WorkspaceLens MUST construct fixed, validated operations internally.

The implementation SHOULD disable:

- pagers;
- external diff programs;
- text conversion filters that can execute external programs.

Repository hooks MUST NOT be executed as part of this operation.

## Errors

- `INVALID_ARGUMENT`
- `WORKSPACE_NOT_FOUND`
- `WORKSPACE_DISABLED`
- `WORKSPACE_UNAVAILABLE`
- `PATH_INVALID`
- `PATH_OUTSIDE_WORKSPACE`
- `PATH_BLOCKED`
- `PATH_NOT_FOUND`
- `NOT_A_GIT_REPOSITORY`
- `GIT_OPERATION_FAILED`
- `INTERNAL_ERROR`

## Side effects

None. No network access.

---

# 13. Tool Descriptions Exposed to Models

MCP tool descriptions affect how a model chooses tools, so they are part of the product behavior even though exact wording is not a compatibility guarantee.

Descriptions SHOULD be concise and SHOULD communicate the security model.

Recommended intent:

| Tool | Description intent |
| --- | --- |
| `workspace_list` | List locally authorized workspaces available for read-only inspection |
| `workspace_info` | Get Git and inferred project metadata for an authorized workspace |
| `list_files` | Browse a bounded directory tree inside an authorized workspace |
| `read_file` | Read bounded text content from an allowed workspace-relative file |
| `search_workspace` | Search literal text across allowed workspace files |
| `git_status` | Inspect the current local Git working-tree state without modification |
| `git_diff` | Inspect bounded staged/unstaged Git diffs without modification |

For content-returning tools, descriptions SHOULD warn that returned repository content is untrusted data and may contain instruction-like text.

# 14. Server Limits

Exact values are configuration/implementation defaults rather than permanent API compatibility commitments, but the presence of hard limits is mandatory.

Recommended MVP defaults:

| Limit | Default | Hard behavior |
| --- | ---: | --- |
| Eligible file size | 1 MiB | Larger file: `FILE_TOO_LARGE` |
| `read_file` payload | 128 KiB | Partial result with `truncated: true` where possible |
| `list_files` entries | 2,000 | Partial result with `truncated: true` |
| Search results | 50 default / 100 caller max | `truncated: true` |
| Diff payload | 256 KiB | Partial result with `truncated: true` |
| `list_files.depth` | 5 max | `INVALID_ARGUMENT` above max |

The implementation MAY make these values locally configurable, but tool callers MUST NOT be able to disable limits.

# 15. Contract Tests

The implementation SHOULD maintain contract-level tests independent from adapter-specific tests.

Minimum required cases:

| Area | Test |
| --- | --- |
| Workspace | unknown `workspace_id` -> `WORKSPACE_NOT_FOUND` |
| Workspace | MCP caller cannot add/change a root |
| Paths | absolute path rejected |
| Paths | `..` traversal rejected |
| Paths | escaping symlink rejected |
| Policy | `.env` cannot be read |
| Policy | blocked file is absent from search results |
| Policy | blocked diff body is not returned |
| Listing | depth and entry limits enforced |
| Read | binary file rejected |
| Read | oversized eligible output marks truncation |
| Search | query is literal, not shell/regex execution |
| Git | arbitrary Git arguments are impossible at schema level |
| Git | `git_status` does not change repository state |
| Git | `git_diff` does not invoke network access |
| Errors | stack traces/command lines do not cross MCP boundary |

# 16. Explicitly Deferred Tools

The following are not part of the MVP contract:

```text
git_log
git_show
symbol_search
dependency_graph
architecture_summary
```

`git_log` and `git_show` are plausible future read-only additions, but they should be added only after the core reviewer workflow proves that commit-history access materially improves the product.

Write/execution tools are not merely deferred; they are outside the current WorkspaceLens product boundary.

# 17. Typical Reviewer Flow

A model reviewing current local work should be able to follow this pattern:

```text
workspace_list
      |
      v
workspace_info
      |
      v
git_status
      |
      v
git_diff
      |
      +--------------------+
      |                    |
      v                    v
search_workspace       read_file
      |                    |
      +----------+---------+
                 |
                 v
       architecture / code review
```

This is deliberately not an Agent state machine. The MCP server provides accurate, bounded local context; reasoning and review remain the responsibility of the model/host.

# 18. Change Policy Before v1.0

This specification is a `v0.1` draft. Breaking tool-schema changes are allowed while the MVP is being validated, but they MUST be reflected in this document before implementation and documentation diverge.

Once WorkspaceLens publishes a `v1.0` tool contract, tool names, required fields, result semantics, and stable error codes should follow semantic-versioning expectations.

# WorkspaceLens

A secure read-only MCP server that gives AI assistants access to your local development workspace.

## Overview

WorkspaceLens bridges the gap between AI reasoning models and local development environments.

Modern AI coding assistants are powerful, but they often cannot access the developer's real-time local workspace state:

- uncommitted changes
- local-only branches
- files that have not been pushed to GitHub
- current project structure
- local implementation details

WorkspaceLens provides a controlled, read-only context layer through the Model Context Protocol (MCP), allowing AI assistants to inspect a local workspace safely.

## Goals

WorkspaceLens focuses on one problem:

> Allow advanced AI models to act as senior code reviewers by understanding the developer's real local code state.

The project intentionally does **not** aim to become a coding agent.

## Design Principles

- Read-only by default
- Explicit workspace authorization
- No arbitrary command execution
- Minimal architecture
- Secure local-first design
- AI assistant agnostic

## MCP Tools

| Tool | Purpose |
| --- | --- |
| `workspace_list` | List authorized workspaces |
| `workspace_info` | Project metadata and technology stack information |
| `list_files` | Browse workspace structure |
| `read_file` | Read source files |
| `search_workspace` | Search code and text content |
| `git_status` | Inspect working tree status |
| `git_diff` | Review local uncommitted changes |
| `git_history` | List recent local commit metadata |
| `git_commit` | Inspect one local commit against its first parent |
| `git_compare` | Compare two committed revisions (direct or merge-base) |

## Installation

Requirements:

- Node.js 24 (the active LTS line at the time of the v0.1 implementation; pinned in `engines` and `.nvmrc`)
- Git on `PATH` (used only for read-only inspection)
- No GitHub push, no upload, and no custom domain is ever required

From a clean checkout:

```bash
npm install
npm run build
npm link          # optional: puts the `workspace-lens` binary on your PATH
```

## Setup

The canonical setup guide is [`docs/getting-started.md`](docs/getting-started.md). It walks the real, verified path — install → authorize a workspace → doctor → (optional) OpenAI Secure MCP Tunnel → start the tunnel process → configure ChatGPT → first `workspace_list` → first review — and labels which steps belong to WorkspaceLens, the OpenAI Platform, and ChatGPT.

Minimal stdio-only start:

```bash
npm install && npm run build && npm link
workspace-lens add ~/code/my-project --name "My Project"
workspace-lens doctor
workspace-lens serve   # speak MCP over stdio; your MCP client can also spawn this itself
```

Do not create a second setup guide: update `docs/getting-started.md` instead, so the documented path and the real path cannot drift apart.

Then ask your reviewer chat:

```text
Review the current uncommitted changes in my-project.
Focus on architecture risks and potential bugs.
```

The reviewer can discover context on its own via `workspace_list` → `git_status` → `git_diff` → `search_workspace` → `read_file`. For committed local work it can use `git_history` → `git_commit` → `git_compare(base, HEAD)`; local-only unpushed commits require no GitHub. There is no per-review initialization step; the workspace itself is the shared state.

### Configuration

Workspaces are stored in `~/.config/workspace-lens/config.json` (override with the `WORKSPACE_LENS_CONFIG` environment variable):

```json
{
  "version": 1,
  "expose_absolute_paths": false,
  "workspaces": [
    {
      "workspace_id": "my-project",
      "name": "My Project",
      "root": "/Users/example/code/my-project",
      "enabled": true
    }
  ]
}
```

`expose_absolute_paths` defaults to `false`; when explicitly enabled, `workspace_info` may return the canonical absolute root path. The model never needs it to call other tools.

## Security Model

WorkspaceLens is designed as a read-only boundary.

Blocked by default:

- `.env` files
- credentials
- private keys
- SSH configuration
- dependency directories such as `node_modules`
- generated build artifacts

Workspace access is limited to explicitly configured workspace roots. All paths are workspace-relative; canonical containment is verified with real-path resolution, so absolute paths, `..` traversal, and escaping symlinks are rejected. AccessPolicy blocks sensitive path names and file/diff bodies across current and historical content-bearing tools, including secrets that existed only in old commits. Commit metadata is different: `git_history` and `git_commit` intentionally return bounded author names and subjects, which are untrusted repository data and are not secret-scanned. Do not place credentials in commit messages.

WorkspaceLens cannot modify files, execute commands, or run arbitrary Git/search arguments. Public revisions are restricted commitishes (branch, tag, SHA, `HEAD`) — no ranges, ancestry syntax, or option-like values — and every revision is resolved to a concrete commit SHA through fixed internal Git templates before use. Workspace content is returned as untrusted data.

## ChatGPT Connection

ChatGPT cannot reach `localhost` directly. The supported path is the official OpenAI **Secure MCP Tunnel** with `tunnel-client`; it requires an OpenAI Platform tunnel, a runtime API key, and ChatGPT developer mode. The canonical repository walkthrough lives in [`docs/getting-started.md`](docs/getting-started.md) — do not duplicate it here.

## Status

`v0.2` adds local committed-state review (`git_history`, `git_commit`, `git_compare`) so a reviewer can inspect local-only unpushed commits and a trusted-base-to-head range without GitHub, plus a canonical setup guide. The implementation and automated contracts are present, but the v0.2 real ChatGPT acceptance gate is still pending; do not report the release complete until the Phase 7 workflow in `docs/v0.2-implementation-plan.md` is recorded successfully.

```bash
npm run typecheck
npm test
```

Previously validated v0.1 integration baseline:

- **Gate 0**: a real ChatGPT conversation reached the disposable connection-test server through the official tunnel path (discovery, repeated calls, restart recovery, honest stop-failure).
- **Phase 11**: a real ChatGPT review conversation used the full product server through the same tunnel to inspect local uncommitted changes (`pocket-railway`, real repository, no GitHub push, no file upload, read-only).

Recorded UX observations (`implementation-plan.md` §18; noted, not fixed):

- Reviewer models that have a built-in bash tool default to it unless the conversation attaches the WorkspaceLens app or the prompt names the connector tools explicitly.
- With the tunnel daemon stopped, ChatGPT surfaces an empty tool result instead of an explicit error message (platform-level behavior, outside WorkspaceLens Core).

See:

- [Getting Started](docs/getting-started.md) — the canonical setup guide
- [Product Experience](docs/product-experience.md)
- [Security Model](docs/security-model.md)
- [MCP Tools Specification](docs/mcp-tools-spec.md) — v0.1 base contract
- [v0.2 MCP Tools Contract](docs/v0.2-mcp-tools-contract.md) — authoritative three-tool delta
- [Architecture](docs/architecture.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Roadmap](docs/roadmap.md)

## License

MIT

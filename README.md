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

## Quick Start

```bash
# 1. Authorize one or more workspace roots (local configuration only)
workspace-lens add ~/code/my-project --name "My Project"
workspace-lens list

# 2. Check local prerequisites
workspace-lens doctor

# 3. Serve the MCP server on stdio
workspace-lens serve
```

`serve` runs in the foreground and speaks MCP over stdio. Any MCP client that can launch a stdio server can use it, for example:

```json
{
  "mcpServers": {
    "workspace-lens": {
      "command": "workspace-lens",
      "args": ["serve"]
    }
  }
}
```

Then ask your reviewer chat:

```text
Review the current uncommitted changes in my-project.
Focus on architecture risks and potential bugs.
```

The reviewer can discover context on its own via `workspace_list` → `git_status` → `git_diff` → `search_workspace` → `read_file`. There is no per-review initialization step; the workspace itself is the shared state.

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

Workspace access is limited to explicitly configured workspace roots. All paths are workspace-relative; canonical containment is verified with real-path resolution, so absolute paths, `..` traversal, and escaping symlinks are rejected. Blocked content cannot leak across `read_file`, `list_files`, `search_workspace`, `git_status`, or `git_diff` — they all share one AccessPolicy.

WorkspaceLens cannot modify files, execute commands, or run arbitrary Git/search arguments. Workspace content is returned as untrusted data.

## ChatGPT Connection

ChatGPT cannot reach `localhost` directly. The supported path is the official OpenAI **Secure MCP Tunnel** with `tunnel-client`. Gate 0 validation passed on the development environment: a real ChatGPT conversation discovered and repeatedly called the connection-test tool through the tunnel, recovered after a daemon restart, and honestly surfaced the stopped-service failure.

Prerequisites (OpenAI-side, require your accounts):

1. An OpenAI Platform organization with **Tunnels** permission (`Read + Use` to run, `Read + Manage` to create); create a tunnel at `platform.openai.com/settings/organization/tunnels` to obtain a `tunnel_id`.
2. A runtime API key (`CONTROL_PLANE_API_KEY`).
3. The official client from `github.com/openai/tunnel-client/releases/latest`.
4. ChatGPT **developer mode** enabled for your workspace (Business/Enterprise/Edu; Pro supports read/fetch connectors).

Product setup:

```bash
npm run build
workspace-lens add /path/to/your/project
export CONTROL_PLANE_API_KEY="<runtime key>"
workspace-lens connect chatgpt --tunnel-id <your-tunnel-id>   # creates the profile via official init
workspace-lens connect chatgpt                                 # re-check + print next steps
tunnel-client run --profile workspace-lens                     # keep the tunnel alive
```

Then in ChatGPT: create a developer-mode app, pick **Tunnel** under Connection, select your tunnel, and call `workspace_list` from a real chat.

## Status

`v0.1` phases 1–10 of `docs/implementation-plan.md` are implemented and covered by automated suites (typecheck + 215 tests):

```bash
npm run typecheck
npm test
```

Validated on the development environment:

- **Gate 0**: a real ChatGPT conversation reached the disposable connection-test server through the official tunnel path (discovery, repeated calls, restart recovery, honest stop-failure).
- **Phase 11**: a real ChatGPT review conversation used the full product server through the same tunnel to inspect local uncommitted changes (`pocket-railway`, real repository, no GitHub push, no file upload, read-only).

Recorded UX observations (`implementation-plan.md` §18; noted, not fixed):

- Reviewer models that have a built-in bash tool default to it unless the conversation attaches the WorkspaceLens app or the prompt names the connector tools explicitly.
- With the tunnel daemon stopped, ChatGPT surfaces an empty tool result instead of an explicit error message (platform-level behavior, outside WorkspaceLens Core).

See:

- [Product Experience](docs/product-experience.md)
- [Security Model](docs/security-model.md)
- [MCP Tools Specification](docs/mcp-tools-spec.md)
- [Architecture](docs/architecture.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Roadmap](docs/roadmap.md)

## License

MIT

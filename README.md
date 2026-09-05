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

## ChatGPT Connection (Gate 0)

ChatGPT cannot reach `localhost` directly. The documented OpenAI path is **Secure MCP Tunnel** with the official `tunnel-client`. Gate 0 validates this path with a disposable server before product integration work proceeds.

Prerequisites (OpenAI-side, require your accounts):

1. An OpenAI Platform organization with **Tunnels** permission (`Read + Use` to run, `Read + Manage` to create); create a tunnel at `platform.openai.com/settings/organization/tunnels` to obtain a `tunnel_id`.
2. A runtime API key (`CONTROL_PLANE_API_KEY`).
3. The official client from `github.com/openai/tunnel-client/releases/latest`.
4. ChatGPT **developer mode** enabled for your workspace (Business/Enterprise/Edu; Pro supports read/fetch connectors).

Validation steps:

```bash
# Build the disposable connection-test server (workspace_list only, no filesystem access)
npm run build

tunnel-client init \
  --sample sample_mcp_stdio_local \
  --profile workspace-lens-gate0 \
  --tunnel-id <your-tunnel-id> \
  --mcp-command "node /absolute/path/to/workspace-lens/dist/gate0/connection-test-server.js"

tunnel-client doctor --profile workspace-lens-gate0 --explain
tunnel-client run --profile workspace-lens-gate0
```

Then in ChatGPT: create a developer-mode app, pick **Tunnel** under Connection, select your tunnel, and call `workspace_list` from a real chat. Gate 0 passes only when discovery, repeated calls, restarts, and stop-state failures behave reliably on your account.

## Status

The local Core (`v0.1` phases 1–9 of `docs/implementation-plan.md`) is implemented and covered by the automated contract/security suites:

```bash
npm run typecheck
npm test
```

Open items requiring a real user environment:

- **Gate 0**: validate the real ChatGPT connection path (steps above).
- **Phase 10**: `workspace-lens connect chatgpt` — proceeds only after Gate 0 passes.
- **Phase 11**: end-to-end product validation in a real reviewer chat.

See:

- [Product Experience](docs/product-experience.md)
- [Security Model](docs/security-model.md)
- [MCP Tools Specification](docs/mcp-tools-spec.md)
- [Architecture](docs/architecture.md)
- [Implementation Plan](docs/implementation-plan.md)
- [Roadmap](docs/roadmap.md)

## License

MIT

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

## Core Capabilities

Planned MCP tools:

| Tool | Purpose |
| --- | --- |
| `workspace_list` | List authorized workspaces |
| `workspace_info` | Project metadata and technology stack information |
| `list_files` | Browse workspace structure |
| `read_file` | Read source files |
| `search_workspace` | Search code and text content |
| `git_status` | Inspect working tree status |
| `git_diff` | Review local uncommitted changes |

## Example Use Cases

### Code Review

```
Review my current local changes.
Check architecture impact and potential risks.
```

### Architecture Analysis

```
Understand this project structure and explain the major modules.
```

### Debugging

```
Find the root cause of this issue based on the current workspace.
```

## Security Model

WorkspaceLens is designed as a read-only boundary.

Blocked by default:

- `.env` files
- credentials
- private keys
- tokens
- SSH configuration
- dependency directories such as `node_modules`
- generated build artifacts

Workspace access is limited to explicitly configured workspace roots.

## Architecture

```
AI Assistant
     |
     | MCP
     |
WorkspaceLens MCP Server
     |
     |
Authorized Local Workspace
```

## Status

This project is in early design and MVP implementation planning.

See:

- [Architecture](docs/architecture.md)
- [Roadmap](docs/roadmap.md)

## License

MIT

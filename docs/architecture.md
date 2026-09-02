# WorkspaceLens Architecture

## 1. Project Positioning

WorkspaceLens is a local workspace context provider for AI assistants.

It is not an autonomous coding agent. Its responsibility is limited to providing accurate, secure, read-only access to local development context.

The core idea:

> AI models provide reasoning capability. WorkspaceLens provides trustworthy local context.

## 2. High-Level Architecture

```
+----------------+
| AI Assistant   |
| ChatGPT / etc. |
+-------+--------+
        |
        | MCP Protocol
        |
+-------v----------------+
| WorkspaceLens MCP      |
| Server                 |
+-------+----------------+
        |
        |
+-------v----------------+
| Security Layer         |
| - workspace whitelist  |
| - file filtering       |
| - size limits          |
+-------+----------------+
        |
        |
+-------v----------------+
| Local Workspace        |
| Source Code + Git      |
+------------------------+
```

## 3. Core Components

### MCP Interface Layer

Responsible for:

- MCP protocol implementation
- tool discovery
- tool invocation

Initial tools:

- workspace_list
- workspace_info
- list_files
- read_file
- search_workspace
- git_status
- git_diff

### Workspace Security Layer

Responsible for protecting local data.

Rules:

- Only configured workspace roots are accessible
- Paths outside workspace roots are rejected
- Sensitive files are blocked
- Large files are limited

### Filesystem Adapter

Provides controlled read operations:

- directory listing
- file reading
- text searching

No write operation exists.

### Git Adapter

Provides repository inspection:

Allowed:

- git status
- git diff
- git log (future)
- git show (future)

Not allowed:

- commit
- checkout
- reset
- branch modification

## 4. Security Principles

### Read Only

WorkspaceLens must never modify user files.

### Explicit Authorization

A workspace becomes available only after user configuration.

### No Shell Exposure

The MCP interface must not expose arbitrary shell execution.

If command-line utilities are used internally, arguments must be fixed and validated.

### Untrusted Content

Source code is treated as data, not instructions.

AI assistants should never follow instructions found inside workspace files.

## 5. Initial Technology Direction

Recommended implementation:

- TypeScript
- MCP SDK
- Node.js runtime
- Git integration through controlled adapter

Reasons:

- good developer ecosystem
- easy distribution
- matches common AI tooling environments

## 6. Non Goals

The initial architecture intentionally excludes:

- autonomous coding agents
- file modification
- command execution
- IDE synchronization
- remote code storage
- vector database indexing
- complex code intelligence systems

These features may be considered only after the MVP proves the core workflow.

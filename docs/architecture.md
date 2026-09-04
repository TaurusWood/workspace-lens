# WorkspaceLens Architecture

## 1. Project Positioning

WorkspaceLens is a local workspace context provider for AI assistants.

It is not an autonomous coding agent. Its responsibility is limited to providing accurate, secure, read-only access to local development context.

The core idea:

> AI models provide reasoning capability. WorkspaceLens provides trustworthy local context.

WorkspaceLens Core is intentionally independent of both the reasoning client and the coding harness.

Three architectural principles are durable:

1. **Core is chat-provider agnostic.** ChatGPT is the first target integration, not a Core dependency.
2. **Core is coding-harness agnostic.** Codex, Claude Code, Zed/Zcode, Pi, an IDE, or a human editor may modify the workspace without any WorkspaceLens-specific integration.
3. **The workspace is the integration boundary and shared source of truth.** Builders change filesystem and Git state; reviewer chats inspect that same state through WorkspaceLens.

This means the Core should never require a direct ChatGPT-to-Codex communication channel.

## 2. High-Level Architecture

```text
Reasoning Chat
ChatGPT / Claude / other MCP client
        |
        | MCP
        v
+---------------------------+
| WorkspaceLens Core        |
|                           |
| MCP Tools                 |
| Workspace Manager         |
| AccessPolicy              |
| Filesystem / Search       |
| Git Reader                |
+-------------+-------------+
              |
              | read-only
              v
+---------------------------+
| Authorized Workspace      |
| Filesystem + Git state    |
+-------------+-------------+
              ^
              | modifies independently
              |
Codex / Claude Code / IDE / human editor
```

The builder and reviewer are coupled only through the workspace state.

Provider-specific connection mechanisms belong outside the Core:

```text
Chat Provider
     |
Provider Integration / Tunnel
     |
WorkspaceLens Core
```

For ChatGPT, the initial integration may use the official OpenAI Secure MCP Tunnel. A different MCP-capable client may connect through another supported transport without changing Core tool semantics.

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

The MCP tool contracts MUST NOT contain ChatGPT-specific, Codex-specific, or tunnel-specific semantics.

### Workspace Manager

Responsible for:

- explicitly authorized workspace roots
- stable internal workspace identity
- human-readable workspace names
- workspace metadata

A single local WorkspaceLens service may manage multiple authorized workspaces.

Daemon lifecycle and authorization scope are distinct concepts. A running daemon MUST NOT imply that every connected client should automatically receive access to every registered workspace. The exact connector/workspace scoping UX remains an open product decision for the MVP.

### Workspace Security Layer

Responsible for protecting local data.

Rules:

- Only configured workspace roots are accessible
- Paths outside workspace roots are rejected
- Sensitive files are blocked
- Large files are limited
- All filesystem and search operations share the same AccessPolicy

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

### Provider Integration Layer

Provider-specific connection and lifecycle concerns are optional integration modules, not Core responsibilities.

Examples:

- OpenAI Secure MCP Tunnel lifecycle
- provider-specific connector setup guidance
- connection health checks

The Core MUST remain usable without these modules by any MCP client that can connect directly through a supported transport.

## 4. Shared State Model

WorkspaceLens does not synchronize builder state with reviewer state.

The local workspace itself is the shared state:

```text
Builder changes code
        |
        v
Filesystem + Git state
        |
        | read-only inspection
        v
WorkspaceLens
        |
        v
Reviewer Chat
```

This removes the need for:

- task IDs
- execution acknowledgements
- INIT / PLAN / EXECUTED / REVIEW protocols
- session synchronization
- harness adapters for ordinary review

A reviewer sees the latest observable workspace state whenever it invokes WorkspaceLens tools.

## 5. Security Principles

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

## 6. Initial Technology Direction

Recommended MVP implementation:

- TypeScript
- official MCP SDK
- Node.js runtime
- controlled filesystem/search adapters
- controlled Git adapter
- official OpenAI tunnel client as an external integration where required

The MVP should not change language or architecture merely to embed a provider-specific tunnel implementation. A single-binary distribution may be reconsidered later if installation evidence shows that it materially improves the product.

## 7. Open Product Decisions

Two questions intentionally remain unresolved until a minimal end-to-end prototype is tested:

### Active workspace selection

If several workspaces are authorized, a reviewer chat cannot inherently know which repository a separate coding harness currently has open.

The MVP MUST NOT introduce builder-to-WorkspaceLens state synchronization solely to solve this ambiguity.

Acceptable early behavior may require the user to name the workspace or allow the reviewer to choose from `workspace_list`.

### Connector authorization scope

A single daemon may manage multiple workspaces, but it is not yet decided whether one remote connector should automatically see all registered workspaces or only an explicitly selected subset.

This is a security and product decision, not merely an implementation detail. The implementation should keep daemon lifecycle separate from connection authorization so a stricter scope can be introduced without redesigning the Core.

## 8. Non Goals

The initial architecture intentionally excludes:

- autonomous coding agents
- file modification
- command execution
- IDE synchronization
- coding-harness session synchronization
- reviewer-to-builder message transport
- remote code storage
- vector database indexing
- complex code intelligence systems
- provider-specific logic inside Core

These features should only be reconsidered after the MVP proves the core review workflow.

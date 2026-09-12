# WorkspaceLens Architecture

## 1. Project Positioning

WorkspaceLens is a local workspace context provider for reasoning assistants.

It is not an autonomous coding agent. Its responsibility is to provide accurate, secure, read-only access to explicitly authorized local development context and to make that context connection easy to operate.

The durable model is:

> AI models provide reasoning capability. WorkspaceLens provides trustworthy local context.

Three architectural principles remain stable:

1. **Core is reasoning-provider agnostic.** ChatGPT is the first target integration, not a Core dependency.
2. **Core is coding-harness agnostic.** Codex, Claude Code, an IDE, another harness, or a human may modify the workspace independently.
3. **The workspace is the shared source of truth.** Builders change filesystem/Git state; reasoning clients inspect that same state through WorkspaceLens.

WorkspaceLens therefore does not require a direct ChatGPT-to-coding-harness communication channel.

---

## 2. v0.3 High-Level Architecture

```text
ChatGPT / reasoning client
        |
        | MCP through provider integration
        v
+--------------------------------------------------+
| WorkspaceLens Control Runtime                    |
|                                                  |
|  WebUI + local Control API                       |
|  read-only MCP HTTP endpoint                     |
|  Application Services                            |
|                                                  |
|  +--------------------------------------------+  |
|  | Existing WorkspaceLens Core               |  |
|  | Workspace identity / AccessPolicy         |  |
|  | Filesystem / Search / Git adapters        |  |
|  | bounded read-only MCP tool definitions    |  |
|  +--------------------------------------------+  |
+-------------------------+------------------------+
                          |
                          | read-only
                          v
                Authorized Workspaces
                          ^
                          | modified independently
                          |
              Coding harness / IDE / human
```

For ChatGPT, the provider integration is the official OpenAI Secure MCP Tunnel. Tunnel transport/lifecycle remains outside Core.

The Control Runtime is a product/control layer around Core; it does not expand Core into an execution runtime.

---

## 3. Core Components

### 3.1 MCP Interface Layer

Responsible for:

- MCP protocol adapters;
- tool discovery;
- tool invocation;
- stable bounded result/error envelopes.

Current read-only tools include:

- `workspace_list`;
- `workspace_info`;
- `list_files`;
- `read_file`;
- `search_workspace`;
- `git_status`;
- `git_diff`;
- `git_history`;
- `git_commit`;
- `git_compare`.

The MCP contracts MUST NOT contain ChatGPT-specific, tunnel-specific, Codex-specific, or WebUI administration semantics.

### 3.2 Workspace Manager / Authorization

Responsible for:

- explicitly authorized workspace roots;
- stable `workspace_id`;
- human-readable names;
- enabled/disabled state;
- current root availability.

A single normal WorkspaceLens installation manages multiple authorized workspaces.

v0.3 default authorization scope is:

> all enabled local workspaces are discoverable through the one normal WorkspaceLens provider connection.

A disabled workspace is unavailable to MCP callers.

Per-connection workspace subsets are not a v0.3 requirement. They may be introduced later if real multi-user/security requirements justify them.

### 3.3 Explicit Workspace Identity

There is no mutable global `current workspace` or `recent workspace` in WorkspaceLens.

Each content-bearing MCP operation resolves from explicit workspace identity.

This is required for concurrent chats/clients to inspect different repositories safely.

### 3.4 Workspace Security Layer

Responsible for protecting local data.

Rules include:

- only configured workspace roots are accessible;
- paths outside roots are rejected;
- sensitive paths/files are blocked;
- output/file sizes are bounded;
- filesystem/search/Git operations share the accepted policy boundary;
- missing roots never broaden/fall back to ancestor directories.

### 3.5 Filesystem/Search Adapters

Provide controlled read-only operations.

No general write adapter exists for reasoning clients.

### 3.6 Git Adapter

Provides semantic read-only repository inspection.

Allowed product capabilities include bounded status, diff, history, commit inspection, and revision comparison.

Not allowed:

- commit;
- checkout;
- reset;
- branch mutation;
- arbitrary Git passthrough.

---

## 4. Application Service Layer

v0.3 introduces shared application services above Core so CLI and WebUI do not duplicate product rules.

Conceptually:

```text
CLI -----------+
                |
Control API ----+--> Application Services
                        |
                        +-- workspace administration
                        +-- connection lifecycle
                        +-- diagnostics
                        +-- settings
                        +-- optional prompt helpers
                        |
                        v
                 Config / Core / Integrations
```

Application services may mutate **WorkspaceLens-owned configuration and integration state**. They still do not write authorized workspace contents.

Core MUST NOT import WebUI, HTTP, browser-session, autostart, credential-store, or provider-runtime concepts.

---

## 5. Control Runtime

v0.3 introduces one long-lived WorkspaceLens Control Runtime for the current user.

Responsibilities:

- serve the packaged WebUI;
- serve the privileged localhost Control API;
- serve a local read-only MCP HTTP endpoint;
- host application services;
- expose bounded health/readiness/current operational status;
- coordinate provider integration through supported provider tooling;
- remain available when the provider tunnel is unhealthy so the user can diagnose/recover it.

It is not:

- a coding agent;
- task runtime;
- terminal;
- build/test executor;
- ChatGPT session manager;
- CR/Plan state machine.

The public product launcher is `workspace-lens start`; the browser is only a control surface and may be closed without stopping the runtime.

---

## 6. Provider Integration Layer

Provider-specific connection mechanisms remain outside Core.

For v0.3 ChatGPT integration:

```text
WorkspaceLens Control Runtime
        |
        | local MCP URL
        v
official tunnel-client managed runtime
        |
        v
Secure MCP Tunnel
        |
        v
ChatGPT
```

WorkspaceLens does not reimplement the tunnel protocol.

The normal v0.3 integration uses the official tunnel-client managed-runtime surface for connect/status/stop/recovery rather than process grepping or WorkspaceLens-owned PID supervision.

A different MCP-capable client may use another transport without changing Core tool semantics.

The existing `workspace-lens serve` stdio adapter remains supported for clients that launch a local MCP process directly.

---

## 7. Configuration and Live Authorization

The filesystem authorization config remains the source of truth for registered workspaces.

v0.3 adds safe inter-process mutation semantics so CLI and WebUI cannot silently lose one another's updates.

MCP authorization must observe current validated configuration without requiring the Control Runtime/tunnel to restart after workspace administration.

Preferred semantics:

```text
MCP request
-> obtain current validated config snapshot
-> resolve explicit workspace_id
-> execute request against that immutable snapshot
```

Malformed/unreadable config fails closed rather than silently serving a stale broader authorization snapshot.

Transient UI/runtime state does not belong in the workspace authorization config.

---

## 8. Shared State Model

WorkspaceLens does not synchronize coding-harness state with reasoning-client state.

The workspace itself is the shared state:

```text
Builder changes code
        |
        v
Filesystem + Git state
        |
        | bounded read-only inspection
        v
WorkspaceLens
        |
        v
Reasoning chat
```

This removes the need for:

- task IDs;
- execution acknowledgements;
- builder/reviewer state synchronization;
- harness adapters for ordinary review;
- direct agent-to-agent transport.

---

## 9. Security Boundaries

### 9.1 Reasoning MCP

Read-only capability by construction:

- no workspace writes;
- no arbitrary shell;
- no arbitrary Git passthrough;
- explicit workspace authorization;
- shared AccessPolicy.

### 9.2 Local Control API

The v0.3 WebUI introduces a distinct privileged localhost administration boundary because it can change WorkspaceLens authorization, settings, startup, credentials, and connection state.

It therefore requires a separate browser security contract covering:

- loopback-only binding;
- Host validation;
- same-origin mutation checks;
- CSRF/session protection;
- restrictive CSP/CORS behavior;
- bounded DTO/body handling;
- secret redaction.

See `v0.3-control-plane-security-contract.md`.

### 9.3 Secrets

Provider runtime secrets are stored outside ordinary WorkspaceLens config through a reviewed secret-store abstraction.

Literal secrets must not appear in argv, logs, diagnostics, prompt helpers, or MCP results.

---

## 10. Product Lifecycle and Distribution

The v0.3 user-facing target is:

> **One install, one bootstrap, zero daily CLI.**

Required first distribution may use:

```text
npm install -g workspace-lens
workspace-lens start
```

After setup/autostart, normal daily use should not require Terminal interaction.

Native installers may be introduced later without changing the browser-based Control Runtime architecture.

See `v0.3-bootstrap-distribution-contract.md`.

---

## 11. Technology Direction

Accepted v0.3 direction:

- Node.js 24;
- TypeScript;
- Zod for runtime boundary validation;
- existing MCP SDK/tool contracts, with Streamable HTTP adapter added without coupling a protocol migration to v0.3;
- Hono for the small localhost HTTP control surface;
- React + Vite SPA for WebUI;
- official OpenAI tunnel-client as external provider integration;
- OS-backed secret/startup/folder-picker adapters behind narrow interfaces.

Not required:

- Next.js/SSR;
- Electron/Tauri;
- cloud-hosted WorkspaceLens control plane;
- separate web deployment.

---

## 12. Resolved and Deferred Decisions

### Resolved for v0.3

- one normal WorkspaceLens installation manages N workspaces;
- one normal provider connection exposes all enabled workspaces;
- explicit workspace identity; no global active/recent workspace;
- Control Runtime remains alive independently of browser and tunnel health;
- official tunnel-client owns its managed runtime lifecycle;
- normal ChatGPT path targets the Control Runtime's MCP HTTP endpoint;
- CLI/WebUI share application services;
- live config changes take effect without MCP restart;
- WebUI is local control/recovery, not a development workbench.

### Deferred until demonstrated need

- per-connection workspace subsets;
- native installer/updater as a release requirement;
- persistent MCP access history (v0.4);
- richer semantic code intelligence;
- reasoning workflow Skills (conditional v0.5 work).

---

## 13. Non-Goals

The architecture intentionally excludes:

- autonomous coding agents;
- workspace modification;
- command execution for reasoning clients;
- source editor/browser workbench;
- coding-harness session synchronization;
- reviewer-to-builder message transport;
- remote code storage;
- ChatGPT conversation/Project ownership;
- semantic CR/Plan completion tracking;
- agent orchestration.

These boundaries should only be reconsidered through explicit product decisions supported by real user evidence.

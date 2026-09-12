# WorkspaceLens Product Experience

Status: Durable product contract, updated with accepted v0.3 productization decisions.

This document defines what WorkspaceLens should feel like to use. Detailed v0.3 behavior lives in the version-specific product, interaction, UI, architecture, security, bootstrap, and implementation documents.

---

## 1. Product Thesis

WorkspaceLens solves one narrow problem:

> Give a high-reasoning AI chat accurate, safe, read-only access to the developer's real local workspace.

WorkspaceLens is not a coding agent, task orchestrator, message bus, or synchronization layer between AI products.

The durable product model is:

```text
Coding harness / IDE   = Builder
Reasoning chat         = Reviewer / Thinker
WorkspaceLens          = Eyes / local context control plane
Local workspace        = Shared source of truth
User                   = Decision boundary
```

The central principle remains:

> **WorkspaceLens automates context transfer, not decision transfer.**

---

## 2. Target Daily Experience

The desired daily experience is a normal reasoning conversation, not an MCP workflow.

A developer should be able to open a supported reasoning chat and ask for review, planning, architecture, requirement analysis, or repository understanding against an authorized local workspace.

The reasoning client may internally use WorkspaceLens tools such as:

```text
workspace_list
-> git_status / git_diff / git_compare
-> search_workspace
-> read_file
-> discussion with user
```

The user should not need to:

- upload a ZIP;
- push local changes to GitHub first;
- paste diffs/files into chat;
- explain repository structure manually;
- initialize a review session;
- synchronize coding-harness state;
- create task IDs;
- understand MCP transport details;
- manage tunnel PIDs/processes;
- own/configure a public domain.

The product succeeds when local workspace access feels like a safe capability already available to the reasoning chat.

---

## 3. Reasoning Chat Remains the Primary Work Surface

WorkspaceLens does not build a custom reasoning/chat UI.

The valuable loop is:

```text
User <-> reasoning chat
          |
          | read-only factual context
          v
     WorkspaceLens
          |
          v
   Local Workspace
```

The user can:

- ask follow-up questions;
- challenge recommendations;
- inspect more evidence;
- compare alternatives;
- refine constraints;
- reject part of a review;
- converge on a final plan/recommendation.

WorkspaceLens supplies factual local context; the reasoning product supplies the conversation.

---

## 4. First-time Setup vs Daily Usage

### 4.1 v0.2/current verified setup

`getting-started.md` documents the real v0.2 CLI/tunnel setup and remains the source of truth for the current implemented release line.

### 4.2 v0.3 target setup

The accepted v0.3 productization principle is:

> **One install, one bootstrap, zero daily CLI.**

The first required distribution may use:

```text
npm install -g workspace-lens
workspace-lens start
```

Then:

```text
browser opens local WorkspaceLens WebUI
-> guided setup
-> authorize workspaces
-> configure provider connection
-> verify real MCP access
-> enable Start at login
```

After successful setup/autostart, ordinary daily use should require no Terminal interaction.

The browser is a control surface, not the long-lived runtime. Closing the browser must not stop WorkspaceLens or the configured provider connection.

Native installers may improve onboarding later without changing this product model.

---

## 5. Workspace Model

WorkspaceLens is one local product/service managing multiple explicitly authorized workspaces.

Example:

```text
WorkspaceLens
├── workspace-lens
├── daily-signals
├── pocket-railway
└── J-Store
```

Adding another project normally means only authorizing another workspace.

It should not require:

- another WorkspaceLens install;
- another MCP server by default;
- another tunnel by default;
- another ChatGPT app by default.

Internally, each workspace has a stable `workspace_id`. Product surfaces may also show a human-readable name/root/status.

v0.3 default provider authorization scope is:

> all enabled registered workspaces are discoverable through the one normal WorkspaceLens provider connection.

A disabled workspace is unavailable.

Per-connection workspace subsets are deferred until a real security/multi-user use case requires them.

---

## 6. Workspace Selection and Chat Identity

WorkspaceLens does not know which coding harness project is “current,” and does not own ChatGPT chat or Project identity.

There is no hidden/global `current workspace` or `recent workspace` state.

The preferred high-frequency convention is:

```text
ChatGPT Project: daily-signals
  |
  | Project Instructions
  v
Use WorkspaceLens workspace "daily-signals"
```

In an ordinary chat, the user or reasoning client names/selects the explicit workspace.

If multiple workspaces exist and the target is ambiguous, WorkspaceLens/reasoning client should enumerate/ask rather than guess.

No builder/IDE state synchronization is introduced merely to remove this ambiguity.

---

## 7. Reviewer and Builder Are Intentionally Separate

Expected workflow:

```text
Builder
   |
   | modifies workspace
   v
Local Workspace
   ^
   | read-only
   |
WorkspaceLens
   ^
   |
Reasoning Chat
   |
   | discussion
   v
User
   |
   | intentional handoff
   v
Builder
```

Builder owns execution:

- editing;
- commands;
- tests;
- implementation;
- debugging loops.

Reasoning chat owns reasoning:

- architecture;
- code review;
- planning;
- risk analysis;
- requirement audit;
- repository understanding.

WorkspaceLens owns context access and local connection control only.

---

## 8. Handoff Back to the Builder Is Manual by Design

The final reasoning conclusion must not automatically trigger code changes.

The user manually transfers the final recommendation/instruction to the coding harness.

WorkspaceLens MUST NOT introduce by default:

- automatic reviewer -> builder message forwarding;
- coding-harness task creation;
- review/execution state synchronization;
- execution acknowledgements;
- automatic review/implementation loops.

Optional formatting/copy helpers may reduce friction while keeping the user as the explicit approval boundary.

---

## 9. Read-only Capability Is a Product Feature

WorkspaceLens's small capability surface is intentional.

The reasoning MCP does not gain side effects merely to remove minor manual actions.

No:

- file writes;
- arbitrary command execution;
- arbitrary Git passthrough;
- local note/task creation through MCP;
- coding-harness control.

The v0.3 WebUI may mutate **WorkspaceLens-owned administration state** (workspace authorization, settings, connection lifecycle) but still cannot edit authorized workspace contents.

---

## 10. Provider Connection Is an Integration Detail

Users should not need to understand tunnel implementation details.

Conceptually:

```text
Reasoning Provider
       |
Provider Integration / Tunnel
       |
WorkspaceLens
       |
Authorized Workspaces
```

For ChatGPT, WorkspaceLens uses the official OpenAI tunnel client rather than reimplementing Secure MCP Tunnel.

In v0.3, WorkspaceLens should expose product actions such as:

```text
Connection: Healthy
[Restart connection]
```

not require normal users to reason about:

```text
PIDs
pgrep
child processes
runtime aliases
health ports
```

Other MCP-capable reasoning clients may use different transports without changing Core tool semantics.

---

## 11. v0.3 WebUI Role

WorkspaceLens v0.3 adds a local browser WebUI, but it is **not** a new daily development workbench.

Its purpose is:

- setup;
- workspace authorization management;
- connection status/recovery;
- diagnostics;
- settings/autostart;
- optional workspace-targeting/reasoning prompt helpers.

When WorkspaceLens is healthy, the ideal user often does not open the WebUI at all.

The WebUI is not:

- a custom chat UI;
- source-code browser/editor;
- terminal;
- diff workbench;
- task board;
- build/test runner;
- CR/Plan analytics dashboard;
- agent manager.

---

## 12. Observability Is Factual, Not Semantic

WorkspaceLens may know factual operational events such as:

```text
workspace_id
tool called
success/error
duration
result size/truncation
connection lifecycle
last request timestamp
```

It cannot reliably infer from those facts:

- CR completed;
- plan completed;
- review result;
- task status;
- ChatGPT conversation identity.

v0.4 may add bounded MCP Activity / Access Log, but it remains observability rather than work analytics.

---

## 13. Shared State Is the Workspace

The workspace itself provides builder/reviewer shared state:

```text
Builder changes code
        |
        v
Workspace state
        |
        | WorkspaceLens reads current state
        v
Reasoning Chat
```

A builder can be replaced without a WorkspaceLens adapter as long as it changes the same local files/Git repository.

This simplicity is a core product property.

---

## 14. Product Non-Goals

WorkspaceLens does not aim to become:

- autonomous coding agent;
- coding-harness orchestrator;
- chat/session manager;
- browser automation system;
- remote code storage service;
- workflow state machine;
- task synchronization service;
- write-capable repository bridge;
- arbitrary shell gateway;
- mandatory GitHub integration;
- mandatory public-domain service.

These exclusions should only be reconsidered if concrete user evidence shows that one omission materially blocks the core context/reasoning workflow.

---

## 15. Product Acceptance Principles

The durable product experience is successful when:

1. Local workspaces are explicitly authorized without exposing unrelated files.
2. Reasoning clients can inspect current local/unpushed state without GitHub push or file uploads.
3. Multi-turn reasoning remains in the user's preferred reasoning/chat product.
4. One WorkspaceLens installation can manage multiple workspaces.
5. Workspace targeting is explicit and never silently redirected by global recent/current state.
6. WorkspaceLens cannot modify workspace contents or execute arbitrary commands through MCP.
7. Returning conclusions to the coding harness remains user-controlled.
8. Provider/harness replacement does not require Core redesign.
9. v0.3 onboarding hides process/tunnel infrastructure from ordinary users.
10. After successful v0.3 setup with autostart, normal daily use requires no Terminal interaction.
11. Closing the browser does not stop WorkspaceLens.
12. Operational status is factual and does not invent ChatGPT/CR/Plan semantics.

---

## 16. Decision Summary

The product optimizes for:

```text
Builder changes code
        |
        v
Real local workspace
        |
        | WorkspaceLens: safe read-only context
        v
High-reasoning chat
        |
        | interactive discussion
        v
Human decision
        |
        | explicit handoff
        v
Builder continues implementation
```

WorkspaceLens should be a small, trustworthy, largely invisible bridge between local code and reasoning models.

The mature experience is:

> install once -> configure multiple workspaces -> keep it available -> mostly forget that it is there.

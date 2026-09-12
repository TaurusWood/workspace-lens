# WorkspaceLens Roadmap

WorkspaceLens is a secure, read-only local context layer for reasoning assistants. The roadmap intentionally avoids expanding the product into a coding agent, task orchestrator, session manager, or reviewer-to-builder automation system.

For detailed version requirements, see [`version-requirements-v0.2-v0.5.md`](./version-requirements-v0.2-v0.5.md).

## Roadmap Model

```text
v0.1  Core technical path
  ->
v0.2  Review context completeness
  ->
v0.3  Local Context Control Plane
  ->
v0.4  Workspace Targeting + Observability
  ->
v0.5  Reasoning Workflow Composition
```

Feature count is not a success criterion. Each version should solve one additional layer of friction without changing WorkspaceLens into an execution runtime.

---

## v0.1 — Core Technical Path Proven

Status: complete.

Goal:

Prove that a reasoning chat can safely inspect the real current state of an explicitly authorized local development workspace.

Delivered:

- local WorkspaceLens MCP server;
- explicit workspace authorization;
- file listing and reading;
- workspace search;
- project metadata;
- Git working-tree status and diff;
- shared read-only access policy;
- no arbitrary shell execution;
- no arbitrary Git passthrough;
- OpenAI Secure MCP Tunnel integration path;
- real reasoning review of local uncommitted code without GitHub push or file upload.

---

## v0.2 — Review Context Completeness

Status: implementation/current CLI product line.

Status: implementation and automated gates complete; real ChatGPT acceptance pending.

Goal:

Complete the core read-only review context before adding a graphical local control plane.

Primary scope:

- semantic local commit history;
- semantic single-commit inspection;
- semantic base/head or revision-range comparison;
- support complete review of local unpushed commits;
- preserve bounded read-only Git semantics;
- one canonical verified first-time setup path from install to real ChatGPT tool call.

Explicitly deferred to v0.3:

- WebUI;
- persistent Control Runtime;
- login lifecycle/autostart;
- visual workspace administration;
- browser diagnostics/recovery;
- zero-daily-CLI productization.

`getting-started.md` remains the canonical v0.2 setup guide until v0.3 is actually implemented and verified.

---

## v0.3 — Local Context Control Plane

Goal:

Turn WorkspaceLens from a CLI-oriented integration into a locally installed product that is configured once, manages multiple workspaces, remains available for daily reasoning use, and normally requires no Terminal interaction after setup.

Product principle:

> **One install, one bootstrap, zero daily CLI.**

Normal product shape:

```text
Browser WebUI
     |
     v
WorkspaceLens Control Runtime
     |
     +-- WebUI + privileged local Control API
     +-- read-only MCP HTTP endpoint
     +-- shared Application Services
     +-- workspace/config/diagnostics/settings
     |
     +--> official tunnel-client managed runtime
     |
     v
Authorized local workspaces
```

Primary scope:

- one normal WorkspaceLens installation managing N authorized workspaces;
- one normal provider connection exposing all enabled workspaces in v0.3;
- no mutable global current/recent workspace;
- localhost-only browser WebUI;
- workspace add/remove/rename/enable/disable management;
- stable workspace identity;
- optional Project Instructions / Review Prompt / Plan Prompt copy helpers;
- guided first-time onboarding;
- connection lifecycle/status/recovery through the official tunnel-client managed-runtime surface;
- structured diagnostics;
- login autostart;
- OS-backed runtime credential handling;
- shared application services used by CLI and WebUI;
- live configuration semantics so workspace changes do not require MCP restart;
- local Control API browser security;
- npm/package-shaped distribution;
- canonical user launcher `workspace-lens start`;
- compatibility with existing `workspace-lens serve` stdio clients.

v0.3 WebUI is a configuration/control/recovery surface. It is not:

- an IDE;
- source browser/editor;
- terminal;
- build/test runner;
- chat UI;
- task manager;
- CR/Plan history dashboard;
- remote/LAN administration product;
- agent runtime.

Native `.dmg` / Windows installer / Linux installer distribution may follow if npm bootstrap proves to be meaningful adoption friction. Native packaging does not require Electron/Tauri.

Detailed v0.3 contracts:

- [`v0.3-product-spec.md`](./v0.3-product-spec.md)
- [`v0.3-interaction-spec.md`](./v0.3-interaction-spec.md)
- [`v0.3-ui-spec.md`](./v0.3-ui-spec.md)
- [`v0.3-technical-readiness-audit.md`](./v0.3-technical-readiness-audit.md)
- [`v0.3-technical-architecture-rfc.md`](./v0.3-technical-architecture-rfc.md)
- [`v0.3-bootstrap-distribution-contract.md`](./v0.3-bootstrap-distribution-contract.md)
- [`v0.3-control-plane-security-contract.md`](./v0.3-control-plane-security-contract.md)
- [`v0.3-implementation-plan.md`](./v0.3-implementation-plan.md)

---

## v0.4 — Workspace Targeting + MCP Observability

Goal:

Reduce workspace-targeting ambiguity and make WorkspaceLens access behavior transparent without introducing conversation/session ownership.

Direction:

### Workspace targeting

- recommend one high-frequency ChatGPT Project per preferred local workspace as a UX convention;
- use Project Instructions to name the preferred WorkspaceLens `workspace_id`;
- continue supporting explicit workspace naming in ordinary chats;
- use exact identity rather than fuzzy/global-recent selection;
- never store or depend on ChatGPT Project IDs or conversation IDs in Core.

### Workspace context summary

Expose richer factual context where useful, for example:

- branch;
- HEAD;
- dirty summary;
- last factual MCP access timestamp.

This remains context visibility, not a code browser.

### MCP Activity / Access Log

Record factual operational events such as:

```text
timestamp
workspace_id
tool
success/error
duration
result size/truncation
connection lifecycle event
```

This is **Observability, not Work Analytics**.

WorkspaceLens MUST NOT infer from access patterns:

- CR complete;
- Plan complete;
- review passed;
- task status;
- conversation identity.

A lightweight Security/Exposure view may show what categories are readable/protected if it can be derived from the existing policy without creating a new policy-management product.

---

## v0.5 — Reasoning Workflow Composition

Goal:

Make WorkspaceLens compose cleanly with user-selected reasoning/process conventions while keeping WorkspaceLens itself context-only.

Responsibility model:

```text
WorkspaceLens                         = Context
Project Instructions / optional Skill = Reasoning behavior
repository process / development-flow = Process
Codex / Claude Code / IDE / human     = Execution
```

Workload boundary:

```text
Reasoning-dense inspection loop
Inspect -> reason -> inspect more evidence -> conclude

Suitable for WorkspaceLens + reasoning chat:
Review / Plan / Requirement Audit / Architecture / Repository Understanding
```

```text
Execution-dense implementation loop
Inspect -> change -> execute -> observe -> repeat

Owned by local harness/human:
Implement / Debug / Test / Refactor / Build
```

`development-flow` is a reference integration, not a WorkspaceLens dependency.

Reviewer/Planner Skills are optional and should only be developed if repeated real user friction justifies them. Existing repository skills, `AGENTS.md`, or Project Instructions may supersede WorkspaceLens helper prompts entirely.

No automatic reviewer -> builder execution, agent event bus, shared runtime task state, or automatic review/implementation loop is planned.

---

## Cross-Version Invariants

These are durable unless an explicit future product decision changes them:

1. **Read-only repository capability** — no write/edit/delete/execute tools in the reasoning MCP surface.
2. **Provider-agnostic Core** — ChatGPT/tunnel integration remains outside Core.
3. **Harness-agnostic Core** — WorkspaceLens does not depend on Codex/Claude Code/IDE state.
4. **One service, many workspaces** — per-workspace servers/tunnels are not the default architecture.
5. **Explicit workspace identity** — content-bearing operations resolve by explicit workspace identity.
6. **No global current/recent workspace** — concurrent chats must not redirect one another.
7. **Concurrent isolation** — filesystem root, Git cwd, policy, and output remain workspace-scoped.
8. **No conversation ownership** — WorkspaceLens does not model ChatGPT chats, Project IDs, or reasoning sessions.
9. **Observability stays factual** — tool/runtime facts may be logged; semantic work state is not inferred.
10. **Human decision boundary** — reviewer conclusions do not automatically trigger implementation.
11. **Add complexity after observed friction** — optional conveniences do not automatically grow into subsystems.

---

## Longer-Term Exploration

Only after demonstrated recurring need:

- stricter per-connection workspace authorization subsets;
- native installers/signing/updaters;
- additional provider integrations;
- richer workspace summaries;
- improved search performance;
- dependency/symbol-aware context;
- framework-specific understanding.

These should be promoted only when they solve measured user friction without weakening the simple read-only context boundary.

---

## Current Priority

1. Implement v0.3 according to the accepted contracts and `v0.3-implementation-plan.md`.
2. Preserve v0.2 MCP/security behavior throughout the control-plane work.
3. Prove the clean-install end-to-end scenario: install -> `workspace-lens start` -> WebUI setup -> real MCP verification -> add second workspace without restart -> login autostart -> zero daily CLI.

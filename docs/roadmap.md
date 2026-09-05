# WorkspaceLens Roadmap

WorkspaceLens is a secure, read-only local context layer for reasoning assistants. The roadmap intentionally avoids expanding the product into a coding agent, task orchestrator, or reviewer-to-builder automation system.

For detailed post-v0.1 product requirements, see [`version-requirements-v0.2-v0.5.md`](./version-requirements-v0.2-v0.5.md).

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
- real ChatGPT review of local uncommitted code without GitHub push or file upload.

## v0.2 — Review Completeness and Setup Clarity

Goal:

Complete the core review context before adding a graphical product surface.

Priority work:

- semantic local commit history;
- semantic single-commit inspection;
- semantic base/head or revision-range comparison;
- support complete review of local unpushed commits;
- preserve read-only bounded Git semantics;
- document one canonical first-time setup path from install to successful real ChatGPT tool call.

Explicitly deferred:

- WebUI / GUI;
- daemon and login lifecycle productization;
- ChatGPT Project mapping;
- Reviewer Skill integration.

## v0.3 — Local Productization

Goal:

Turn WorkspaceLens from a CLI-oriented integration that can be configured successfully into a local tool that ordinary developers can configure once and keep available for daily use.

Preferred product shape:

```text
Browser WebUI
     |
     v
Local Control Service (Node.js)
     |
     +--> Workspace configuration
     +--> health / diagnostics
     +--> provider integration lifecycle
     +--> official tunnel-client supervision
     |
     v
WorkspaceLens Core
```

Primary work:

- localhost-only browser WebUI;
- workspace add/remove/enable/disable management;
- service and integration status;
- ChatGPT/tunnel setup guidance;
- official tunnel-client lifecycle management;
- diagnostics;
- persistent daily availability and explicit autostart support;
- shared application services so CLI and WebUI use the same configuration and authorization semantics;
- local-control HTTP security, including cross-origin/state-change protection;
- packaging and installation experience.

v0.3 is expected to contain the largest engineering effort in the current roadmap.

The WebUI is only a local control surface. It is not an IDE, source browser, chat UI, remote administration product, or workflow/task manager.

A macOS-first implementation is acceptable where OS-specific lifecycle work would otherwise block progress, while Core, CLI, configuration, and WebUI contracts should remain portable.

## v0.4 — ChatGPT Project / Workspace Convention

Goal:

Reduce workspace-selection friction for high-frequency projects without coupling WorkspaceLens Core to ChatGPT Projects.

Direction:

- recommend one local workspace per high-frequency ChatGPT Project as a UX convention;
- use Project Instructions to identify the preferred workspace;
- continue supporting explicit workspace selection in ordinary chats;
- use exact/unique selection rather than fuzzy matching;
- treat ambiguity explicitly rather than adding hidden global recent-workspace state;
- clearly distinguish ChatGPT Project organization from WorkspaceLens authorization scope.

WorkspaceLens Core must not store or depend on ChatGPT Project IDs or chat IDs.

## v0.5 — Reviewer Behavior and development-flow Composition

Goal:

Make reasoning chats more consistently effective as reviewers without turning WorkspaceLens into an orchestration framework.

Target responsibility model:

```text
WorkspaceLens     = Context
development-flow  = Process
Reviewer Skill    = Reasoning behavior
```

Direction:

- keep `development-flow` responsible for repository-persisted task contracts, phase state, gates, and evidence;
- let WorkspaceLens expose those repository facts through ordinary read operations;
- keep Reviewer Skill reusable independently of WorkspaceLens;
- avoid duplicating `development-flow` gate semantics inside the Reviewer Skill;
- keep final reviewer-to-builder handoff explicitly user-controlled.

No automatic reviewer -> builder execution, shared agent runtime state, event bus, or review/implementation loop is planned.

## Longer-Term Exploration

Only after demonstrated recurring need:

- stricter per-connection workspace authorization scopes;
- additional OS-specific lifecycle integrations;
- richer workspace summaries;
- improved search performance;
- dependency or symbol-aware context;
- architecture summaries;
- framework-specific understanding.

These features should only be promoted when they solve observed user friction without weakening WorkspaceLens's simple read-only product boundary.

## Current Priority

1. Implement v0.2 Git review completeness.
2. Finish canonical initialization/setup documentation.
3. Prepare the v0.3 Local Control Service + WebUI architecture and security contract.

The main productization risk and engineering investment is v0.3, not v0.2.

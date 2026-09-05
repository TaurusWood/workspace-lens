# WorkspaceLens Version Requirements: v0.2-v0.5

Status: Product requirements draft for post-v0.1 iterations.

This document defines the intended product scope for WorkspaceLens v0.2 through v0.5. It does not replace the durable product and security contracts in `product-experience.md`, `architecture.md`, `security-model.md`, or `mcp-tools-spec.md`.

The purpose of these versions is to improve review completeness and daily usability without changing the core product model:

```text
Reasoning Chat
      |
      | safe read-only context
      v
WorkspaceLens
      |
      v
Authorized Local Workspace
      ^
      |
Zcode / Codex / Claude Code / IDE / Human
```

The durable boundaries remain:

- WorkspaceLens Core is chat-provider agnostic.
- WorkspaceLens Core is coding-harness agnostic.
- The local workspace is the shared source of truth.
- WorkspaceLens provides read-only context, not execution.
- WorkspaceLens does not orchestrate agents.
- Reviewer -> Builder handoff remains user-controlled.
- No generic shell or arbitrary Git command passthrough is introduced.

## 1. Version Strategy

The post-v0.1 roadmap is intentionally staged rather than combining all productization work into one release.

```text
v0.1  Core technical path proven
  |
  v
v0.2  Complete the core review context + setup documentation
  |
  v
v0.3  Local productization: Local Control Service + WebUI
  |
  v
v0.4  ChatGPT Project / workspace interaction convention
  |
  v
v0.5  Reviewer behavior + development-flow composition
```

The largest expected engineering effort is v0.3. v0.2, v0.4, and v0.5 should remain deliberately narrower and must not be allowed to expand into adjacent platform or orchestration work.

---

# 2. v0.2 — Review Completeness and Setup Clarity

## Goal

Make the existing read-only review workflow complete enough to review both working-tree changes and local committed work, while making first-time setup reproducible from documentation.

v0.2 is not a GUI release.

## Problem

v0.1 can inspect the current working tree through `git_status` and `git_diff`, but real review sessions also need local Git history and commit-range context.

A reviewer may need to answer questions such as:

- What commits were made locally?
- What exactly changed in a specific commit?
- What changed between a trusted base and the current branch head?
- Is the implementation split across several local commits that have not been pushed?

Without semantic history and range operations, the reviewer may fall back to GitHub, which cannot represent unpushed local commits.

Separately, the v0.1 connection path is technically proven but still requires users to understand several setup steps. v0.2 should make the documented setup path explicit and deterministic before introducing a graphical control surface.

## Required Capabilities

### 2.1 Semantic Git history

Add a bounded, read-only operation for recent commit history.

The operation should expose only review-relevant structured information such as:

- commit identifier;
- author/date where appropriate;
- subject/summary;
- optional bounded file/change metadata where useful.

It must not accept arbitrary Git arguments.

### 2.2 Semantic commit inspection

Add a bounded, read-only operation for inspecting one selected commit.

The result should provide review-relevant commit metadata and the corresponding bounded change content.

The operation must validate the requested ref and must not expose a generic `git show` passthrough.

### 2.3 Semantic revision/range comparison

Add a bounded, read-only operation for comparing two validated revisions or a trusted base against a reviewed head.

It should support the common review case equivalent in meaning to:

```text
base .. HEAD
```

without accepting arbitrary Git command-line arguments.

The exact MCP tool names are implementation details and should be finalized in `mcp-tools-spec.md`. The product contract is the semantic capability, not a command wrapper.

### 2.4 Preserve the existing Git safety model

All new Git capabilities MUST remain:

- read-only;
- semantic rather than command-oriented;
- bounded in output;
- constrained to the authorized workspace repository;
- free of shell passthrough;
- free of arbitrary Git argument passthrough;
- subject to the same sensitive-data and output policies as existing tools where applicable.

### 2.5 First-time setup documentation

Document one canonical ChatGPT setup path from install to successful `workspace_list` call.

The documentation should clearly separate:

1. installing WorkspaceLens;
2. authorizing local workspaces;
3. checking local prerequisites;
4. configuring the OpenAI Secure MCP Tunnel integration;
5. starting the required local processes;
6. completing ChatGPT-side setup;
7. verifying the connection with a real chat.

The document should distinguish one-time setup from normal daily usage and should clearly identify which steps are WorkspaceLens-owned versus provider-owned.

## v0.2 Non-goals

Do not add:

- WebUI or desktop GUI;
- background daemon management;
- automatic login/startup behavior;
- ChatGPT Project mapping;
- Reviewer Skill packaging;
- development-flow integration APIs;
- generic Git commands;
- write-capable Git operations.

## v0.2 Acceptance Criteria

v0.2 is complete when:

1. A reasoning chat can review uncommitted working-tree changes as before.
2. A reasoning chat can inspect recent local commits without GitHub.
3. A reasoning chat can inspect a specific local commit without GitHub.
4. A reasoning chat can compare an approved/trusted base with a local reviewed head or equivalent validated revision pair.
5. Unpushed local commits can be fully included in a review workflow.
6. None of the new tools expose arbitrary Git or shell arguments.
7. A new technical user can follow one documented setup path from install to a successful real ChatGPT tool call.

---

# 3. v0.3 — Local Productization with WebUI

## Goal

Turn WorkspaceLens from a command-line setup that a user can make work into a local tool that an ordinary developer can configure once and keep available for daily use.

v0.3 is expected to contain the largest engineering effort in this roadmap.

The preferred product shape is:

```text
Browser
   |
   | localhost-only control UI
   v
WorkspaceLens Local Control Service (Node.js)
   |                |
   |                +--> Provider integration / tunnel lifecycle
   |
   +--> shared application services
            |
            v
      WorkspaceLens Core
            |
            v
   Authorized Workspaces
```

The WebUI is a local control surface. It is not a hosted web product, chat interface, IDE, or code browser.

## 3.1 Product Decision: WebUI before Electron/native GUI

v0.3 should prefer a browser-based local UI backed by the existing Node.js product rather than introducing Electron or a platform-native application.

Reasons:

- WorkspaceLens already runs in Node.js.
- The required UI is configuration- and status-oriented rather than graphics- or desktop-integration-heavy.
- A WebUI minimizes new runtime and packaging complexity.
- The same control surface can remain portable across operating systems.
- Core and CLI can stay independent of UI technology.

This is a product direction, not permission to build a general-purpose web platform.

## 3.2 Local Control Service

The WebUI requires a local control service. v0.3 should therefore be treated as `Local Control Service + WebUI`, not merely a set of static pages.

The Local Control Service should own product-level local operations required by the UI, while reusing the same underlying application services as the CLI.

The GUI/WebUI MUST NOT create a second configuration model or duplicate business rules already used by the CLI/Core.

Conceptually:

```text
CLI -----------+
               |
               v
        Shared Application Services
               ^
               |
WebUI / Local Control Service
```

The UI must not implement workspace authorization logic independently from the existing configuration/security layer.

## 3.3 Minimum WebUI responsibilities

The initial WebUI should be intentionally small.

### Workspace management

The user can:

- view all configured workspaces;
- add a local workspace through a folder-selection flow appropriate to the platform/runtime;
- see workspace name and enabled state;
- enable or disable a workspace;
- remove a workspace authorization;
- see clear validation errors for invalid or inaccessible roots.

The UI should not expose opaque IDs unless needed for diagnostics.

### Local service status

The user can see whether the WorkspaceLens local service is healthy and whether the configuration is valid.

### ChatGPT / tunnel integration status

The user can see product-relevant provider integration state, such as:

- integration configured / not configured;
- official tunnel client available / unavailable;
- tunnel process running / stopped;
- tunnel connection healthy / unhealthy where this can be verified reliably.

The UI must not claim that a specific ChatGPT conversation is connected unless WorkspaceLens can actually verify that fact.

### Tunnel lifecycle

WorkspaceLens should be able to start, stop, and recover the official tunnel-client process used by its ChatGPT integration.

WorkspaceLens should supervise the official client rather than reimplementing the tunnel protocol.

Tunnel lifecycle remains an integration-layer concern and MUST NOT become part of WorkspaceLens Core.

### Diagnostics

The user should have a simple diagnostic view that can identify at least:

- invalid workspace configuration;
- missing runtime prerequisite;
- missing tunnel client;
- tunnel process stopped;
- tunnel connection failure when detectable;
- provider setup still requiring a manual step.

A copyable diagnostics summary is desirable if it can be implemented without exposing secrets.

## 3.4 First-time onboarding

The target onboarding flow is conceptually:

```text
Start WorkspaceLens
      |
      v
Open local WebUI
      |
      v
Authorize workspace(s)
      |
      v
Configure ChatGPT connection
      |
      v
Complete provider-owned browser/account step if required
      |
      v
Connection check
      |
      v
Ready
```

The user should not need to understand MCP transport internals, tunnel profile files, tunnel IDs, local ports, or process supervision beyond information that the provider requires them to supply directly.

Where OpenAI requires explicit account-side configuration, WorkspaceLens should guide the user to that step rather than attempting to replace or automate an unsupported provider workflow.

## 3.5 Daily-use target

After successful onboarding, normal daily review should not require the user to re-run a sequence of setup commands.

The target experience is:

```text
Open reasoning chat
    -> ask about an authorized workspace
    -> WorkspaceLens is already available
```

## 3.6 Autostart / persistent availability

Persistent availability is part of the v0.3 product goal, but the implementation should remain minimal and platform-aware.

Requirements:

- provide an explicit user-controlled option to start WorkspaceLens automatically at login;
- do not silently install persistent background behavior without clear user action;
- keep Core independent of OS startup mechanisms;
- treat OS-specific startup integration as a thin adapter around the local product runtime.

A macOS-first implementation is acceptable if cross-platform startup handling would materially delay the release. Core, CLI, configuration, and WebUI contracts should remain portable.

## 3.7 Local WebUI security requirements

A local browser UI introduces a new control surface and therefore requires an explicit security contract.

At minimum:

- the control HTTP server MUST bind only to loopback by default;
- it MUST NOT expose the control interface on LAN/public interfaces by default;
- state-changing operations MUST be protected from cross-origin browser requests;
- CORS MUST NOT be configured broadly merely for convenience;
- requests that mutate workspace authorization or integration state must require an origin/session/anti-CSRF mechanism sufficient to prevent an arbitrary website from controlling the local service;
- secrets such as provider API keys must not be rendered into diagnostics or normal UI responses;
- the WebUI must not create a new path for reading arbitrary workspace files beyond the existing authorized MCP/context model unless separately specified and reviewed.

`localhost-only` is necessary but is not, by itself, a complete browser security model.

## 3.8 CLI compatibility

The CLI remains a supported interface for advanced users and automation.

v0.3 should not force users to use the WebUI for operations that already have stable CLI equivalents.

The CLI and WebUI should converge on the same underlying state and semantics.

## 3.9 v0.3 Non-goals

Do not add:

- Electron solely to host the WebUI;
- a custom chat UI;
- source-code browsing/editing UI;
- diff viewer as a primary product surface;
- review history database;
- task management UI;
- `.agent/tasks` workflow UI;
- coding-harness control;
- remote browser-accessible administration;
- cloud-hosted WorkspaceLens control plane;
- automatic Project mapping;
- agent orchestration.

## 3.10 v0.3 Engineering Risk Areas

The main expected engineering effort is concentrated here:

1. defining a shared application-service layer used by both CLI and WebUI without duplicating Core rules;
2. safely exposing local state-changing operations through a browser-facing localhost API;
3. supervising the official tunnel client reliably across start/stop/crash/restart cases;
4. modeling connection state honestly without claiming provider-side state that cannot be observed;
5. adding login/autostart behavior without coupling Core to OS-specific process management;
6. packaging the Node runtime, UI assets, tunnel integration, and startup behavior into a repeatable installation experience;
7. preserving an easy uninstall/disable path and avoiding hidden persistent processes.

These are v0.3's central productization problems. Visual design sophistication is secondary.

## 3.11 v0.3 Acceptance Criteria

v0.3 is complete when:

1. A user can open a local WebUI without manually editing WorkspaceLens configuration files.
2. A user can add, inspect, disable/enable, and remove authorized workspaces from that UI.
3. CLI and WebUI operate on the same configuration and authorization semantics.
4. A user can understand the current local service and ChatGPT tunnel integration state from the UI.
5. WorkspaceLens can manage the expected tunnel-client lifecycle without reimplementing the tunnel protocol.
6. Normal daily usage no longer requires manually starting multiple commands in the expected supported setup.
7. Autostart can be explicitly enabled and disabled where the release supports it.
8. The local WebUI is loopback-only by default and protected against arbitrary cross-origin state-changing requests.
9. WorkspaceLens Core remains independent of WebUI, HTTP transport, ChatGPT, tunnel-client lifecycle, and OS startup mechanisms.

---

# 4. v0.4 — ChatGPT Project / Local Workspace Interaction Model

## Goal

Reduce repeated workspace-selection friction for high-frequency projects without creating a technical dependency between WorkspaceLens Core and ChatGPT Projects.

## Product Model

The recommended convention is:

```text
Local Workspace A
        ^
        | preferred context convention
        v
ChatGPT Project A
    |- Chat 1
    |- Chat 2
    `- Chat 3
```

A ChatGPT Project is an organization and conversation-context layer.

A WorkspaceLens workspace is a local authorization and context-access unit.

They are not the same object and MUST NOT become the same object in Core.

## Required v0.4 behavior

### Project Instructions convention

Document a recommended Project Instructions pattern that identifies the preferred WorkspaceLens workspace for that Project.

Example concept:

```text
Use WorkspaceLens workspace `workspace-lens` for local repository context in this Project.
If the workspace is unavailable or ambiguous, do not guess; inspect the available workspaces first.
```

The exact wording may evolve.

### Natural name matching

When the user or Project Instructions names a workspace, the reviewer may select a unique exact logical match from `workspace_list`.

WorkspaceLens should not implement a fuzzy Project-name matching engine merely to remove occasional naming friction.

### Ambiguity behavior

If multiple authorized workspaces exist and no unique workspace can be determined, the reviewer should inspect `workspace_list` and ask or require explicit selection rather than guessing.

### Ordinary Chat behavior

Ordinary chats remain supported. The user can explicitly name the workspace in the request.

### Optional WebUI assistance

The v0.3 WebUI may later expose small convenience actions such as copying a recommended Project Instructions snippet for a selected workspace.

Such actions are UX helpers only. They do not establish a technical Project binding.

## Security boundary

Project organization MUST NOT be presented as workspace authorization isolation.

A recommendation that Project A normally uses Workspace A does not imply that the underlying WorkspaceLens connection is technically incapable of accessing other enabled workspaces.

If stricter isolation becomes a demonstrated need, it should be designed as a WorkspaceLens connection-authorization scope independent of ChatGPT Project IDs.

## v0.4 Non-goals

Do not add:

- ChatGPT Project IDs to WorkspaceLens Core;
- ChatGPT chat IDs to WorkspaceLens Core;
- Project lifecycle synchronization;
- fuzzy Project/workspace matching;
- global `recent workspace` state that silently changes behavior across chats;
- Project-based access-control claims that WorkspaceLens cannot enforce;
- a second tunnel per Project by default;
- mandatory one-workspace-per-Project enforcement.

## v0.4 Acceptance Criteria

v0.4 is complete when:

1. The recommended one-local-workspace-to-one-high-frequency-Project convention is clearly documented.
2. A Project can establish its preferred workspace through instructions without Core knowing anything about the Project.
3. Ordinary chats can continue to select workspaces explicitly.
4. Ambiguous workspace selection results in explicit discovery/selection rather than fuzzy guessing.
5. Product documentation clearly distinguishes Project organization from WorkspaceLens authorization scope.

---

# 5. v0.5 — Reviewer Behavior and development-flow Composition

## Goal

Make reasoning chats more consistently effective as reviewers while keeping reasoning behavior and engineering process outside WorkspaceLens Core.

## Responsibility Model

The intended long-term composition is:

```text
WorkspaceLens    = Context

development-flow = Process

Reviewer Skill   = Reasoning behavior
```

These layers should compose through repository state and prompts/skills rather than through an orchestration protocol.

## WorkspaceLens responsibility

WorkspaceLens continues to provide only safe read-only access to repository facts, including source files, search, workspace metadata, Git state, and review-relevant Git history/ranges.

WorkspaceLens does not know which development-flow phase owns the current task.

## development-flow responsibility

`development-flow` owns persistent engineering protocol and task state, including `.agent/tasks/<task-id>` contracts, gates, state, and evidence.

Those task files are ordinary repository state and can be inspected through WorkspaceLens like any other authorized non-sensitive repository files.

No dedicated development-flow API is required merely to make the two systems work together.

## Reviewer Skill responsibility

A future Reviewer Skill may define reusable reasoning behavior for activities such as:

- code review;
- architecture review;
- requirement audit;
- implementation-plan review;
- regression/risk analysis;
- test-gap and false-green analysis;
- handoff summarization.

The Reviewer Skill should remain usable with other context sources such as GitHub, uploaded diffs, or another read-only repository connector. It should not require WorkspaceLens as a hard dependency.

The Reviewer Skill should also avoid duplicating workflow state transitions or gate definitions already owned by `development-flow`.

## ChatGPT Project Instructions

Project Instructions may provide stable project-level preferences such as:

- preferred WorkspaceLens workspace;
- project-specific review emphasis;
- stable project constraints that belong in the chat environment.

They should not become the durable store of task state when `development-flow` is being used.

## Human handoff remains the boundary

The final reviewer conclusion continues to be transferred to the Builder by the user.

WorkspaceLens v0.5 MUST NOT automatically forward reviewer output to Codex, Claude Code, Zcode, an IDE, or another coding harness.

A skill may produce a concise handoff block for the user to copy, but it must not execute or transmit the handoff automatically.

## v0.5 Non-goals

Do not add:

- agent-to-agent messaging;
- reviewer -> builder automatic execution;
- shared runtime task state between ChatGPT and coding harnesses;
- acknowledgement/retry protocols;
- automatic review/implementation loops;
- C2C orchestration;
- WorkspaceLens-specific workflow state;
- duplicated `development-flow` gates in the Reviewer Skill.

## v0.5 Acceptance Criteria

v0.5 is complete when:

1. WorkspaceLens, development-flow, and Reviewer Skill have documented non-overlapping responsibilities.
2. A reviewer can inspect relevant `.agent/tasks` state through normal WorkspaceLens read operations when that repository uses development-flow.
3. Reviewer behavior is reusable independently of WorkspaceLens.
4. development-flow remains the owner of workflow phase/gate semantics.
5. Reviewer conclusions can be formatted for handoff while final transfer remains an explicit user action.

---

# 6. Cross-Version Invariants

The following requirements apply to every version in this roadmap.

## 6.1 No agent orchestration

Do not introduce an event bus, reviewer/builder protocol, shared execution state, automatic forwarding, or autonomous review/implementation loop.

## 6.2 No write expansion in WorkspaceLens Core

WorkspaceLens remains a read-only context product. Product-control operations such as adding/removing authorized workspace entries or starting/stopping the local integration runtime belong to the local control/configuration layer and do not grant the MCP reviewer write access to repository contents.

## 6.3 Provider independence remains architectural

ChatGPT is the first and most developed reasoning surface, but WorkspaceLens Core contracts must not require ChatGPT-specific Project, chat, tunnel, or account concepts.

## 6.4 Harness independence remains architectural

Codex, Claude Code, Zcode, IDEs, and humans remain interchangeable builders as long as they modify the same local workspace.

## 6.5 Prefer explicit behavior over hidden state

Do not add hidden global session state merely to guess the active workspace or task. Explicit workspace identity, repository-persisted task facts, and visible connection state are preferred.

## 6.6 Add complexity only after observed friction

Potential features such as per-connection workspace scopes, Windows-native startup integration, richer diagnostics, or additional reasoning skills should be promoted into committed requirements only when the current simpler model creates a demonstrated recurring problem.

---

# 7. Priority Summary

| Version | Primary Outcome | Engineering Weight |
| --- | --- | --- |
| v0.2 | Complete local Git review context and make setup reproducible | Small / focused |
| v0.3 | Local Control Service + browser WebUI + lifecycle productization | **Largest** |
| v0.4 | Stable ChatGPT Project / workspace convention without Core coupling | Small / UX-policy focused |
| v0.5 | Compose Context + Process + Reviewer reasoning without orchestration | Medium, mostly outside Core |

The immediate implementation focus after v0.1 is v0.2. The primary design and engineering risk to prepare for is v0.3.

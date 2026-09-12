# WorkspaceLens Version Requirements: v0.2-v0.5

Status: Product requirements draft for post-v0.1 iterations.

This document defines the intended product scope for WorkspaceLens v0.2 through v0.5. It does not replace the durable product and security contracts in `product-experience.md`, `architecture.md`, `security-model.md`, or `mcp-tools-spec.md`.

The purpose of these versions is to improve review completeness and daily usability without changing the core product model:

```text
Reasoning Chat / Project
        |
        | safe read-only context
        v
WorkspaceLens
        |
        | one service, many authorized workspaces
        v
Authorized Local Workspaces
        ^
        |
Codex / Claude Code / Zcode / IDE / Human
```

The durable boundaries remain:

- WorkspaceLens Core is chat-provider agnostic.
- WorkspaceLens Core is coding-harness agnostic.
- The local workspace is the shared source of truth.
- WorkspaceLens provides read-only context, not execution.
- WorkspaceLens does not orchestrate agents.
- Reviewer -> Builder handoff remains user-controlled.
- No generic shell or arbitrary Git command passthrough is introduced.
- WorkspaceLens is optimized for reasoning-dense inspection loops, not execution-dense coding loops.

## 1. Version Strategy

The post-v0.1 roadmap is intentionally staged rather than combining all productization work into one release.

```text
v0.1  Core technical path proven
  |
  v
v0.2  Complete the core review context + setup documentation
  |
  v
v0.3  Local Context Control Plane: WebUI + onboarding + multi-workspace lifecycle
  |
  v
v0.4  Workspace targeting + MCP observability
  |
  v
v0.5  Reasoning workflow composition without orchestration
```

The largest expected engineering effort remains v0.3. v0.4 and v0.5 should stay deliberately narrower and must not expand WorkspaceLens into a chat manager, workflow engine, coding harness, or general-purpose MCP runtime.

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

# 3. v0.3 — Local Context Control Plane

## Goal

Turn WorkspaceLens from a command-line setup that a user can make work into a local context service that a developer configures once and can keep available for daily reasoning work.

v0.3 is the main productization release in this roadmap.

The core product model is:

```text
ChatGPT / Reasoning Clients
           |
           | one WorkspaceLens app / MCP connection
           v
WorkspaceLens Local Service
           |
           +--> Workspace A
           +--> Workspace B
           +--> Workspace C
           `--> Workspace N
```

A normal multi-project setup SHOULD use one WorkspaceLens service and one provider connection exposing multiple explicitly authorized workspaces. WorkspaceLens MUST NOT require a separate MCP server, tunnel, or ChatGPT app per workspace by default.

The preferred local product shape is:

```text
Browser
   |
   | localhost-only control UI
   v
WorkspaceLens Local Control Service (Node.js)
   |                |
   |                +--> provider integration / tunnel lifecycle
   |
   +--> shared application services
            |
            v
      WorkspaceLens Core
            |
            v
   Authorized Workspaces
```

The WebUI is the control plane for local context connectivity. It is not a hosted web product, chat interface, IDE, code browser, or AI workflow manager.

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

The Local Control Service should own product-level local operations required by the UI while reusing the same underlying application services as the CLI.

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

## 3.3 Minimum WebUI Responsibilities

The initial WebUI should remain intentionally small.

### Workspace management

The user can:

- view all configured workspaces;
- add a local workspace through a folder-selection flow appropriate to the platform/runtime;
- see its stable logical name/identity and local root;
- see enabled/disabled and validation state;
- enable or disable a workspace;
- remove a workspace authorization;
- see clear errors for invalid or inaccessible roots.

Opaque internal IDs should not be the primary user-facing identity unless required for diagnostics.

### Local service and connection status

The user can see whether:

- WorkspaceLens local service is healthy;
- configuration is valid;
- provider integration is configured or not configured;
- the official tunnel client is available or unavailable;
- the tunnel process is running or stopped;
- tunnel health is healthy/unhealthy where this can be verified reliably.

The UI MUST NOT claim that a particular ChatGPT conversation, Project, or message is connected unless WorkspaceLens can actually verify that fact.

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

A small live status surface MAY expose factual runtime information such as active request count, last request time, last error, or current tunnel state. Historical activity analysis is deferred to v0.4.

## 3.4 Guided Onboarding and Ownership Boundary

v0.3 should convert the current documentation-driven setup into a state-driven onboarding experience while preserving explicit ownership boundaries.

The target flow is:

```text
Start WorkspaceLens
      |
      v
Open local WebUI
      |
      v
Check local prerequisites
      |
      v
Authorize workspace(s)
      |
      v
Configure local tunnel profile
      |
      v
Guide provider-owned account / ChatGPT steps
      |
      v
Verify local connection state
      |
      v
Ready
```

WorkspaceLens-owned steps may be automated by the WebUI.

Provider-owned steps that require the user's OpenAI/ChatGPT account, such as creating provider resources, enabling provider features, creating/selecting the ChatGPT app/connection, or refreshing/scanning tools, should be guided rather than simulated or browser-automated.

The WebUI should make these states explicit, for example:

```text
Local prerequisites      Ready
Workspace configuration  Ready
Tunnel profile           Ready
Provider account setup   Action required
ChatGPT app setup        Action required
Connection               Waiting / Healthy
```

The user should not need to understand MCP transport internals, tunnel profile files, local ports, or process supervision beyond information that the provider explicitly requires them to supply.

## 3.5 Workspace Identity and Optional Reasoning Helpers

Each workspace should have a stable, visible logical identity suitable for use in reasoning environments.

The WebUI MAY provide convenience actions for a selected workspace such as:

- `Copy Project Instructions`;
- `Copy Review Prompt`;
- `Copy Plan Prompt`.

These are optional bootstrap helpers only.

They MUST NOT create workflow state, define mandatory interaction steps, or become a prompt-management product. A user or repository may instead use Project Instructions, `AGENTS.md`, a review/plan skill, `development-flow`, or another reasoning convention.

`Copy Project Instructions` should identify the preferred workspace explicitly and instruct the reasoning client not to guess when the workspace is unavailable or ambiguous.

## 3.6 Daily-use Target

After successful onboarding, normal daily use should not require the user to re-run setup commands or create new provider connections for each project.

The target experience is:

```text
Login / machine start
      -> WorkspaceLens and integration become available
      -> open reasoning chat / Project
      -> ask about an authorized workspace
      -> WorkspaceLens serves current local context
```

Adding another local project should normally mean authorizing another workspace in the WebUI, not creating another MCP server or tunnel.

## 3.7 Autostart / Persistent Availability

Persistent availability is part of the v0.3 product goal, but the implementation should remain minimal and platform-aware.

Requirements:

- provide an explicit user-controlled option to start WorkspaceLens automatically at login;
- do not silently install persistent background behavior without clear user action;
- keep Core independent of OS startup mechanisms;
- treat OS-specific startup integration as a thin adapter around the local product runtime.

A macOS-first implementation is acceptable if cross-platform startup handling would materially delay the release. Core, CLI, configuration, and WebUI contracts should remain portable.

## 3.8 Local WebUI Security Requirements

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

## 3.9 Multi-workspace Concurrency and Isolation

A single WorkspaceLens service may receive concurrent requests for different authorized workspaces from different chats or reasoning clients.

Therefore:

- every content-bearing operation MUST resolve access from an explicit workspace identity;
- WorkspaceLens MUST NOT maintain a mutable global `current workspace` or `recent workspace` that changes MCP behavior;
- filesystem roots, Git working directories, access-policy evaluation, output bounds, and errors MUST remain request/workspace scoped;
- concurrent requests targeting different workspaces MUST NOT leak or cross-contaminate state.

v0.3 should include automated concurrency/isolation coverage for multiple workspaces.

## 3.10 CLI Compatibility

The CLI remains a supported interface for advanced users and automation.

v0.3 should not force users to use the WebUI for operations that already have stable CLI equivalents.

The CLI and WebUI should converge on the same underlying state and semantics.

## 3.11 v0.3 Non-goals

Do not add:

- Electron solely to host the WebUI;
- a custom chat UI;
- ChatGPT conversation/session management;
- source-code browsing/editing UI;
- diff viewer as a primary product surface;
- review history database;
- CR/Plan completion analytics;
- task management UI;
- `.agent/tasks` workflow UI;
- coding-harness control;
- remote browser-accessible administration;
- cloud-hosted WorkspaceLens control plane;
- automatic ChatGPT Project mapping;
- a separate tunnel/server per workspace by default;
- agent orchestration;
- prompt-library/version-management features.

## 3.12 v0.3 Engineering Risk Areas

The main expected engineering effort is concentrated here:

1. defining a shared application-service layer used by both CLI and WebUI without duplicating Core rules;
2. safely exposing local state-changing operations through a browser-facing localhost API;
3. supervising the official tunnel client reliably across start/stop/crash/restart cases;
4. modeling connection state honestly without claiming provider-side state that cannot be observed;
5. adding login/autostart behavior without coupling Core to OS-specific process management;
6. packaging the Node runtime, UI assets, tunnel integration, and startup behavior into a repeatable installation experience;
7. preserving an easy uninstall/disable path and avoiding hidden persistent processes;
8. maintaining request-scoped workspace isolation under concurrent multi-workspace access.

These are v0.3's central productization problems. Visual design sophistication is secondary.

## 3.13 v0.3 Acceptance Criteria

v0.3 is complete when:

1. A user can open a local WebUI without manually editing WorkspaceLens configuration files.
2. A user can add, inspect, disable/enable, and remove multiple authorized workspaces from that UI.
3. One normal WorkspaceLens service/provider connection can expose multiple authorized workspaces without per-workspace tunnel setup.
4. CLI and WebUI operate on the same configuration and authorization semantics.
5. A user can understand current local service and tunnel integration state from the UI.
6. WorkspaceLens can manage the expected tunnel-client lifecycle without reimplementing the tunnel protocol.
7. Provider-owned setup steps are clearly identified and guided without unsupported automation.
8. Normal daily usage no longer requires manually starting multiple commands in the expected supported setup.
9. Autostart can be explicitly enabled and disabled where the release supports it.
10. The WebUI can expose stable workspace identity and optional Project Instructions / Review / Plan prompt helpers without introducing workflow state.
11. Concurrent requests for different workspaces remain isolated and no global active-workspace state affects tool behavior.
12. The local WebUI is loopback-only by default and protected against arbitrary cross-origin state-changing requests.
13. WorkspaceLens Core remains independent of WebUI, HTTP transport, ChatGPT, tunnel-client lifecycle, and OS startup mechanisms.

---

# 4. v0.4 — Workspace Targeting and MCP Observability

## Goal

Reduce workspace-selection friction for high-frequency projects and make the local context connection observable without turning WorkspaceLens into a ChatGPT conversation manager or workflow analytics product.

## 4.1 Workspace Targeting Model

The recommended convention for high-frequency projects is:

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

### Project Instructions convention

Document a recommended Project Instructions pattern that identifies the preferred WorkspaceLens workspace for that Project.

Example concept:

```text
Use WorkspaceLens workspace `workspace-lens` for local repository context in this Project.
If the workspace is unavailable or ambiguous, do not guess; inspect the available workspaces first.
```

The exact wording may evolve.

The v0.3 `Copy Project Instructions` helper is a convenience for establishing this convention. It does not establish a technical ChatGPT Project binding.

### Natural name matching

When the user or Project Instructions names a workspace, the reviewer may select a unique exact logical match from `workspace_list`.

WorkspaceLens should not implement a fuzzy Project-name matching engine merely to remove occasional naming friction.

### Ambiguity behavior

If multiple authorized workspaces exist and no unique workspace can be determined, the reviewer should inspect `workspace_list` and ask or require explicit selection rather than guessing.

### Ordinary Chat behavior

Ordinary chats remain supported. The user can explicitly name the workspace in the request.

## 4.2 MCP Activity / Access Log

v0.4 may add a bounded local activity log for factual observability of WorkspaceLens MCP and connection behavior.

Useful event facts include, where available and safe:

- timestamp;
- request/event identifier;
- workspace identity;
- MCP tool name;
- success/failure;
- bounded error category;
- request duration;
- response size or truncation indicator;
- tunnel disconnect/reconnect or lifecycle event.

Example conceptual view:

```text
17:32:11  daily-signals  git_compare  OK     382 ms
17:32:13  daily-signals  read_file    OK      42 ms
17:33:04  tunnel                       disconnected
17:33:08  tunnel                       reconnected
```

The activity log exists to answer operational questions such as:

- Did the reasoning client actually call WorkspaceLens?
- Which workspace was accessed?
- Which tool failed?
- Was the tunnel disconnected?
- Was a request unusually slow or truncated?

### Observability boundary

Activity data MUST remain factual.

WorkspaceLens MUST NOT infer from tool-call patterns that:

- a code review started or completed;
- a plan started or completed;
- a review passed/failed;
- a task is complete;
- a particular ChatGPT conversation owns the activity.

Metrics such as `CRs this week`, `plans completed`, or `review success rate` are out of scope unless a future explicit workflow protocol provides those facts. v0.4 does not introduce such a protocol.

Retention should be bounded and local. Secrets and sensitive content must not be copied into activity records.

## 4.3 Workspace Context Summary

The WebUI MAY expose lightweight factual context for each workspace, for example:

- logical workspace name;
- local path where appropriate;
- enabled/disabled state;
- Git repository validity;
- current branch;
- current HEAD identifier;
- clean/dirty working-tree summary;
- last MCP access time.

This is context/status visibility, not a source-code browser or diff viewer.

## 4.4 Security / Exposure Visibility

If it can be implemented using existing policy facts without creating a second security model, the WebUI MAY show a concise effective-access summary such as:

```text
Repository access   READ ONLY
Git context         Enabled
Sensitive paths     Protected
Credentials/keys    Protected
```

A simple `why unavailable?` explanation for policy-blocked paths is useful if it reuses the existing AccessPolicy result and does not expose protected content.

A general policy editor is not required by v0.4.

## 4.5 Security Boundary

Project organization MUST NOT be presented as workspace authorization isolation.

A recommendation that Project A normally uses Workspace A does not imply that the underlying WorkspaceLens connection is technically incapable of accessing other enabled workspaces.

If stricter isolation becomes a demonstrated need, it should be designed as a WorkspaceLens connection-authorization scope independent of ChatGPT Project IDs.

## 4.6 v0.4 Non-goals

Do not add:

- ChatGPT Project IDs to WorkspaceLens Core;
- ChatGPT chat IDs to WorkspaceLens Core;
- ChatGPT conversation lifecycle synchronization;
- a local chat/session manager;
- fuzzy Project/workspace matching;
- global `recent workspace` state that silently changes behavior across chats;
- Project-based access-control claims that WorkspaceLens cannot enforce;
- a second tunnel per Project by default;
- mandatory one-workspace-per-Project enforcement;
- CR/Plan completion analytics;
- review outcome analytics;
- source browser or diff viewer;
- workflow/task state derived from MCP logs.

## 4.7 Acceptance Criteria

v0.4 is complete when:

1. The recommended one-local-workspace-to-one-high-frequency-Project convention is clearly documented.
2. A Project can establish its preferred workspace through instructions without Core knowing anything about the Project.
3. Ordinary chats can continue to select workspaces explicitly.
4. Ambiguous workspace selection results in explicit discovery/selection rather than fuzzy guessing.
5. Product documentation clearly distinguishes Project organization from WorkspaceLens authorization scope.
6. Users can inspect bounded factual MCP/connection activity sufficient to diagnose which workspace/tool was accessed and whether it succeeded.
7. Activity logging does not infer review, planning, task, or conversation semantics.
8. The WebUI can show useful workspace context/status without becoming a code browser.

---

# 5. v0.5 — Reasoning Workflow Composition

## Goal

Document and, where repeated user friction justifies it, package lightweight reasoning helpers that compose WorkspaceLens context with existing project processes without turning WorkspaceLens into an orchestrator.

v0.5 is intentionally conditional and mostly outside WorkspaceLens Core.

## 5.1 Workload Boundary

WorkspaceLens is designed for reasoning-dense inspection loops:

```text
Inspect repository facts
        |
        v
Reason
        |
        v
Inspect additional evidence
        |
        v
Conclude / produce a plan or review
```

Typical suitable workloads include:

- code review;
- requirement audit;
- architecture review;
- implementation planning;
- regression/risk analysis;
- repository understanding.

WorkspaceLens is not designed to replace execution-dense coding harness loops:

```text
Inspect
  |
  v
Change
  |
  v
Execute / build / test
  |
  v
Observe
  |
  `----> repeat
```

Implementation, debugging, test execution, iterative refactoring, and build/fix loops belong to Codex, Claude Code, Zcode, IDE agents, or other local coding harnesses.

This distinction is about workload shape, not a claim that reasoning tasks require no loop. Review and planning use inspection/reasoning loops; coding uses write/execute/observe loops.

## 5.2 Responsibility Model

The intended long-term composition is:

```text
WorkspaceLens                     = Context
Project Instructions / Skill      = Reasoning behavior
Repository process / human        = Process
Coding harness                    = Execution
```

`development-flow` is one reference process integration, not a required dependency of WorkspaceLens.

These layers should compose through repository state and prompts/skills rather than through a WorkspaceLens orchestration protocol.

## 5.3 WorkspaceLens Responsibility

WorkspaceLens continues to provide safe read-only access to repository facts, including source files, search, workspace metadata, Git state, and review-relevant Git history/ranges.

WorkspaceLens does not know whether the current activity is a CR, plan, architecture review, requirement audit, or another reasoning task.

It does not own task phases, completion state, review outcome, or builder execution state.

## 5.4 Optional Reasoning Helpers

The v0.3 Review Prompt and Plan Prompt remain optional bootstrap conveniences.

If repeated real-world friction demonstrates that reusable reasoning behavior deserves packaging, a future independent skill MAY define behavior for activities such as:

- code review;
- architecture review;
- requirement audit;
- implementation-plan review;
- regression/risk analysis;
- test-gap and false-green analysis;
- handoff summarization.

Such a skill:

- should remain usable with other context sources such as GitHub, uploaded diffs, or another read-only repository connector;
- should not require WorkspaceLens as a hard dependency;
- should not duplicate project workflow state or gates;
- should not become mandatory merely because WorkspaceLens reaches v0.5.

If Project Instructions, repository instructions, or an existing review/plan skill already solve the problem, WorkspaceLens should not create another competing source of truth.

## 5.5 Reference Process Integration: development-flow

When a repository uses `development-flow`, that system continues to own persistent engineering protocol and task state such as `.agent/tasks/<task-id>` contracts, gates, state, and evidence.

Those task files are ordinary repository state and can be inspected through WorkspaceLens like any other authorized non-sensitive repository files.

No dedicated `development-flow` API is required merely to make the systems work together.

A reasoning helper may understand or summarize those files, but WorkspaceLens Core does not implement their state machine.

## 5.6 Project Instructions

Project Instructions may provide stable project-level preferences such as:

- preferred WorkspaceLens workspace;
- project-specific review emphasis;
- stable project constraints that belong in the reasoning environment.

They should not become the durable store of task state when the repository already has a process/state mechanism.

## 5.7 Human Handoff Remains the Boundary

The final reviewer/planner conclusion continues to be transferred to the Builder by the user.

WorkspaceLens v0.5 MUST NOT automatically forward reasoning output to Codex, Claude Code, Zcode, an IDE, or another coding harness.

A skill or prompt may produce a concise handoff block for the user to copy, but it must not execute or transmit the handoff automatically.

## 5.8 v0.5 Non-goals

Do not add:

- agent-to-agent messaging;
- reviewer -> builder automatic execution;
- shared runtime task state between ChatGPT and coding harnesses;
- acknowledgement/retry protocols;
- automatic review/implementation loops;
- C2C orchestration;
- WorkspaceLens-specific workflow state;
- mandatory Reviewer/Planner Skill packaging;
- duplicated project-process gates;
- dynamic test/build execution through WorkspaceLens;
- CR/Plan semantic session tracking inside WorkspaceLens.

## 5.9 Acceptance Criteria

v0.5 is complete when:

1. The reasoning-dense inspection loop and execution-dense implementation loop are documented as distinct product workloads.
2. WorkspaceLens, optional reasoning helpers, repository process, and coding harness have documented non-overlapping responsibilities.
3. WorkspaceLens remains unaware of CR/Plan/task semantic state.
4. A repository process such as `development-flow` can be inspected through normal WorkspaceLens read operations without a dedicated integration protocol.
5. Any packaged reasoning behavior remains reusable independently of WorkspaceLens and does not duplicate workflow state.
6. Reviewer/planner conclusions can be formatted for handoff while final transfer remains an explicit user action.
7. If no repeated user friction justifies a dedicated skill, v0.5 may remain primarily a composition/documentation release rather than adding product surface area.

---

# 6. Cross-Version Invariants

The following requirements apply to every version in this roadmap.

## 6.1 No Agent Orchestration

Do not introduce an event bus, reviewer/builder protocol, shared execution state, automatic forwarding, or autonomous review/implementation loop.

## 6.2 No Write Expansion in WorkspaceLens Core

WorkspaceLens remains a read-only context product. Product-control operations such as adding/removing authorized workspace entries or starting/stopping the local integration runtime belong to the local control/configuration layer and do not grant the MCP reasoning client write access to repository contents.

## 6.3 One Service, Many Workspaces

A normal WorkspaceLens deployment may expose multiple explicitly authorized workspaces through one service/provider connection.

Do not create per-workspace MCP servers, tunnels, or provider apps by default merely to support multiple projects.

## 6.4 No Conversation Ownership

WorkspaceLens does not own or model ChatGPT chats, conversation IDs, Project IDs, review sessions, or plan sessions.

Provider-side conversation organization remains provider-side state.

## 6.5 Explicit Workspace Identity

Content-bearing operations must resolve against an explicit authorized workspace identity.

Do not add hidden global `current workspace`, `recent workspace`, or similar state that can silently redirect requests from different chats.

## 6.6 Concurrent Workspace Isolation

Concurrent requests targeting different workspaces must remain isolated in filesystem root, Git working directory, access-policy evaluation, output handling, and errors.

Concurrency must not weaken workspace authorization boundaries.

## 6.7 Observability Must Be Factual

WorkspaceLens may record bounded MCP tool and connection activity.

It must not infer CR completion, plan completion, review outcome, task state, or conversation ownership from tool-call patterns.

## 6.8 Provider Independence Remains Architectural

ChatGPT is the first and most developed reasoning surface, but WorkspaceLens Core contracts must not require ChatGPT-specific Project, chat, tunnel, or account concepts.

Provider-specific onboarding and lifecycle adapters stay outside Core.

## 6.9 Harness Independence Remains Architectural

Codex, Claude Code, Zcode, IDEs, and humans remain interchangeable builders as long as they modify the same local workspace.

WorkspaceLens must not require a particular execution harness.

## 6.10 Prefer Explicit Behavior over Hidden State

Explicit workspace identity, repository-persisted facts, visible connection state, and explicit user handoff are preferred over implicit session memory or cross-client synchronization.

## 6.11 Add Complexity Only after Observed Friction

Potential features such as per-connection workspace scopes, richer security-policy UI, Windows-native startup integration, additional reasoning skills, or deeper process integrations should be promoted into committed requirements only when the current simpler model creates a demonstrated recurring problem.

A small control-plane product is acceptable. Feature count is not a success criterion.

---

# 7. Priority Summary

| Version | Primary Outcome | Engineering Weight |
| --- | --- | --- |
| v0.2 | Complete local Git review context and make setup reproducible | Small / focused |
| v0.3 | Local Context Control Plane: WebUI, onboarding, multi-workspace management, connection lifecycle, identity | **Largest** |
| v0.4 | Stable workspace targeting plus factual MCP/connection observability | Small / medium, UX + diagnostics focused |
| v0.5 | Compose Context + Reasoning + Process + Execution without orchestration | Small / conditional, mostly outside Core |

The immediate implementation focus after v0.2 is v0.3.

The central v0.3 engineering risks are local-control security, provider lifecycle integration, reliable daily availability, and concurrent multi-workspace isolation.

The primary roadmap constraint after v0.3 is scope discipline: WorkspaceLens should become a dependable local context control plane for reasoning clients, not a general coding-agent runtime or workflow platform.

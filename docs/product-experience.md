# WorkspaceLens Product Experience

Status: Product contract for MVP (`v0.1`).

This document defines the intended user experience, interaction model, and product boundaries of WorkspaceLens.

It complements the technical contracts in `security-model.md` and `mcp-tools-spec.md`. Where those documents define what WorkspaceLens is allowed to do, this document defines what the product should feel like to use.

## 1. Product Thesis

WorkspaceLens solves one narrow problem:

> Give a high-reasoning AI chat accurate, safe, read-only access to the developer's real local workspace.

WorkspaceLens is not a coding agent, task orchestrator, message bus, or synchronization layer between AI products.

The durable product model is provider- and harness-agnostic:

- A builder changes code in the local workspace. The builder may be Codex, Claude Code, an IDE, another coding harness, or the developer directly.
- A high-reasoning chat reviews, analyzes, and discusses the real local state. ChatGPT is the first target surface, not the permanent product boundary.
- WorkspaceLens gives the reviewer safe read-only visibility into that state.
- The human decides what conclusions should be handed back to the builder.

A useful mental model is:

```text
Coding harness / IDE   = Builder
Reasoning chat         = Reviewer / Thinker
WorkspaceLens          = Eyes
Local workspace        = Shared source of truth
User                   = Decision boundary
```

The central product principle is:

> **WorkspaceLens automates context transfer, not decision transfer.**

## 2. Target End-State Experience

The desired daily experience is not an MCP workflow. It is a normal chat workflow.

A developer should be able to open a supported reasoning chat and say:

```text
Review the current uncommitted changes in workspace-lens.
Focus on architecture risks and potential bugs.
```

The reviewer should then be able to obtain the required context through WorkspaceLens:

```text
workspace_list
    -> git_status
    -> git_diff
    -> search_workspace
    -> read_file
    -> discussion with user
```

The user should not need to:

- upload a ZIP
- push code to GitHub
- copy a diff into the chat
- explain the repository structure manually
- initialize a review session
- synchronize coding-harness state
- create task IDs
- understand MCP transport details
- configure a domain or reverse proxy

The product succeeds when local workspace access feels like a capability already present in the chat.

## 3. A Chat Window Is Required

WorkspaceLens must preserve an interactive chat as the primary review surface.

The intended product is not:

```text
workspace-lens review
-> static report
```

The important workflow is interactive reasoning:

```text
User <-> Reviewer Chat
          |
          | read-only context
          v
     WorkspaceLens
          |
          v
   Local Workspace
```

The user must be able to:

- ask follow-up questions
- challenge a recommendation
- compare alternatives
- ask the model to inspect additional files
- refine constraints
- reject part of a review
- converge on a final implementation recommendation

The value is not only automated code inspection. It is the combination of **real workspace context + high-quality interactive reasoning**.

## 4. First-Time Setup vs Daily Usage

WorkspaceLens should distinguish between one-time platform setup and normal daily use.

### 4.1 First-Time Setup

The target experience is approximately:

```bash
install WorkspaceLens
workspace-lens add ~/code/my-project
workspace-lens connect chatgpt
```

The exact command names may change, but the conceptual steps should remain:

1. Install WorkspaceLens.
2. Explicitly authorize one or more local workspace roots.
3. Connect WorkspaceLens to the chosen reasoning client once.
4. Complete any provider account or connector authorization that WorkspaceLens cannot perform on the user's behalf.

WorkspaceLens should hide implementation concepts such as:

- MCP transport selection
- tunnel process details
- tunnel IDs where possible
- runtime lifecycle
- localhost ports
- connector health checks

If a provider requires the user to complete a browser-based authorization step, WorkspaceLens should guide the user to that step rather than inventing an additional configuration system.

### 4.2 Daily Usage

The product goal is **zero initialization for normal use**.

After initial setup, the user should not need to run a chain of setup commands before every review.

A long-running local service or equivalent lifecycle mechanism may keep WorkspaceLens available between sessions.

Normal usage should look like:

```text
Open reasoning chat
-> ask about an authorized workspace
-> discuss the result
```

No per-review session initialization is part of the product model.

## 5. Workspace Model

WorkspaceLens should be modeled as one local service managing multiple explicitly authorized workspaces, not one MCP server per project.

Example:

```text
WorkspaceLens
├── ~/code/workspace-lens
├── ~/code/appshot
└── ~/code/j-store
```

Authorization remains explicit and workspace-scoped.

Internally, each workspace may have a stable `workspace_id`, but users should normally interact with human-readable workspace names.

The user should not need to know or manage opaque workspace IDs.

The preferred UX is:

```bash
workspace-lens add ~/code/workspace-lens
```

not:

```bash
workspace-lens register --id workspace-lens-a31f --root ...
```

The MCP contract may use `workspace_id` for safety and precision while the product layer hides that implementation detail.

## 6. Reviewer and Builder Are Intentionally Separate

WorkspaceLens does not try to merge a coding harness and reasoning chat into one agent system.

The expected workflow is:

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
Reviewer Chat
   |
   | discussion
   v
User
   |
   | intentional handoff
   v
Builder
```

This separation is intentional.

The builder owns execution:

- editing files
- running commands
- tests
- implementation

The reviewer chat owns reasoning:

- architecture analysis
- code review
- risk analysis
- debugging discussion
- design alternatives

WorkspaceLens owns only local read-only context.

## 7. Handoff Back to the Builder Is Manual by Design

The final reviewer conclusion should not automatically trigger code changes.

For the MVP, the user manually transfers the final recommendation back to the coding harness, typically by copy/paste.

This is not considered a missing transport feature. It is a deliberate human approval boundary.

Automatic reviewer-to-builder transfer would immediately introduce questions such as:

- Which message is the final instruction?
- Are intermediate ideas executable?
- Which recommendations has the user rejected?
- Does the builder need acknowledgements or task state?
- Should execution results be sent back to the reviewer?
- Is another review cycle automatic?

Those questions lead toward task synchronization, state machines, and agent orchestration, which are outside the WorkspaceLens product.

Therefore the MVP MUST NOT introduce:

- automatic reviewer -> builder message forwarding
- coding-harness task creation
- review/execution state synchronization
- execution acknowledgements
- automatic review loops

A later lightweight feature MAY help format a final review into a concise handoff block, but this should remain user-controlled and should not execute or transmit anything automatically.

## 8. Clipboard and Local Write Actions Are Not MVP Features

A tool such as:

```text
copy_to_clipboard(text)
```

would save very little interaction while weakening the read-only security story.

WorkspaceLens should not gain local side effects merely to eliminate one copy operation.

For the MVP:

- no clipboard writes
- no file writes
- no local note creation
- no handoff file generation
- no command execution

The value is safe context access, not automation of every adjacent action.

## 9. ChatGPT Connection and Secure Tunnel

### 9.1 Durable Product Decision

The user should not need to own or configure a domain or subdomain in order to use WorkspaceLens with ChatGPT.

Tunnel infrastructure is an integration detail, not a core user concept.

WorkspaceLens Core should remain independent of any specific tunnel implementation.

Conceptually:

```text
Chat Provider
   |
Connection / Tunnel Integration
   |
WorkspaceLens Core
   |
Authorized Workspaces
```

The core MCP tools, workspace model, and security policy must not depend on a public hostname.

### 9.2 Current Platform Assumption

As of the current ChatGPT MCP integration model, ChatGPT does not directly connect to a developer-machine `localhost` MCP server. OpenAI documents Secure MCP Tunnel as the supported way to connect local or private MCP servers without exposing them directly to the public internet.

Reference:

- https://help.openai.com/en/articles/12584461-developer-mode-and-full-mcp-connectors-in-chatgpt-beta

This is a platform assumption, not a permanent WorkspaceLens architectural requirement. If OpenAI later provides a simpler local transport, WorkspaceLens should adopt it without changing the Core contracts.

Other MCP-capable clients may use different connection mechanisms. Those differences belong in integration modules rather than Core.

## 10. Tunnel Complexity Should Be Hidden

The desired ChatGPT setup command is conceptually:

```bash
workspace-lens connect chatgpt
```

not a manual multi-step infrastructure tutorial.

The integration layer may internally:

- verify WorkspaceLens is running
- verify the official tunnel runtime is available
- start or supervise the tunnel runtime
- check connectivity and health
- guide the user through required provider authorization

WorkspaceLens should prefer the official OpenAI Secure MCP Tunnel implementation rather than reimplementing the tunnel protocol.

The Core remains independent:

```text
WorkspaceLens Core
- Workspace Manager
- AccessPolicy
- MCP Tools
- Filesystem Adapter
- Git Adapter

Provider Integrations
- connection lifecycle
- connector setup guidance
- health checks
```

## 11. Interaction Surface

WorkspaceLens itself should not build a browser or chat UI for the MVP.

The preferred experience is to reuse an existing reasoning-chat surface.

Current ChatGPT desktop products provide a built-in browser in Work and Codex on macOS and Windows. This creates a potentially useful interaction surface for keeping development and web discussion close together.

Reference:

- https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app

However, WorkspaceLens MUST NOT depend on a specific embedded-browser workflow.

The supported mental model should remain valid whether the reviewer chat is opened in:

- a normal web browser
- ChatGPT desktop
- a built-in browser surface
- another MCP-capable AI client in the future

An embedded ChatGPT page inside a coding environment may be a useful workflow if it works reliably, but it is an integration convenience rather than a Core feature.

## 12. Product Non-Goals

WorkspaceLens MVP explicitly does not include:

- a custom chat UI
- a custom browser
- browser automation
- coding-harness integration protocol
- coding-harness state synchronization
- reviewer/builder shared task state
- automatic message forwarding
- automatic implementation
- agent planning/execution loops
- write-capable MCP tools
- arbitrary shell access
- workspace modification
- cloud repository synchronization
- mandatory GitHub usage
- mandatory domains or subdomains

These exclusions are product decisions, not temporary missing features.

They should only be reconsidered if real user evidence shows that a specific omission materially blocks the core review workflow.

## 13. Product Acceptance Criteria

The MVP product experience is successful when all of the following are true:

1. A user can explicitly authorize a local repository without exposing unrelated local files.
2. The user does not need to push local changes to GitHub before review.
3. The user does not need to manually paste project files or diffs into the reviewer chat.
4. A supported reviewer can inspect project structure, files, search results, Git status, and local diffs through the defined read-only tools.
5. The user can conduct a normal multi-turn review conversation.
6. The user does not need to initialize a review state machine or synchronize builder context.
7. After one-time setup, ordinary review sessions require no WorkspaceLens initialization steps.
8. ChatGPT connection does not require the user to own a custom domain.
9. WorkspaceLens cannot modify the workspace or execute arbitrary commands.
10. Returning the final recommendation to the coding harness remains an explicit user action.
11. Replacing Codex with another builder does not require changes to WorkspaceLens Core.
12. Supporting another MCP-capable reasoning client does not require changes to WorkspaceLens Core tool contracts.

## 14. Shared State Is the Workspace

The product does not need direct builder-to-reviewer state synchronization for ordinary review.

The workspace itself provides the shared state:

```text
Builder changes code
        |
        v
Workspace state
        |
        | WorkspaceLens reads current state
        v
Reviewer Chat
```

A builder can be replaced without an adapter as long as it changes the same local files and Git repository.

This is an important simplicity property. WorkspaceLens should not add harness adapters merely to know how the code was changed.

## 15. Open Product Decisions

Two product questions remain intentionally unresolved. They must not be solved by introducing hidden state synchronization before the MVP workflow is tested.

### 15.1 Active workspace ambiguity

If multiple workspaces are authorized and the user says:

```text
Review my current project.
```

WorkspaceLens cannot inherently know which repository a separate coding harness currently has open.

For the MVP, acceptable behavior includes:

- the user names the workspace in the conversation, or
- the reviewer calls `workspace_list` and asks/selects when necessary.

The product MUST NOT add Codex/Claude Code/IDE state synchronization solely to remove this small ambiguity.

If user evidence later shows that active-workspace selection is a meaningful recurring friction, it may be solved as an explicit product feature.

### 15.2 Connection authorization scope

One local daemon may manage several authorized workspaces, for example personal, open-source, and company projects.

It is not yet decided whether a single remote connector should automatically see all registered workspaces or only an explicitly selected subset.

This must be treated as a security/product decision rather than a daemon implementation detail.

The architecture should therefore preserve the distinction between:

```text
Daemon lifecycle
!=
Connection authorization scope
```

A later stricter scoping model must be possible without changing WorkspaceLens Core tool semantics.

## 16. Decision Summary

The MVP product should optimize for this workflow:

```text
Builder changes code
        |
        v
Real local workspace
        |
        | WorkspaceLens: safe read-only context
        v
High-reasoning reviewer chat
        |
        | interactive discussion
        v
Human decision
        |
        | manual handoff
        v
Builder continues implementation
```

The simplicity is intentional.

WorkspaceLens should be a small, trustworthy bridge between local code and reasoning models, not the beginning of another agent orchestration framework.

The durable boundaries are:

> **Core is chat-provider agnostic.**
>
> **Core is coding-harness agnostic.**
>
> **Workspace is the integration boundary and shared source of truth.**
>
> **WorkspaceLens automates context transfer, not decision transfer.**

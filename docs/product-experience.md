# WorkspaceLens Product Experience

Status: Product contract for MVP (`v0.1`).

This document defines the intended user experience, interaction model, and product boundaries of WorkspaceLens.

It complements the technical contracts in `security-model.md` and `mcp-tools-spec.md`. Where those documents define what WorkspaceLens is allowed to do, this document defines what the product should feel like to use.

## 1. Product Thesis

WorkspaceLens solves one narrow problem:

> Give a high-reasoning AI chat accurate, safe, read-only access to the developer's real local workspace.

WorkspaceLens is not a coding agent, task orchestrator, message bus, or synchronization layer between AI products.

The product should remain deliberately simple:

- Codex or an IDE builds and changes code.
- A high-reasoning ChatGPT conversation reviews, analyzes, and discusses the real local state.
- WorkspaceLens gives the reviewer safe read-only visibility into that state.
- The human decides what conclusions should be handed back to the coding agent.

A useful mental model is:

```text
Codex / IDE        = Builder
ChatGPT / Sol      = Reviewer / Thinker
WorkspaceLens      = Eyes
User               = Decision boundary
```

The central product principle is:

> **WorkspaceLens automates context transfer, not decision transfer.**

## 2. Target End-State Experience

The desired daily experience is not an MCP workflow. It is a normal chat workflow.

A developer should be able to open ChatGPT and say:

```text
Review the current uncommitted changes in workspace-lens.
Focus on architecture risks and potential bugs.
```

ChatGPT should then be able to obtain the required context through WorkspaceLens:

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
- synchronize Codex state
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
3. Connect WorkspaceLens to ChatGPT once.
4. Complete any OpenAI account or connector authorization that WorkspaceLens cannot perform on the user's behalf.

WorkspaceLens should hide implementation concepts such as:

- MCP transport selection
- tunnel process details
- tunnel IDs where possible
- runtime lifecycle
- localhost ports
- connector health checks

If the platform requires the user to complete a browser-based authorization step, WorkspaceLens should guide the user to that step rather than inventing an additional configuration system.

### 4.2 Daily Usage

The product goal is **zero initialization for normal use**.

After initial setup, the user should not need to run a chain of setup commands before every review.

A long-running local service or equivalent lifecycle mechanism may keep WorkspaceLens available between sessions.

Normal usage should look like:

```text
Open ChatGPT
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

WorkspaceLens does not try to merge Codex and ChatGPT into one agent system.

The expected workflow is:

```text
Codex / IDE
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
ChatGPT Reviewer
   |
   | discussion
   v
User
   |
   | intentional handoff
   v
Codex / IDE
```

This separation is intentional.

Codex or the IDE owns execution:

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

## 7. Handoff Back to Codex Is Manual by Design

The final reviewer conclusion should not automatically trigger code changes.

For the MVP, the user manually transfers the final recommendation back to Codex or another coding agent, typically by copy/paste.

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

- automatic ChatGPT -> Codex message forwarding
- Codex task creation
- review/execution state synchronization
- execution acknowledgements
- automatic review loops

A later lightweight feature MAY help format a final review into a concise **Codex Handoff** block, but this should remain user-controlled and should not execute or transmit anything automatically.

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
ChatGPT
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

## 10. Tunnel Complexity Should Be Hidden

The desired product command is conceptually:

```bash
workspace-lens connect chatgpt
```

not a manual multi-step infrastructure tutorial.

The integration layer may internally:

- verify WorkspaceLens is running
- verify the official tunnel runtime is available
- start or supervise the tunnel runtime
- check connectivity and health
- guide the user through required OpenAI authorization

WorkspaceLens should prefer the official OpenAI Secure MCP Tunnel implementation rather than reimplementing the tunnel protocol.

The Core remains independent:

```text
WorkspaceLens Core
- Workspace Manager
- AccessPolicy
- MCP Tools
- Filesystem Adapter
- Git Adapter

ChatGPT Integration
- tunnel lifecycle
- connector setup guidance
- health checks
```

## 11. Interaction Surface

WorkspaceLens itself should not build a browser or chat UI for the MVP.

The preferred experience is to reuse an existing ChatGPT chat surface.

Current ChatGPT desktop products provide a built-in browser in Work and Codex on macOS and Windows. This creates a potentially useful interaction surface for keeping development and web discussion close together.

Reference:

- https://help.openai.com/en/articles/20001277-using-the-built-in-browser-in-the-chatgpt-desktop-app

However, WorkspaceLens MUST NOT depend on a specific embedded-browser workflow.

The supported mental model should remain valid whether the reviewer chat is opened in:

- a normal web browser
- ChatGPT desktop
- a built-in browser surface
- another MCP-capable AI client in the future

An embedded ChatGPT page inside a Codex/Work browsing surface may be a useful product workflow if it works reliably, but it is an integration convenience rather than a Core feature.

## 12. Product Non-Goals

WorkspaceLens MVP explicitly does not include:

- a custom chat UI
- a custom browser
- browser automation
- Codex integration protocol
- Codex state synchronization
- ChatGPT/Codex shared task state
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
3. The user does not need to manually paste project files or diffs into ChatGPT.
4. ChatGPT can inspect project structure, files, search results, Git status, and local diffs through the defined read-only tools.
5. The user can conduct a normal multi-turn review conversation.
6. The user does not need to initialize a review state machine or synchronize Codex context.
7. After one-time setup, ordinary review sessions require no WorkspaceLens initialization steps.
8. ChatGPT connection does not require the user to own a custom domain.
9. WorkspaceLens cannot modify the workspace or execute arbitrary commands.
10. Returning the final recommendation to the coding agent remains an explicit user action.

## 14. Decision Summary

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

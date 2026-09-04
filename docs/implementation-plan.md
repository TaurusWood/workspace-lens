# WorkspaceLens MVP Implementation Plan

Status: Execution plan for MVP (`v0.1`).

This document translates the existing product and technical contracts into an implementation sequence that a coding agent can execute with minimal ambiguity.

It is not a feature wishlist. If an implementation choice conflicts with the contracts below, the contracts win.

## 1. Source of Truth

Before implementation, read these documents in this order:

1. `docs/product-experience.md` — product behavior and interaction boundaries
2. `docs/security-model.md` — mandatory security invariants
3. `docs/mcp-tools-spec.md` — public MCP tool contract
4. `docs/architecture.md` — component boundaries
5. this document — implementation sequence

Do not silently reinterpret a MUST/MUST NOT requirement from the contract documents.

If a contract is technically impossible or internally inconsistent, stop that task and document the conflict before changing behavior.

## 2. MVP Objective

The MVP is complete when a supported reasoning chat can safely inspect an explicitly authorized local workspace and perform a useful interactive review of the current local state.

The required end-to-end path is:

```text
Reasoning Chat
      |
      | MCP
      v
WorkspaceLens
      |
      | read-only
      v
Authorized Workspace
```

For the first product integration:

```text
ChatGPT
   |
Official OpenAI connection/tunnel path
   |
WorkspaceLens
```

The coding harness is not part of this path. Codex, Claude Code, an IDE, or a human may modify the workspace independently.

## 3. Fixed MVP Decisions

Unless a contract is explicitly revised, implementation MUST follow these decisions:

- Language: TypeScript.
- Runtime: Node.js active LTS at implementation time; pin the selected major in repository tooling.
- MCP: current stable official MCP TypeScript SDK.
- Core is independent of ChatGPT, Codex, and provider-specific tunnel protocols.
- One local WorkspaceLens service may manage multiple explicitly authorized workspaces.
- MCP callers cannot add, remove, or change workspace roots.
- All MCP file paths are workspace-relative.
- Workspace content is read-only.
- No arbitrary shell, Git arguments, search-tool arguments, or command execution.
- Search is literal text search in `v0.1`; regex is not part of the public contract.
- Git inspection may use the local Git executable through fixed, validated command templates with `shell: false`.
- OpenAI Secure MCP Tunnel integration should use the official tunnel client rather than reimplementing its protocol.
- Do not change the Core language merely to embed a provider-specific tunnel SDK.

## 4. Non-Goals During Implementation

Do not implement any of the following unless the product contracts are revised first:

- file writes or patches
- clipboard writes
- shell tool
- generic Git tool
- code execution
- dependency installation inside user workspaces
- Codex/Claude Code/Pi adapters
- builder/reviewer message forwarding
- task IDs or agent state machines
- browser automation
- custom chat UI
- AST index
- embeddings/vector database
- dependency graph
- symbol server
- cloud workspace synchronization
- custom tunnel protocol
- plugin framework for hypothetical future providers

Do not create abstractions solely for these future features.

## 5. Target Repository Structure

Use a small modular structure. Exact filenames may vary slightly, but dependency direction should remain equivalent.

```text
src/
  cli/
    index.ts
    commands/
      add.ts
      list.ts
      remove.ts
      serve.ts
      doctor.ts
      connect-chatgpt.ts        # later phase

  config/
    config-store.ts
    config-schema.ts

  core/
    errors.ts
    limits.ts
    workspace-registry.ts
    path-resolver.ts
    access-policy.ts

  adapters/
    filesystem.ts
    search.ts
    git.ts
    project-info.ts

  mcp/
    server.ts
    schemas.ts
    tools/
      workspace-list.ts
      workspace-info.ts
      list-files.ts
      read-file.ts
      search-workspace.ts
      git-status.ts
      git-diff.ts

  integrations/
    openai/
      tunnel.ts                 # only when Gate 0 succeeds

tests/
  security/
  core/
  adapters/
  mcp/
  integration/
```

Dependency direction:

```text
CLI / MCP / Provider Integration
             |
             v
            Core
             |
             v
          Adapters
```

Provider integration MUST NOT be imported by Core or adapters.

MCP tool handlers should contain orchestration and schema translation, not filesystem security logic.

## 6. Execution Rules for the Coding Agent

For every phase:

1. Read the relevant contract sections first.
2. Implement the smallest change that satisfies that phase.
3. Add tests before moving to the next phase.
4. Do not widen a public tool schema without updating `mcp-tools-spec.md`.
5. Do not weaken an AccessPolicy/security rule to make a test pass.
6. Prefer deterministic output so tool behavior is easy to review.
7. Keep local absolute paths out of MCP output unless the explicit configuration option allows them.
8. Keep logs metadata-only; never log file/diff/search bodies by default.
9. Commit by coherent phase or capability, not one giant implementation commit.
10. At the end of each phase, run typecheck and the full test suite accumulated so far.

## 7. Gate 0 — Validate the Real ChatGPT Connection Path

### Purpose

Validate the riskiest external assumption before building the full product: the user's actual ChatGPT/OpenAI account can call a local MCP server through the supported connection path with acceptable reliability.

### Build only

Create a disposable/minimal MCP server exposing one harmless tool:

```text
workspace_list -> [{ name: "connection-test" }]
```

No real workspace reading is required for this gate.

Use the current official OpenAI Secure MCP Tunnel/onboarding path. Do not implement a custom tunnel.

### Validate

From a real ChatGPT chat:

1. Discover the MCP tool.
2. Call it successfully.
3. Repeat calls across multiple messages.
4. Restart the local MCP process and reconnect.
5. Confirm failures are understandable when the local service is stopped.
6. Record the exact account/product prerequisites required for setup.

### Acceptance

Gate 0 passes only when the end-to-end path is repeatably usable on the intended development environment.

### Stop condition

If the official ChatGPT connection path is unavailable to the target account, requires unacceptable prerequisites, or is materially unreliable, do not hide the problem behind a custom production tunnel. Record the result and revisit the product distribution assumption before continuing beyond local Core prototyping.

---

## 8. Phase 1 — Project Scaffold and Contract Test Harness

### Deliverables

- TypeScript project configured in strict mode.
- Selected Node.js LTS major pinned in repository tooling.
- Package scripts for build/typecheck/test.
- Test runner configured.
- Minimal CLI entry point.
- Minimal MCP server entry point.
- Common error/result types matching `mcp-tools-spec.md`.
- Central server limits configuration matching the recommended MVP defaults.

### Required quality

- No application logic in the CLI entry point.
- No provider-specific dependencies in Core.
- Build and tests succeed from a clean checkout.

### Acceptance

```text
install dependencies
-> typecheck passes
-> tests pass
-> minimal local MCP server starts
```

---

## 9. Phase 2 — Local Configuration and Workspace Registry

### Purpose

Implement explicit local authorization before any real MCP file operation exists.

### Deliverables

Local configuration containing at minimum:

```text
config version
workspace_id
name
canonical root
enabled
```

Local CLI capabilities:

```text
workspace-lens add <path>
workspace-lens list
workspace-lens remove <workspace>
```

These are local administrative commands, not MCP tools.

### Rules

- `add` canonicalizes the root before saving it.
- IDs are stable after registration.
- Human-readable names are separate from IDs.
- Duplicate and overlapping roots are rejected or explicitly warned as required by the security contract.
- Missing roots never fall back to a parent directory.
- MCP clients cannot mutate this registry.
- Config writes are allowed because they modify WorkspaceLens's own local configuration, not user workspace content.

### Tests

Cover:

- add/list/remove
- duplicate roots
- unavailable roots
- disabled workspace behavior if implemented in this phase
- stable ID loading
- malformed config fails safely

### Acceptance

An agent can create two temporary repositories, authorize both locally, reload the process, and resolve each by stable `workspace_id` without exposing arbitrary roots through MCP.

---

## 10. Phase 3 — Security Kernel

### Purpose

Implement the security boundary before implementing file/search/Git tools.

### Deliverables

#### `PathResolver`

Responsible only for:

```text
workspace_id
+ workspace-relative path
-> validated canonical local path
```

It must enforce the path and canonical-containment invariants.

#### `AccessPolicy`

One shared policy used by every content-bearing adapter.

It decides whether a workspace-relative path is:

```text
allowed
blocked-sensitive
excluded-generated/dependency
```

#### File classification

Detect and reject unsupported special/binary objects conservatively.

### Mandatory security tests

Implement the acceptance cases from `security-model.md` before proceeding, including at minimum:

- `../` escape
- absolute Unix path
- Windows drive path
- UNC path
- external symlink escape
- internal symlink allowed only when contained
- `.env` blocked
- private key patterns blocked
- `.git` content blocked
- generated/dependency directory exclusions
- inaccessible path handling

### Acceptance

No filesystem or Git adapter may receive a caller-controlled path that has bypassed this layer.

This phase is the security foundation. Do not duplicate path validation independently inside each MCP tool.

---

## 11. Phase 4 — Filesystem Read Tools

Implement in this order:

1. `workspace_list`
2. `list_files`
3. `read_file`

Then expose them through MCP exactly as defined in `mcp-tools-spec.md`.

### `workspace_list`

Use the registry only. Do not scan arbitrary filesystem locations for repositories.

### `list_files`

Requirements:

- deterministic ordering
- bounded depth
- bounded entry count
- blocked entries omitted
- symlink targets do not disclose absolute paths

### `read_file`

Requirements:

- text/regular files only
- hard eligibility file-size ceiling
- bounded returned payload
- line-oriented ranges
- explicit `truncated`
- UTF-8/text behavior defined by contract

### Tests

Test each adapter directly and each MCP handler separately.

MCP tests must prove schema validation occurs before adapter access.

### Acceptance

A real source repository can be listed and read through MCP while blocked/special/out-of-root files remain inaccessible.

---

## 12. Phase 5 — Workspace Search

### Implementation choice for v0.1

Start with a simple internal Node.js literal-search implementation over eligible text files.

Reasons:

- no external binary installation requirement;
- easiest way to guarantee shared AccessPolicy behavior;
- literal-search contract is small;
- implementation can later be replaced with controlled `ripgrep` without changing MCP semantics.

Do not build an index or cache in `v0.1` unless profiling proves it is necessary.

### Requirements

- literal query only
- optional workspace-relative root
- simple validated file pattern
- same AccessPolicy as `read_file`
- bounded preview length
- bounded result count
- deterministic result order
- explicit truncation
- binary files skipped

### Tests

Most important invariant:

> A path blocked from `read_file` cannot leak through search content or previews.

Also test large repositories/trees with server limits to ensure bounded work and output.

### Acceptance

The reviewer can locate a symbol/string in a normal source repository without needing raw regex or shell controls.

---

## 13. Phase 6 — Git Inspection

Implement only:

```text
git_status
git_diff
```

### Git process rules

If using the system Git executable:

- spawn directly with `shell: false`;
- fixed executable selected by WorkspaceLens;
- fixed command templates;
- working directory comes only from an authorized workspace;
- disable pager;
- disable external diff;
- disable textconv where applicable;
- no arbitrary caller-provided Git flags.

### `git_status`

Use machine-readable Git output and parse it into the structured MCP contract.

Apply AccessPolicy before returning paths.

Sensitive blocked changes may contribute to a redacted count but must not disclose blocked paths by default.

### `git_diff`

Support only the contract-defined scopes.

Recommended safe strategy:

1. Determine changed paths using a fixed machine-readable Git operation.
2. Classify each changed path through `AccessPolicy`.
3. Request diff content only for allowed paths using fixed Git templates.
4. Never obtain/return blocked-path diff bodies merely to filter them afterward where this can reasonably be avoided.
5. Enforce the global diff payload ceiling and explicit truncation.

Do not include untracked file contents unless the public contract is explicitly changed to require that behavior.

### Mandatory tests

- staged diff
- unstaged diff
- combined/all scope
- deleted file
- renamed file
- spaces/unusual valid characters in filenames
- blocked `.env` change does not reveal path/body
- oversized diff truncation
- non-Git workspace
- repository-local config cannot cause external diff execution

### Acceptance

A Chat reviewer can inspect current working-tree changes without WorkspaceLens exposing any Git mutation capability.

---

## 14. Phase 7 — Workspace Metadata

Implement `workspace_info` after the core read path is stable.

### Requirements

Return:

- workspace identity/name
- Git detected/branch/head metadata
- best-effort project type/technology inference

Detection must be evidence-based and explicitly marked as inference.

Keep detection intentionally shallow. Examples of acceptable evidence:

```text
package.json
pyproject.toml
go.mod
Cargo.toml
pom.xml
build.gradle
tsconfig.json
```

Do not add AST parsing, package installation, or framework-specific deep inspection.

AccessPolicy applies to detection reads.

### Acceptance

Metadata is useful but cannot cause a review to fail if project type is unknown.

---

## 15. Phase 8 — MCP Contract Completion

### Deliverables

Expose all seven MVP tools:

```text
workspace_list
workspace_info
list_files
read_file
search_workspace
git_status
git_diff
```

### Requirements

- exact public names
- strict schemas with unknown properties rejected
- stable result envelope
- stable application error codes
- no stack traces/raw commands in tool errors
- tool descriptions mark repository content as untrusted data
- no provider-specific semantics in tool schemas

### Contract tests

Build fixture workspaces and test MCP calls end-to-end against them.

At minimum create fixtures for:

```text
normal Git project
non-Git project
sensitive files
external symlink
large file
binary file
large diff
multiple workspaces
```

### Acceptance

All security acceptance criteria and tool-contract cases pass through the MCP boundary, not only at unit-test level.

---

## 16. Phase 9 — Local CLI and Runtime Experience

### Required CLI surface

Keep the user-facing surface small:

```text
workspace-lens add <path>
workspace-lens list
workspace-lens remove <workspace>
workspace-lens serve
workspace-lens doctor
```

The exact aliases may evolve, but avoid exposing implementation knobs by default.

### `doctor`

Check only actionable product prerequisites, for example:

- config readable
- workspace roots available
- Git available where needed
- MCP server can initialize
- provider integration prerequisites when installed

Do not print secrets, runtime API keys, file contents, or verbose environment dumps.

### Runtime lifecycle

First make `serve` reliable in the foreground.

Only after the end-to-end product path is stable, add the smallest supported persistent/autostart mechanism needed to meet the zero-initialization daily UX.

Do not invent a cross-platform service manager framework during initial Core implementation.

### Acceptance

A user can install, add a workspace, start WorkspaceLens, and diagnose common setup failures without editing a configuration file manually.

---

## 17. Phase 10 — ChatGPT Integration

Proceed only if Gate 0 passed.

### Product command

Target the conceptual UX:

```text
workspace-lens connect chatgpt
```

### Responsibilities

The integration may:

- detect whether the official OpenAI tunnel client is installed;
- guide installation through an officially supported path;
- associate/start the local WorkspaceLens MCP process with the official tunnel runtime;
- check tunnel readiness/health;
- open or print the exact OpenAI setup page when user authorization is required;
- explain the remaining manual account step clearly.

### It must not

- reimplement the OpenAI tunnel wire protocol;
- require a user-owned domain/subdomain;
- put OpenAI-specific code in Core;
- store admin credentials when a narrower runtime credential is sufficient;
- log API keys/tokens;
- claim connection success until a real health/readiness check passes.

### Acceptance

After one-time setup, a real ChatGPT conversation can call all seven WorkspaceLens tools against an authorized local repository without the user manually exposing a public MCP endpoint.

---

## 18. Phase 11 — End-to-End Product Validation

Use a real development repository with uncommitted changes.

Validate this exact workflow:

```text
Builder changes code
        |
        v
Local workspace
        |
        v
User opens reviewer chat
        |
        v
"Review the current uncommitted changes in <workspace>."
        |
        v
Reviewer calls WorkspaceLens tools
        |
        v
Multi-turn discussion
        |
        v
User manually hands final conclusion to builder
```

### Scenarios

Validate at minimum:

1. review unstaged changes;
2. review staged changes;
3. inspect related implementation files;
4. search for usages of a changed API;
5. compare architecture implications across several files;
6. blocked sensitive file modified in the same repository;
7. multiple authorized workspaces;
8. local service unavailable/restarted;
9. large diff requiring truncation and follow-up reads;
10. builder is not Codex (change a file manually or with another tool) and reviewer behavior remains identical.

### Record unresolved UX observations

Specifically observe:

- how often users must name the workspace explicitly;
- whether multi-workspace connector scope feels too broad;
- whether tunnel lifecycle is visible/annoying;
- whether manual reviewer-to-builder copy/paste is actually painful;
- whether built-in browser vs normal browser materially affects usability.

Do not implement fixes for these observations during the same validation session. First collect evidence.

---

## 19. Release Gate for `v0.1`

Do not call the project an MVP until all of the following are true:

### Functional

- all seven MCP tools work against real local repositories;
- ChatGPT end-to-end connection works on the documented supported environment;
- local uncommitted changes are reviewable without GitHub push/upload;
- multi-turn review works naturally.

### Security

- every acceptance criterion in `security-model.md` is automated;
- blocked content cannot leak through read/search/diff cross-tool paths;
- no MCP write/exec capability exists;
- no arbitrary command/Git/search argument passthrough exists.

### Product

- installation/setup is documented from a clean machine perspective;
- no custom domain/subdomain is required for the supported ChatGPT path;
- no per-review initialization/state protocol exists;
- manual handoff remains explicit;
- ChatGPT/Codex names do not leak into Core APIs.

### Quality

- typecheck passes;
- full test suite passes;
- fixture-based MCP contract tests pass;
- no workspace content appears in default logs;
- error messages are actionable without leaking host internals.

## 20. Deferred Decisions

Do not resolve these before end-to-end validation provides evidence:

### Active workspace

Current default: user names the workspace when ambiguous.

Do not add harness synchronization to infer it.

### Connection/workspace scope

Keep daemon lifecycle and connection authorization separate in design. Choose the actual scoping UX only after testing multi-workspace usage.

### Search backend

Start with internal literal search. Replace with controlled ripgrep only if profiling shows a real performance problem.

### Persistent runtime

Start foreground-first. Add only the minimum lifecycle/autostart mechanism needed after the connection path is proven.

### Single binary / Go rewrite

Not an MVP concern. Re-evaluate only if installation and tunnel lifecycle evidence shows material benefit.

### Other reasoning providers

Do not build provider adapters now. Preserve Core MCP compatibility so another provider can be added later without changing Core contracts.

### Automatic builder handoff

Explicitly outside MVP. If ever explored, treat it as a separate product/integration layer rather than expanding WorkspaceLens Core.

## 21. Recommended Commit Sequence

A coding agent should prefer a sequence similar to:

```text
1. chore: scaffold TypeScript project and tests
2. feat: add local workspace registry and CLI administration
3. feat: implement path resolver and access policy
4. feat: add workspace listing and filesystem read tools
5. feat: add literal workspace search
6. feat: add safe git status and diff inspection
7. feat: add workspace metadata inference
8. feat: expose complete MCP tool contract
9. feat: add CLI doctor and runtime lifecycle
10. feat: integrate official ChatGPT tunnel flow
11. test: add end-to-end security and MCP fixtures
12. docs: finalize installation and v0.1 usage
```

Each commit should leave the repository buildable and tests passing.

## 22. Definition of Done

WorkspaceLens `v0.1` is done when the user experience can be truthfully summarized as:

> Install once, authorize a workspace, connect a reasoning chat once, then discuss the real local code state without uploading code, synchronizing agents, or giving the chat write access.

Anything beyond that sentence is optional until real usage proves otherwise.

# WorkspaceLens Getting Started

Status: Canonical setup guide for v0.2. It documents the real, verified path from a clean install to a working review conversation — including the current manual lifecycle steps. Lifecycle automation (daemon management, autostart, onboarding wizard) is deliberately deferred to v0.3; nothing here is aspirational.

Two usage paths are supported:

| Path | Reviewer surface | What carries traffic |
| --- | --- | --- |
| **Stdio (local MCP client)** | Any MCP client that can launch a stdio server | The client spawns `workspace-lens serve` itself; no network at all |
| **ChatGPT (Secure MCP Tunnel)** | ChatGPT developer-mode app | The official OpenAI `tunnel-client` connects ChatGPT to your machine and spawns the server |

Step ownership is labeled throughout:

- **[WorkspaceLens]** — a command or file owned by this tool.
- **[OpenAI Platform]** — an account/resource step on platform.openai.com.
- **[ChatGPT]** — a step inside the ChatGPT app.

---

## 1. Prerequisites

- **Node.js 24** (WorkspaceLens pins the Node 24 LTS line in `engines` and `.nvmrc`). Check: `node --version`.
- **Git** on `PATH` (used read-only for `git_status`, `git_diff`, `git_history`, `git_commit`, `git_compare`).
- For the ChatGPT path only:
  - An OpenAI Platform organization with **Tunnels** permission: `Read + Use` to run an existing tunnel, `Read + Manage` to create one. [OpenAI Platform]
  - A runtime API key for the tunnel (`CONTROL_PLANE_API_KEY`). [OpenAI Platform]
  - The official tunnel client from `github.com/openai/tunnel-client/releases/latest`. [OpenAI Platform]
  - ChatGPT **developer mode** enabled for your workspace (Business/Enterprise/Edu; Pro supports read/fetch connectors). [ChatGPT]

GitHub is never required. Workspaces are never uploaded. No custom domain is needed.

## 2. Install and build WorkspaceLens [WorkspaceLens]

From a clean checkout:

```bash
npm install
npm run build
npm link          # optional: puts the `workspace-lens` binary on your PATH
```

`npm link` is optional but recommended; the examples below assume `workspace-lens` is on your PATH. Without it, use `node dist/cli/index.js <command>`.

## 3. Authorize a workspace [WorkspaceLens]

One-time per project:

```bash
workspace-lens add /path/to/your/project --name "My Project"
workspace-lens list
```

- Only explicitly authorized roots are served. Nothing is scanned or registered automatically.
- Workspaces are stored in `~/.config/workspace-lens/config.json` (override with the `WORKSPACE_LENS_CONFIG` environment variable).
- `workspace-lens remove <workspace_id>` de-authorizes a root.

## 4. Check local prerequisites [WorkspaceLens]

```bash
workspace-lens doctor
```

`doctor` verifies Node version, config validity, that each enabled workspace root exists, the `git` executable, and that the MCP server initializes with the full tool contract. It reports the optional `tunnel-client` integration status. Fix anything marked `FAIL` before continuing; no check writes anything or sends anything to the network.

## 5. Configure the OpenAI Secure MCP Tunnel [OpenAI Platform + WorkspaceLens]

Skip this section for stdio-only usage.

**5.1 Create a tunnel [OpenAI Platform]** — one-time: open `platform.openai.com/settings/organization/tunnels`, create a tunnel, and note the `tunnel_id`. Create (or locate) the runtime API key and export it in the shell you will run the tunnel from:

```bash
export CONTROL_PLANE_API_KEY="<runtime key>"
```

**5.2 Install the official tunnel client [OpenAI Platform]** — download a release from `github.com/openai/tunnel-client/releases/latest` so `tunnel-client` is on your PATH.

**5.3 Associate WorkspaceLens with your tunnel [WorkspaceLens]** — one-time:

```bash
workspace-lens connect chatgpt --tunnel-id <your-tunnel-id>
```

This runs the official `tunnel-client init` under the hood, creating a profile named `workspace-lens` that points at the built WorkspaceLens server (`node <dist>/cli/index.js serve`). The command never stores or prints your API key. Re-run it without `--tunnel-id` any time to re-check readiness.

## 6. Start the required processes [WorkspaceLens + OpenAI Platform]

Two processes are involved, and **one command is enough**:

```bash
tunnel-client run --profile workspace-lens
```

(or equivalently `workspace-lens connect chatgpt --run`). Keep this foreground process alive while reviewing; Ctrl-C stops it.

- The tunnel client is the long-lived daemon that talks to OpenAI's tunnel infrastructure.
- The tunnel client **spawns the WorkspaceLens MCP server itself** (from the profile's MCP command). You do not need to run `workspace-lens serve` manually in this path.
- Verify readiness: `workspace-lens connect chatgpt` again — it reports `ok tunnel daemon is running and ready` when the health check passes. [OpenAI Platform]

For the **stdio path**, none of this applies: your MCP client launches `workspace-lens serve` directly, for example:

```json
{
  "mcpServers": {
    "workspace-lens": { "command": "workspace-lens", "args": ["serve"] }
  }
}
```

## 7. Configure the ChatGPT side [ChatGPT]

One-time, in the ChatGPT app:

1. Open `Settings → Connectors` (`chatgpt.com/#settings/Connectors`) and enable **Developer mode**.
2. Create an app.
3. Under **Connection**, choose **Tunnel** and select this machine's tunnel (match the tunnel id printed by `connect chatgpt`).
4. Scan tools. You should see the ten WorkspaceLens tools.

## 8. Verify `workspace_list` from a real chat [ChatGPT]

In a chat with the app attached (or the connector selected), ask:

```text
Call workspace_list and tell me which workspaces are available.
```

A successful `workspace_list` call listing your authorized workspace(s) completes setup. If tools are missing or the call returns nothing, see Troubleshooting.

## 9. First review

With your workspace authorized, ask the reviewer for a normal review. v0.2 covers both committed and uncommitted local state:

```text
Review the local work in <workspace name> that hasn't been pushed yet.
Look at the recent commits, then review the changes against the trusted
base, then check the uncommitted remainder. Focus on correctness risks.
```

The reviewer can discover everything on its own via:

```text
workspace_list → git_history → git_commit → git_compare(base, HEAD)
              → git_status → git_diff → read_file / search_workspace
```

- `git_history` lists recent commits (SHA, parents, subject, author, date).
- `git_commit` inspects one commit against its first parent (empty tree for root commits).
- `git_compare` reviews a range; `merge_base` mode reviews a feature branch against its divergence point without pulling in unrelated base-branch commits.
- `git_status` / `git_diff` cover the uncommitted remainder.
- Local-only commits work exactly like pushed ones — GitHub is never contacted.

Sensitive paths (`.env`, keys, credentials) are redacted everywhere, including inside history.

## 10. Daily usage

After one-time setup there is no per-review initialization:

1. Start the tunnel process when you want to review from ChatGPT (`tunnel-client run --profile workspace-lens`), or let your MCP client spawn `workspace-lens serve` on the stdio path.
2. Open a chat and review. The workspace itself is the shared state; builder tools (Codex, Claude Code, an IDE, or your editor) keep changing it and the reviewer always sees the real current content.
3. Hand conclusions back to the builder yourself. WorkspaceLens never executes or forwards anything.

## 11. Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `doctor` fails on `git` | Install Git or fix your `PATH`; all Git tools fail without it. |
| `connect chatgpt` says no profile exists | First run needs `--tunnel-id <id>`; the id comes from platform.openai.com tunnel settings. [OpenAI Platform] |
| `connect chatgpt` warns `CONTROL_PLANE_API_KEY` is not set | Export the runtime API key in the shell that runs the tunnel. [OpenAI Platform] |
| `tunnel-client doctor` fails | Run `tunnel-client doctor --profile workspace-lens --explain` and follow the official output. [OpenAI Platform] |
| ChatGPT shows no tools or an empty result | The tunnel process is probably not running (restart step 6), the app's tunnel selection points at a different tunnel, or developer mode is off. With the tunnel stopped, ChatGPT may surface an empty tool result rather than an explicit error — check the daemon first. [ChatGPT + OpenAI Platform] |
| Reviewer runs shell commands instead of using the tools | Models with a built-in bash tool sometimes default to it. Attach the WorkspaceLens app to the conversation or name the tools explicitly in the prompt (platform behavior, not a WorkspaceLens defect). |
| `GIT_REVISION_NOT_FOUND` from history tools | The revision syntax is restricted commitish only (`HEAD`, branch, tag, SHA). Ancestry syntax like `HEAD~1` and ranges like `main..HEAD` are intentionally rejected; ask for the history first, then pick SHAs. |
| A file is invisible to the reviewer | Default policy blocks `.env`, keys, credentials, and dependency/build trees everywhere — including inside Git history. This is intentional. |

## Where to read more

- [Product Experience](product-experience.md) — what WorkspaceLens is and is not.
- [Security Model](security-model.md) — the read-only boundary and its limits.
- [MCP Tools Specification](mcp-tools-spec.md) — the complete tool contract.
- [Architecture](architecture.md) — Core/adapter/MCP layering.

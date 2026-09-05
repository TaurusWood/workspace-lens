#!/usr/bin/env bash
# Gate 0 preflight (implementation-plan.md §7).
#
# Validates everything on this machine that can be validated without the
# user's ChatGPT/OpenAI account, then prints the exact account-side steps
# with the server command pre-filled. The full guide lives in the README
# section "ChatGPT Connection (Gate 0)".
#
# This script is disposable validation tooling for Gate 0. It is not part
# of the WorkspaceLens product, starts no tunnel, and contacts no service.
set -euo pipefail

cd "$(dirname "$0")/.."
repo_root="$(pwd)"
server="$repo_root/dist/gate0/connection-test-server.js"

fail() {
  echo "FAIL $1" >&2
  exit 1
}

# 1. Node.js 24 line (the pinned major).
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" = "24" ] || fail "Node.js 24 is required, found major $node_major"
echo "ok   node $(node --version)"

# 2. Built gate0 server, rebuilt when older than any source file.
if [ ! -f "$server" ] ||
  [ -n "$(find src package.json tsconfig.json tsconfig.build.json -newer "$server" -print -quit 2>/dev/null)" ]; then
  echo "--   building dist (npm run build)"
  npm run build -s
fi
[ -f "$server" ] || fail "gate0 server missing: $server"
echo "ok   gate0 server $server"

# 3. The server answers an MCP handshake over stdio using exactly the
#    command shape tunnel-client will run.
handshake='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"gate0-preflight","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
response="$(printf '%s\n' "$handshake" | node "$server" 2>/dev/null)" ||
  fail "gate0 server did not respond to the MCP handshake"
echo "$response" | grep -q '"workspace_list"' ||
  fail "gate0 server did not advertise workspace_list"
echo "ok   gate0 server answers MCP handshake and advertises workspace_list"

# 4. Official tunnel-client presence.
if command -v tunnel-client >/dev/null 2>&1; then
  echo "ok   tunnel-client at $(command -v tunnel-client)"
else
  echo "TODO install the official tunnel-client:"
  echo "     https://github.com/openai/tunnel-client/releases/latest"
fi

cat <<EOF

Local prerequisites are ready. Remaining steps require your OpenAI accounts:

1. Create or locate a tunnel and a runtime API key:
   https://platform.openai.com/settings/organization/tunnels
   (RBAC: Tunnels Read+Use to run the client, Read+Manage to create.)
2. Initialize the profile with this exact server command:

   tunnel-client init \\
     --sample sample_mcp_stdio_local \\
     --profile workspace-lens-gate0 \\
     --tunnel-id <your-tunnel-id> \\
     --mcp-command "node $server"

3. tunnel-client doctor --profile workspace-lens-gate0 --explain
4. tunnel-client run --profile workspace-lens-gate0   (keep it running)
5. In ChatGPT: create a developer-mode app, Connection: Tunnel, select
   your tunnel, then call workspace_list from a real chat.

Record the results (repeatability, restart behavior, failure state) as
Gate 0 evidence per implementation-plan.md §7.
EOF

#!/usr/bin/env bash
# Capture Gate B fixtures from the real supported tunnel-client binary
# (`docs/v0.3-test-contract.md` §7, GATE-B-4).
#
# Offline probes run without provider credentials. Success-path lifecycle
# captures (connected/healthy/stop of a live runtime) require a machine with
# a real admin key; they are marked MANUAL below and must be re-captured and
# sanitized before Gate B is declared PASS.
#
# Usage: scripts/capture-gate-b-fixtures.sh [output-dir]
set -euo pipefail

OUT_DIR="${1:-tests/v0.3/fixtures/gate-b/live}"
mkdir -p "$OUT_DIR"

require_binary() {
  command -v tunnel-client >/dev/null 2>&1 || {
    echo "BLOCKED: tunnel-client binary not found on PATH" >&2
    exit 3
  }
}

sanitized() {
  # Replace local user-specific paths in captured JSON.
  sed -e "s#$HOME/Library/Application Support/tunnel-client#<state-root>#g"
}

require_binary
{
  echo "binary: $(command -v tunnel-client)"
  echo "version: $(tunnel-client --version)"
  echo "platform: $(uname -s) $(uname -r) $(uname -m)"
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$OUT_DIR/binary-evidence.txt"

# Offline, credential-free captures.
tunnel-client runtimes --help > "$OUT_DIR/runtimes-help.txt" 2>&1 || true
tunnel-client runtimes connect --help > "$OUT_DIR/runtimes-connect-help.txt" 2>&1 || true
tunnel-client runtimes list --json 2>&1 | sanitized > "$OUT_DIR/runtimes-list.json" || true
tunnel-client runtimes status wl-capture-missing-alias --json > "$OUT_DIR/runtimes-status-missing.stdout.txt" 2> "$OUT_DIR/runtimes-status-missing.stderr.txt" || true
tunnel-client runtimes stop wl-capture-missing-alias --json > "$OUT_DIR/runtimes-stop-missing.stdout.txt" 2> "$OUT_DIR/runtimes-stop-missing.stderr.txt" || true

# MANUAL (requires real provider credentials; do not automate in CI):
#   1. tunnel-client runtimes connect --alias workspace-lens \
#        --mcp-server-url http://127.0.0.1:<port>/mcp \
#        --runtime-api-key env:WORKSPACE_LENS_TUNNEL_API_KEY ... --json
#   2. tunnel-client runtimes status workspace-lens --json
#   3. tunnel-client runtimes stop workspace-lens --json
#   4. unhealthy runtime state capture (stop daemon behind the alias, status again)
#   Sanitize: replace tunnel ids, organization ids, profile paths, and any
#   literal key material before committing fixtures.
echo "Offline fixtures captured into $OUT_DIR"
echo "Success-path lifecycle captures remain MANUAL; see tests/v0.3/fixtures/gate-b/FIXTURES.md"

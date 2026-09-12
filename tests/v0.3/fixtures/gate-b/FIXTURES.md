# Gate B captured command-output fixtures (`docs/v0.3-test-contract.md` §7, GATE-B-4)

Captured from the real supported binary on the development platform:

```text
binary:  /opt/homebrew/bin/tunnel-client
version: 0.0.14+0f870e50a973fa820d4c409000059e181e8d242b
platform: darwin 25.5.0 arm64
date:    2026-09-12
```

## Purpose

These are sanitized captures of the real `tunnel-client` command family used
by the v0.3 managed-runtime adapter. Adapter tests
(`tests/v0.3/connection/conn-adapter.test.ts`) normalize against these
fixtures. The capture script `scripts/capture-gate-b-fixtures.sh` reproduces
them and must be re-run on a machine with real provider credentials before
Gate B is declared PASS, so the success-path JSON shapes are frozen from real
output rather than invented.

## Captured behaviors (offline, no provider credentials needed)

| # | Command | Result |
| --- | --- | --- |
| 1 | `tunnel-client --version` | `0.0.14+0f870e50a973fa820d4c409000059e181e8d242b (git sha: 0f870e50a973fa820d4c409000059e181e8d242b)` |
| 2 | `tunnel-client --help` | command family contains `runtimes` |
| 3 | `tunnel-client runtimes --help` | subcommands: `cleanup connect create list rm status stop`; global `--json`, `--admin-key` accepting `env:NAME or file:/path` |
| 4 | `tunnel-client runtimes connect --help` | flags: `--alias`, `--mcp-server-url`, `--runtime-api-key` ("Runtime key reference to store in generated config"), `--profile-dir`, `--tunnel-id`, `--organization-id` |
| 5 | `tunnel-client runtimes list --json` | structured JSON: `{admin_profile, admin_profile_path, aliases: [], state_root}` |
| 6 | `tunnel-client runtimes status <missing-alias> --json` | **no JSON**: exit 1, stderr text `alias <alias> is not known; run create or connect first` |
| 7 | `tunnel-client runtimes stop <missing-alias> --json` | same text/exit-1 shape as #6 |
| 8 | `runtimes connect` without `--mcp-server-url`/`--mcp-command` | exit 1, stderr `connect requires --mcp-server-url or --mcp-command` |
| 9 | `runtimes connect` without `--organization-id`/`--workspace-id` | exit 1, stderr `creating a tunnel requires --organization-id or --workspace-id` |
| 10 | `runtimes connect` with `OPENAI_ADMIN_KEY` unset | exit 1, stderr `environment variable OPENAI_ADMIN_KEY is not set` |
| 11 | `runtimes connect` with admin key `env:` reference + unreachable control plane `http://127.0.0.1:1` | exit 1, stderr Go-style transport error, no sentinel secret in stdout/stderr/profile dir |

## Contract-relevant findings

- **GATE-B-1:** the managed-runtime command family and `--mcp-server-url`
  exist in the supported binary. Local discovery is proven.
- **GATE-B-2:** `runtimes list --json` is structured. `runtimes status` /
  `runtimes stop` for a missing alias emit human-readable stderr text with
  exit 1 instead of JSON, so a typed adapter must classify by exit code and
  non-JSON error text for that state. This is a real RFC-assumption deviation
  to keep visible in the adapter contract.
- **GATE-B-3:** `--runtime-api-key` is documented as a *reference* stored in
  the generated config, and `--admin-key` accepts `env:NAME`/`file:/path`.
  Probe #11 shows no secret literal in output on the failure path. The
  success-path profile content (that the generated profile stores `env:...`
  and not the literal) requires real provider credentials: MANUAL-GATE.
- **Success-path lifecycle JSON** (connected status, healthy status, stop of
  a live runtime): requires a real tunnel + admin key. MANUAL-GATE; freeze
  fixtures via `scripts/capture-gate-b-fixtures.sh` when available.

## Sanitization

Captures contain no provider secrets, tunnel ids, or organization identifiers.
State-root/admin-profile absolute paths were replaced with `<state-root>` /
`<admin-profile-path>` where present.

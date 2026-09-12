# MANUAL — E2E-008: Real ChatGPT Verification (Release Gate)

Status: **MANUAL-GATE** — intentionally manual/external
(`docs/v0.3-test-contract.md` §14). CI cannot own the user's ChatGPT/OpenAI
account, so this gate is executed by a human before v0.3 is called
product-complete. It is never automated and never replaced by a stub.

## Prerequisites

- A machine with the supported platform scope (macOS first per implementation plan §21).
- The v0.3 package installed in package-shaped form (`npm install -g workspace-lens` or equivalent).
- A real ChatGPT account with connector access and an organization able to manage tunnels.
- The official `tunnel-client` binary installed.

## Required evidence checklist (record each step's result)

1. Install/start the v0.3 product path:
   - `workspace-lens start` → Control Runtime healthy → WebUI available.
2. Configure one real tunnel/provider connection using WebUI guidance:
   - runtime credential stored via SecretStore (no plaintext fallback);
   - `tunnel-client runtimes connect` executed by WorkspaceLens with the
     stable alias and `env:` secret reference (verify: no literal key in argv).
3. Call `workspace_list` from ChatGPT:
   - record the tool result: workspace A visible.
4. Add workspace B through the WebUI:
   - record: no WorkspaceLens restart, no tunnel restart.
5. Call `workspace_list` again from ChatGPT:
   - record: A and B both visible on the next call.
6. Verify one representative read and one Git operation through ChatGPT:
   - record tool + workspace + result summary (no file contents in this log).
7. Close the browser and verify ChatGPT MCP access remains available.
8. Record any provider-side steps that remain **user-confirmed** rather than
   machine-verified (e.g. connector enablement inside ChatGPT settings).

## Anti-leak rules during execution

- Never paste literal API keys, tunnel ids, or organization identifiers into
  this file or any test artifact; redact them from screenshots/notes.
- If a sentinel secret is used during setup, confirm it appears in no log,
  diagnostic report, argv capture, or persisted config before recording PASS.

## Result

| # | Step | Result (PASS/FAIL) | Evidence / notes |
| --- | --- | --- | --- |
| 1 | start + healthy | | |
| 2 | tunnel/provider setup | | |
| 3 | workspace_list from ChatGPT sees A | | |
| 4 | add B via WebUI | | |
| 5 | workspace_list sees A+B without restart | | |
| 6 | representative read/Git op | | |
| 7 | browser closed; MCP still available | | |
| 8 | user-confirmed provider steps recorded | | |

v0.3 is **not** product-complete until every row above is PASS or an approved
contract change supersedes it (`docs/v0.3-test-contract.md` §19).

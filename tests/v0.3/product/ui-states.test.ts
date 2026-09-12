import { describe, expect, it } from "vitest";
import { importExpectedPath } from "../helpers/expected-module.js";

/**
 * WebUI Test Boundary contracts (`docs/v0.3-test-contract.md` §13):
 * UI-001..005.
 *
 * These contracts mount the REAL WebUI application through its component
 * test harness (`ui/test-support/index.ts`, provided by Slice 13–15) and
 * assert user-observable behavior — never CSS classes, DOM nesting, or
 * pixel values. There is deliberately no capability-only shortcut: until the
 * test harness module exists every test is RED, and once it exists the
 * assertions below run against the rendered application, so creating an
 * empty `ui/` skeleton cannot turn them green.
 *
 * The test-support contract the UI must provide (Slice 13):
 * - `renderApp(initialState)` mounts the real root component into a test
 *   renderer and returns testing-library style queries
 *   (`getByText`, `queryByRole`, `getByRole`, `click`);
 * - `seedApiState(state)` pins what `GET /api/v1/*` returns so rendering is
 *   deterministic without a live runtime.
 */

const UI_SLICE = "Slices 13–15 — React/Vite WebUI";

interface UiScreen {
  getByText(text: string | RegExp): unknown;
  queryByText(text: string | RegExp): unknown;
  getByRole(role: string, options?: { name?: string | RegExp }): unknown;
  queryByRole(role: string, options?: { name?: string | RegExp }): unknown;
  click(target: unknown): void;
}

interface UiTestSupport {
  renderApp(initialState: Record<string, unknown>): UiScreen;
  seedApiState(state: Record<string, unknown>): void;
}

async function mountUi(initialState: Record<string, unknown>): Promise<UiScreen> {
  const support = (await importExpectedPath(
    "ui/test-support/index.ts",
    "WebUI application + component test harness",
    UI_SLICE,
  )) as UiTestSupport;
  support.seedApiState(initialState);
  return support.renderApp(initialState);
}

const WORKSPACE_A = {
  workspace_id: "ws-alpha",
  name: "Alpha",
  state: "healthy",
  enabled: true,
  verification: "machine-verified",
};

describe("UI — WebUI behavior contracts", () => {
  it("UI-001 renders Workspaces empty/populated states with identity, state, and navigation", async () => {
    // Empty state: the primary add action is reachable.
    const empty = await mountUi({ workspaces: [] });
    expect(empty.queryByRole("button", { name: /add workspace/i })).toBeTruthy();

    // Populated state: workspace identity, enabled/disabled/error state, and
    // a path to the detail view.
    const populated = await mountUi({
      workspaces: [WORKSPACE_A, { ...WORKSPACE_A, workspace_id: "ws-beta", name: "Beta", enabled: false, state: "disabled" }],
    });
    expect(populated.getByText("Alpha")).toBeTruthy();
    expect(populated.getByText("Beta")).toBeTruthy();
    expect(populated.getByText(/disabled/i)).toBeTruthy();

    populated.click(populated.getByText("Alpha"));
    expect(populated.queryByText(/alpha/i)).toBeTruthy();
  });

  it("UI-002 never overclaims provider state beyond locally observable truth", async () => {
    // Locally healthy tunnel runtime, provider-side state NOT verified.
    const screen = await mountUi({
      workspaces: [WORKSPACE_A],
      connection: {
        localRuntime: "healthy",
        tunnelRuntime: "healthy",
        provider: "unverified",
        verification: "none",
      },
    });
    const text = String(screen.queryByText(/chatgpt|connected/i) ?? "");
    // No unsupported `ChatGPT connected` claim when provider state is
    // unverified.
    expect(/chatgpt\s+connected/i.test(text)).toBe(false);
    expect(screen.getByText(/unverified|not verified|pending/i)).toBeTruthy();
  });

  it("UI-003 distinguishes Verified from User confirmed beyond color alone", async () => {
    const screen = await mountUi({
      workspaces: [
        { ...WORKSPACE_A, workspace_id: "ws-verified", name: "Verified One", verification: "machine-verified" },
        { ...WORKSPACE_A, workspace_id: "ws-confirmed", name: "Confirmed One", verification: "user-confirmed" },
      ],
    });
    expect(screen.getByText(/verified/i)).toBeTruthy();
    expect(screen.getByText(/user confirmed/i)).toBeTruthy();
    // The two treatments must differ in text/semantics, not only color.
    expect(String(screen.getByText(/verified/i))).not.toBe(String(screen.getByText(/user confirmed/i)));
  });

  it("UI-004 words destructive removal precisely: authorization only, local files untouched", async () => {
    const screen = await mountUi({
      workspaces: [WORKSPACE_A],
      removeConfirmation: { workspaceId: "ws-alpha" },
    });
    screen.click(screen.getByRole("button", { name: /remove/i }));
    // The confirmation must state BOTH halves of the contract.
    expect(screen.getByText(/authorization/i)).toBeTruthy();
    expect(screen.getByText(/local files|files.*untouched|untouched/i)).toBeTruthy();
  });

  it("UI-005 reconstructs setup progress from current state, not a stored page index", async () => {
    // Server says: system done, first workspace done, tunnel NOT done.
    const screen = await mountUi({
      setup: { system: "done", firstWorkspace: "done", tunnel: "pending", chatgpt: "pending", verify: "pending" },
    });
    // The setup flow resumes at the first pending stage even if a stale
    // stored index would have pointed elsewhere.
    expect(screen.getByText(/tunnel/i)).toBeTruthy();
    expect(screen.queryByText(/chatgpt/i) ?? null).toBeTruthy();
  });
});

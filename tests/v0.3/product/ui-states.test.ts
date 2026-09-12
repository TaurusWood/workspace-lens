import { describe, expect, it } from "vitest";
import { mountRealUi, type RenderedUi } from "../helpers/render-ui.js";

/**
 * WebUI Test Boundary contracts (`docs/v0.3-test-contract.md` §13):
 * UI-001..005.
 *
 * These contracts mount the REAL WebUI root component (`ui/src/App`) from the
 * TEST side (`helpers/render-ui.ts`): Testing Library render + a fake Control
 * API served through the fetch layer. Production code cannot define how it is
 * tested — there is no production-owned test-support adapter, and a fake
 * `renderApp()` cannot satisfy these tests because the component under test
 * is the same module the product entry point renders.
 *
 * Assertions are behavior-level (§13): visible text, roles, and accessibility
 * semantics — never CSS classes, DOM nesting, or pixel values.
 */

const WORKSPACE_A = {
  workspace_id: "ws-alpha",
  name: "Alpha",
  state: "healthy",
  enabled: true,
  verification: "machine-verified",
};

describe("UI — WebUI behavior contracts", () => {
  it("UI-001 renders Workspaces empty/populated states with identity, state, and navigation", async () => {
    const empty = await mountRealUi({ workspaces: [] });
    try {
      // Empty state: the primary add action is reachable.
      expect(empty.screen.queryByRole("button", { name: /add workspace/i })).toBeTruthy();
    } finally {
      empty.unmount();
    }

    const populated = await mountRealUi({
      workspaces: [
        WORKSPACE_A,
        { ...WORKSPACE_A, workspace_id: "ws-beta", name: "Beta", enabled: false, state: "disabled" },
      ],
    });
    try {
      expect(populated.screen.getByText("Alpha")).toBeTruthy();
      expect(populated.screen.getByText("Beta")).toBeTruthy();
      // Enabled/disabled state must be visible as text, not color alone.
      expect(populated.screen.getByText(/disabled/i)).toBeTruthy();

      // Navigation to the detail view: after clicking the workspace, detail
      // management actions (rename/disable/remove) become reachable.
      populated.fireEvent.click(populated.screen.getByText("Alpha"));
      await populated.waitFor(() => {
        expect(
          populated.screen.queryByRole("button", { name: /rename|disable|remove/i }) ??
            populated.screen.queryByRole("link", { name: /rename|disable|remove/i }),
        ).toBeTruthy();
      });
    } finally {
      populated.unmount();
    }
  });

  it("UI-002 never overclaims provider state beyond locally observable truth", async () => {
    const ui = await mountRealUi({
      workspaces: [WORKSPACE_A],
      connection: {
        localRuntime: "healthy",
        tunnelRuntime: "healthy",
        provider: "unverified",
        verification: "none",
      },
    });
    try {
      // No "ChatGPT connected" (or equivalent) claim anywhere on the screen:
      // asserted directly against matching text nodes.
      expect(ui.screen.queryByText(/chatgpt\s+connected/i)).toBeNull();
      // The unverified provider state must be visibly distinguished.
      expect(ui.screen.getByText(/unverified|not verified|pending/i)).toBeTruthy();
    } finally {
      ui.unmount();
    }
  });

  it("UI-003 distinguishes Verified from User confirmed beyond color alone", async () => {
    const ui = await mountRealUi({
      workspaces: [
        { ...WORKSPACE_A, workspace_id: "ws-verified", name: "Verified One", verification: "machine-verified" },
        { ...WORKSPACE_A, workspace_id: "ws-confirmed", name: "Confirmed One", verification: "user-confirmed" },
      ],
    });
    try {
      // Both treatments must exist as distinct text/semantics.
      expect(ui.screen.getByText(/machine-verified|^verified$/i)).toBeTruthy();
      expect(ui.screen.getByText(/user confirmed|user-confirmed/i)).toBeTruthy();
    } finally {
      ui.unmount();
    }
  });

  it("UI-004 words destructive removal precisely: authorization only, local files untouched", async () => {
    const ui = await mountRealUi({ workspaces: [WORKSPACE_A] });
    try {
      ui.fireEvent.click(ui.screen.getByRole("button", { name: /remove/i }));
      await ui.waitFor(() => {
        // The confirmation must state BOTH halves of the contract.
        expect(ui.screen.getByText(/authorization/i)).toBeTruthy();
        expect(ui.screen.getByText(/local files|untouched/i)).toBeTruthy();
      });
    } finally {
      ui.unmount();
    }
  });

  it("UI-005 reconstructs setup progress from current state, not a stored page index", async () => {
    // Server state: system + first workspace done, tunnel pending. A stale
    // stored wizard index pointing at a later stage must be ignored.
    const ui = await mountRealUi({
      setup: {
        system: "done",
        firstWorkspace: "done",
        tunnel: "pending",
        chatgpt: "pending",
        verify: "pending",
      },
    });
    try {
      // The CURRENT active stage must semantically be Tunnel — asserted via
      // the accessibility marker (aria-current="step"), not styling.
      await ui.waitFor(() => {
        const currentStage = (globalThis as any).document.querySelector('[aria-current="step"]');
        expect(currentStage?.textContent ?? "").toMatch(/tunnel/i);
      });
      // No later stage is marked active (guards against a stale index).
      const allCurrent = Array.from((globalThis as any).document.querySelectorAll('[aria-current="step"]'));
      expect(allCurrent).toHaveLength(1);
    } finally {
      ui.unmount();
    }
  });
});

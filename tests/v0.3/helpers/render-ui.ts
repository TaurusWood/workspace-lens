/**
 * Test-side UI mounting helper — the UI contracts' harness lives HERE, in the
 * tests, not in production `ui/` code (per the Test CR: "the harness controls
 * the fixture, but the implementation must not define how it is tested").
 *
 * It imports the REAL root component (`ui/src/App`) — the exact module the
 * production entry renders — mounts it with Testing Library, and intercepts
 * `globalThis.fetch` to serve a fake Control API so rendering is driven by
 * API state, exactly as in production.
 *
 * Red gate conditions (all required from Slice 13):
 * - `ui/src/App.tsx` exists (the real root component);
 * - `@testing-library/react` is installed (component test runner);
 * - the vitest environment provides a DOM (`document`).
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { REPO_ROOT, MissingCapabilityError } from "./expected-module.js";

const APP_ENTRY = path.join(REPO_ROOT, "ui", "src", "App.tsx");

export interface FakeApiState {
  workspaces?: Record<string, unknown>[];
  connection?: Record<string, unknown>;
  setup?: Record<string, unknown>;
  settings?: Record<string, unknown>;
}

export interface RenderedUi {
  /** Testing Library screen bound to this render. */
  screen: {
    getByText(text: string | RegExp): unknown;
    queryByText(text: string | RegExp): unknown;
    getByRole(role: string, options?: { name?: string | RegExp }): unknown;
    queryByRole(role: string, options?: { name?: string | RegExp }): unknown;
  };
  fireEvent: {
    click(target: unknown): void;
  };
  waitFor<T>(callback: () => T): Promise<T>;
  unmount(): void;
}

function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function installFakeControlApi(state: FakeApiState): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/api/v1/workspaces")) {
      if (init?.method && init.method !== "GET") {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ workspaces: state.workspaces ?? [] });
    }
    if (url.includes("/api/v1/session")) {
      return jsonResponse(
        { csrf_token: "v0.3-ui-test-token" },
        { "set-cookie": "wl_session=v0.3-ui-test; HttpOnly; SameSite=Strict" },
      );
    }
    if (url.includes("/api/v1/connection")) {
      return jsonResponse(
        state.connection ?? { state: "stopped", layers: {}, provider: "unverified" },
      );
    }
    if (url.includes("/api/v1/setup")) {
      return jsonResponse(state.setup ?? {});
    }
    if (url.includes("/api/v1/settings")) {
      return jsonResponse(state.settings ?? {});
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

export async function mountRealUi(state: FakeApiState): Promise<RenderedUi> {
  if (!fs.existsSync(APP_ENTRY)) {
    throw new MissingCapabilityError(
      "v0.3 RED (missing capability): the real WebUI root component ui/src/App.tsx does not " +
        "exist yet (Slices 13–15 — React/Vite WebUI). The UI contracts mount THIS module from " +
        "the tests — a production-side test-support adapter cannot substitute for it. " +
        "See docs/v0.3-test-coverage.md.",
    );
  }
  let rtl: any;
  try {
    // Variable specifier: the component test runner is a Slice 13 dependency
    // and does not exist yet, so the import must not be statically resolved.
    const rtlModule = "@testing-library/react";
    rtl = await import(/* @vite-ignore */ rtlModule);
  } catch {
    throw new MissingCapabilityError(
      "v0.3 RED (missing capability): @testing-library/react is not installed. The UI " +
        "contracts require the component test runner to mount the real App (Slice 13).",
    );
  }
  if (typeof (globalThis as any).document === "undefined") {
    throw new MissingCapabilityError(
      "v0.3 RED (missing capability): the vitest environment for UI contract tests provides no " +
        "DOM. Slice 13 must run these tests under a jsdom/happy-dom environment.",
    );
  }
  const reactModule = "react";
  const react = (await import(/* @vite-ignore */ reactModule)) as any;
  const restoreFetch = installFakeControlApi(state);
  try {
    const appModule = (await import(/* @vite-ignore */ pathToFileURL(APP_ENTRY).href)) as any;
    const App = appModule.default ?? appModule.App;
    if (typeof App !== "function" && typeof App !== "object") {
      throw new Error("ui/src/App.tsx must export a React component (default or named App)");
    }
    const rendered = rtl.render(react.createElement(App));
    return {
      screen: {
        getByText: (...args: any[]) => rendered.getByText(...args),
        queryByText: (...args: any[]) => rendered.queryByText(...args),
        getByRole: (...args: any[]) => rendered.getByRole(...args),
        queryByRole: (...args: any[]) => rendered.queryByRole(...args),
      },
      fireEvent: {
        click: (target: unknown) => rtl.fireEvent.click(target),
      },
      waitFor: async <T>(callback: () => T): Promise<T> => {
        let lastError: unknown;
        for (let attempt = 0; attempt < 50; attempt += 1) {
          try {
            return callback();
          } catch (error) {
            lastError = error;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw lastError;
      },
      unmount: () => {
        rendered.unmount();
        restoreFetch();
      },
    };
  } catch (error) {
    restoreFetch();
    throw error;
  }
}

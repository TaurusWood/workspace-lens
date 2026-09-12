/**
 * Pre-implementation RED gate for v0.3 contracts (`docs/v0.3-test-contract.md` §3.2, §16.1).
 *
 * v0.3 capabilities do not exist yet, so their contract tests must fail RED
 * with a specific missing capability instead of being skipped. Each contract
 * test imports its expected application module through this helper:
 *
 * - module missing  -> RED with the owning implementation slice named;
 * - module present  -> the full behavioral assertions of the contract run
 *   against the real public interface, so a partial implementation cannot
 *   turn the contract green by only creating an empty module.
 *
 * The expected module paths follow `docs/v0.3-implementation-plan.md` §2
 * ("The implementation may adjust exact names"); when a slice lands under a
 * different name, the path constant is updated together with the slice and
 * the contract keeps its identity through its Contract ID.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** Expected module paths per the v0.3 implementation plan target layout. */
export const EXPECTED_MODULES = {
  workspaceAdminService: "application/workspace-admin-service.ts",
  diagnosticsService: "application/diagnostics-service.ts",
  connectionService: "application/connection-service.ts",
  settingsService: "application/settings-service.ts",
  promptHelperService: "application/prompt-helper-service.ts",
  configLock: "config/config-lock.ts",
  controlRuntime: "control/runtime.ts",
  controlServer: "control/server.ts",
  mcpHttp: "mcp/http.ts",
  startCommand: "cli/commands/start.ts",
  tunnelRuntimeAdapter: "integrations/openai/tunnel-runtime-adapter.ts",
  secretStore: "integrations/secrets/secret-store.ts",
  startupManager: "integrations/startup/startup-manager.ts",
  folderPicker: "integrations/folder-picker/folder-picker.ts",
} as const;

export type ExpectedModuleKey = keyof typeof EXPECTED_MODULES;

/** Owner slice per `docs/v0.3-implementation-plan.md` for RED diagnostics. */
export const MODULE_SLICE: Record<ExpectedModuleKey, string> = {
  workspaceAdminService: "Slice 0 — application service boundaries",
  diagnosticsService: "Slice 5 — DiagnosticsService extraction",
  connectionService: "Slice 6 — tunnel managed-runtime adapter / ConnectionService",
  settingsService: "Slice 9 — control state and settings",
  promptHelperService: "Slice 8 — helper Control API",
  configLock: "Slice 1 — safe mutable configuration",
  controlRuntime: "Slice 3 — Control Runtime foundation",
  controlServer: "Slice 3 — Control Runtime foundation",
  mcpHttp: "Slice 4 — read-only MCP HTTP endpoint",
  startCommand: "Slice 12 — canonical workspace-lens start",
  tunnelRuntimeAdapter: "Slice 6 — tunnel managed-runtime adapter",
  secretStore: "Slice 10 — SecretStore",
  startupManager: "Slice 17 — login autostart",
  folderPicker: "Slice 16 — folder picker adapter",
};

export class MissingCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingCapabilityError";
  }
}

export function modulePath(key: ExpectedModuleKey): string {
  return path.join(SRC_ROOT, EXPECTED_MODULES[key]);
}

export function isModuleImplemented(key: ExpectedModuleKey): boolean {
  return fs.existsSync(modulePath(key));
}

/**
 * Import an expected v0.3 module, failing RED when the capability does not
 * exist yet. Returns `any` on purpose: before implementation there is no
 * stable type surface, and the behavioral assertions below are the contract.
 * The specifier is relative to this helper file (tests/v0.3/helpers/).
 */
export async function importExpected(key: ExpectedModuleKey): Promise<any> {
  const relPath = EXPECTED_MODULES[key];
  const absolute = modulePath(key);
  if (!fs.existsSync(absolute)) {
    throw new MissingCapabilityError(
      `v0.3 RED (missing capability): expected module src/${relPath} is not implemented yet ` +
        `(${MODULE_SLICE[key]}). Behavioral assertions activate once the module exists. ` +
        `See docs/v0.3-test-coverage.md.`,
    );
  }
  const specifier = `../../../src/${relPath}`;
  return import(/* @vite-ignore */ specifier);
}

/**
 * Capability gate for whole-application surfaces that have no single module
 * (WebUI, packaging). Fails RED until the marker files exist.
 */
export async function requireCapability(
  capability: string,
  ownerSlice: string,
  markerFiles: string[],
): Promise<void> {
  const missing = markerFiles.filter((marker) => !fs.existsSync(path.join(REPO_ROOT, marker)));
  if (missing.length > 0) {
    throw new MissingCapabilityError(
      `v0.3 RED (missing capability): ${capability} is not implemented yet (${ownerSlice}); ` +
        `missing: ${missing.join(", ")}. See docs/v0.3-test-coverage.md.`,
    );
  }
}

export { REPO_ROOT };

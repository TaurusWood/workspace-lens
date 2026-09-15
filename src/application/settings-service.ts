/**
 * Settings application service (`docs/v0.3-implementation-plan.md` §12).
 *
 * Owns the non-secret product preferences persisted in the control state
 * (desired `startAtLogin` / `autoConnect` state). This is DESIRED state the
 * user controls — machine-derived connection/health observations are never
 * persisted here (they live in the runtime's bounded memory only).
 */
import type { ControlStateStore } from "../config/control-state-store.js";

export interface SettingsPatch {
  startAtLogin?: boolean;
  autoConnect?: boolean;
  providerSetupUserConfirmed?: boolean;
  verificationUserConfirmed?: boolean;
}

export interface SettingsView {
  startAtLogin: boolean;
  autoConnect: boolean;
  providerSetupUserConfirmed: boolean;
  verificationUserConfirmed: boolean;
}

export class SettingsService {
  private readonly store: ControlStateStore;

  constructor(dependencies: { controlStateStore: ControlStateStore }) {
    this.store = dependencies.controlStateStore;
  }

  async get(): Promise<SettingsView> {
    const document = this.store.load();
    return {
      startAtLogin: document.preferences.startAtLogin,
      autoConnect: document.preferences.autoConnect,
      providerSetupUserConfirmed: document.preferences.providerSetupUserConfirmed,
      verificationUserConfirmed: document.preferences.verificationUserConfirmed,
    };
  }

  async patch(patch: SettingsPatch): Promise<SettingsView> {
    const document = this.store.load();
    if (patch.startAtLogin !== undefined) {
      document.preferences.startAtLogin = patch.startAtLogin;
    }
    if (patch.autoConnect !== undefined) {
      document.preferences.autoConnect = patch.autoConnect;
    }
    if (patch.providerSetupUserConfirmed !== undefined) {
      document.preferences.providerSetupUserConfirmed = patch.providerSetupUserConfirmed;
    }
    if (patch.verificationUserConfirmed !== undefined) {
      document.preferences.verificationUserConfirmed = patch.verificationUserConfirmed;
    }
    this.store.save(document);
    return {
      startAtLogin: document.preferences.startAtLogin,
      autoConnect: document.preferences.autoConnect,
      providerSetupUserConfirmed: document.preferences.providerSetupUserConfirmed,
      verificationUserConfirmed: document.preferences.verificationUserConfirmed,
    };
  }
}

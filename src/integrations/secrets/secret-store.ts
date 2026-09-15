/**
 * OS-backed credential storage adapter (Slice 10 — SecretStore, Gate C).
 *
 * Implements the narrow SecretStore interface:
 *   available(): Promise<boolean>
 *   get(name: string): Promise<string | undefined>
 *   set(name: string, value: string): Promise<void>
 *   delete(name: string): Promise<void>
 *
 * Backed by @github/keytar for operating system credential storage
 * (macOS Keychain, Linux Secret Service, Windows Credential Manager).
 *
 * Contract requirements (Gate C, security contract §10.2):
 * - Plaintext fallback is forbidden: an unavailable store rejects mutations.
 * - Secret values are never printed, logged, or serialized into ordinary state.
 * - Platform implementations can be injected for deterministic testability.
 */

export interface SecretStorePlatform {
  available(): Promise<boolean>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface SecretStoreOptions {
  namespace: string;
  platform?: SecretStorePlatform;
}

let cachedKeytar: typeof import("@github/keytar") | null = null;

async function loadKeytar(): Promise<typeof import("@github/keytar") | undefined> {
  if (cachedKeytar !== null) {
    return cachedKeytar;
  }
  try {
    const mod = await import("@github/keytar");
    cachedKeytar = (mod.default ?? mod) as typeof import("@github/keytar");
    return cachedKeytar;
  } catch {
    return undefined;
  }
}

class DefaultKeytarPlatform implements SecretStorePlatform {
  constructor(private readonly namespace: string) {}

  async available(): Promise<boolean> {
    const keytar = await loadKeytar();
    if (keytar === undefined) {
      return false;
    }
    try {
      // Probing availability: querying a non-existent account returns null if the
      // underlying OS credential daemon is operational. If unavailable, it rejects.
      await keytar.getPassword(this.namespace, "__probe__");
      return true;
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<string | undefined> {
    const keytar = await loadKeytar();
    if (keytar === undefined) {
      return undefined;
    }
    try {
      const value = await keytar.getPassword(this.namespace, name);
      return value === null ? undefined : value;
    } catch {
      return undefined;
    }
  }

  async set(name: string, value: string): Promise<void> {
    const keytar = await loadKeytar();
    if (keytar === undefined) {
      throw new Error("Credential store is unavailable; no plaintext fallback is permitted.");
    }
    await keytar.setPassword(this.namespace, name, value);
  }

  async delete(name: string): Promise<void> {
    const keytar = await loadKeytar();
    if (keytar === undefined) {
      return;
    }
    try {
      await keytar.deletePassword(this.namespace, name);
    } catch {
      // Ignore deletion failure when absent or unavailable
    }
  }
}

export class SecretStore implements SecretStorePlatform {
  private readonly platform: SecretStorePlatform;

  constructor(options: SecretStoreOptions) {
    if (!options.namespace || typeof options.namespace !== "string") {
      throw new Error("SecretStore requires a non-empty string namespace.");
    }
    this.platform = options.platform ?? new DefaultKeytarPlatform(options.namespace);
  }

  async available(): Promise<boolean> {
    try {
      return await this.platform.available();
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<string | undefined> {
    try {
      const isAvailable = await this.platform.available();
      if (!isAvailable) {
        return undefined;
      }
      const result = await this.platform.get(name);
      return result ?? undefined;
    } catch {
      return undefined;
    }
  }

  async set(name: string, value: string): Promise<void> {
    const isAvailable = await this.platform.available();
    if (!isAvailable) {
      throw new Error("Credential store is unavailable; no plaintext fallback is permitted.");
    }
    await this.platform.set(name, value);
  }

  async delete(name: string): Promise<void> {
    try {
      await this.platform.delete(name);
    } catch {
      // Fail safe on deletion failure
    }
  }
}

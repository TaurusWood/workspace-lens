import { describe, expect, it } from "vitest";
import { SecretStore } from "../../../src/integrations/secrets/secret-store.js";

describe("SecretStore (Slice 10 focused)", () => {
  it("requires a non-empty string namespace", () => {
    expect(() => new SecretStore({ namespace: "" })).toThrow(/namespace/i);
    expect(() => new SecretStore({ namespace: null as any })).toThrow(/namespace/i);
  });

  it("performs set/get/delete through an isolated platform adapter", async () => {
    const memory = new Map<string, string>();
    const platform = {
      available: async () => true,
      get: async (name: string) => memory.get(name),
      set: async (name: string, value: string) => {
        memory.set(name, value);
      },
      delete: async (name: string) => {
        memory.delete(name);
      },
    };

    const store = new SecretStore({
      namespace: "test-namespace",
      platform,
    });

    expect(await store.available()).toBe(true);
    await store.set("api-key", "secret-val-9988");
    expect(await store.get("api-key")).toBe("secret-val-9988");

    await store.delete("api-key");
    expect(await store.get("api-key")).toBeUndefined();
  });

  it("fails closed when platform throws or reports unavailable", async () => {
    const failingPlatform = {
      available: async () => false,
      get: async () => {
        throw new Error("storage crashed");
      },
      set: async () => {
        throw new Error("storage crashed");
      },
      delete: async () => {
        throw new Error("storage crashed");
      },
    };

    const store = new SecretStore({
      namespace: "test-failing",
      platform: failingPlatform,
    });

    expect(await store.available()).toBe(false);
    // set must reject explicitly
    await expect(store.set("key", "val")).rejects.toThrow(/unavailable/i);
    // get must degrade safely to undefined without throwing or leaking
    expect(await store.get("key")).toBeUndefined();
  });

  it("handles default keytar platform instantiation without throwing", async () => {
    const store = new SecretStore({ namespace: "workspace-lens-probe" });
    const available = await store.available();
    expect(typeof available).toBe("boolean");
  });
});

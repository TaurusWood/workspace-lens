import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../../src/core/limits.js";

describe("DEFAULT_LIMITS", () => {
  // Recommended MVP defaults from security-model.md §10 / mcp-tools-spec.md §14.
  it("matches the documented recommended defaults", () => {
    expect(DEFAULT_LIMITS.maxEligibleFileBytes).toBe(1024 * 1024); // 1 MiB
    expect(DEFAULT_LIMITS.maxReadPayloadBytes).toBe(128 * 1024); // 128 KiB
    expect(DEFAULT_LIMITS.maxListEntries).toBe(2000);
    expect(DEFAULT_LIMITS.maxListDepth).toBe(5);
    expect(DEFAULT_LIMITS.defaultSearchResults).toBe(50);
    expect(DEFAULT_LIMITS.maxSearchResults).toBe(100);
    expect(DEFAULT_LIMITS.maxDiffPayloadBytes).toBe(256 * 1024); // 256 KiB
    expect(DEFAULT_LIMITS.maxQueryLength).toBe(500);
  });

  it("always bounds every potentially large result", () => {
    for (const value of Object.values(DEFAULT_LIMITS)) {
      expect(value).toBeGreaterThan(0);
      expect(Number.isInteger(value)).toBe(true);
    }
  });
});

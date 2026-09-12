import { defineConfig } from "vitest/config";

/**
 * v0.3 contract suite (`docs/v0.3-test-contract.md` §3.2).
 *
 * Kept separate from the default v0.2 regression config so that expected RED
 * results for not-yet-implemented v0.3 capabilities never mask a real v0.2
 * regression. Run with `npm run test:v0.3`.
 */
export default defineConfig({
  test: {
    include: ["tests/v0.3/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
    // Contract IDs stay traceable through file names and test titles; the
    // reporter output is the evidence source for docs/v0.3-test-coverage.md.
    reporters: ["default"],
  },
});

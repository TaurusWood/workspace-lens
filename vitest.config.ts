import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // tests/v0.3 is the dedicated v0.3 contract suite (`docs/v0.3-test-contract.md`
    // §3.2); it may be RED for not-yet-implemented capabilities and therefore
    // runs only through `npm run test:v0.3` with vitest.v0.3.config.ts.
    exclude: ["tests/v0.3/**", "**/node_modules/**"],
    environment: "node",
    testTimeout: 20000,
  },
});

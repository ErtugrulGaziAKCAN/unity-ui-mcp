import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    passWithNoTests: true,
    // browser-driven tests: allow host stalls (a single lint takes well under a second)
    testTimeout: 20000,
    hookTimeout: 20000,
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
  },
});

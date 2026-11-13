import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // lint tests drive a real Chromium: allow host stalls (one lint takes well under a second warm)
    testTimeout: 30000,
    hookTimeout: 30000,
    include: ["test/**/*.test.ts"],
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // One in-memory replica set is started once and shared by all suites. Spinning up a
    // mongod per file would dominate the run time, and the suites clean their own data.
    globalSetup: ["./src/test/globalSetup.ts"],
    setupFiles: ["./src/test/setup.ts"],
    // Financial suites assert on shared collection state, so they must not interleave.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    include: ["src/**/*.test.ts"],
  },
});

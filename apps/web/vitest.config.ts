import { defineConfig, mergeConfig } from "vitest/config";
import viteConfig from "./vite.config";

/**
 * Frontend tests.
 *
 * These exist because of what the last three phases found. Every defect — a form defaulting
 * to an enum value that does not exist, a dropdown offering rows the server refuses, a
 * success toast rendering `₹NaN` — was caught by a human running the application by hand,
 * and each one would have been caught by a component test in milliseconds.
 *
 * The API suite is thorough about the ledger. It says nothing about whether a form sends
 * what the ledger expects, and that boundary is where all of those bugs lived.
 *
 * The config extends the app's own vite config so the `@/` alias and the plugin pipeline
 * are shared. A test resolving imports differently from the build is a test of something
 * that does not ship.
 */
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/**/*.test.{ts,tsx}"],
      css: false,
      restoreMocks: true,
    },
  }),
);

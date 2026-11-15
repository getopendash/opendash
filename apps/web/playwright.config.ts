import { defineConfig, devices } from "@playwright/test";

/**
 * The end-to-end browser tests (e2e/). Run them with `pnpm e2e` from the repository root, which starts an instance
 * on a database of its own and sets what these read (scripts/e2e.mjs); `playwright test` alone has nothing to open.
 * One worker, in order: the tests are one person's first hour (sign up, a workspace, a source, a question), each
 * step on the one before.
 */
export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.spec.ts",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: Boolean(process.env.CI),
  // A first page load compiles it (next dev), and a source's connection check waits on the worker.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: process.env.CI ? [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]] : [["list"]],
  use: {
    baseURL: process.env.E2E_ORIGIN ?? "http://localhost:3391",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});

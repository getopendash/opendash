import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // Processed here, not loaded as is, so a test can stand in for Google's sign-in (test/providers.test.ts).
    server: { deps: { inline: ["@ai-sdk/google-vertex"] } },
  },
});

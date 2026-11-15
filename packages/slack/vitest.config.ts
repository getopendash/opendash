import { defineConfig } from "vitest/config";

// Several tests run the real Chat SDK adapter against Postgres (a learned demo source each file): files one at a time,
// with room for that setup.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 300_000 },
});

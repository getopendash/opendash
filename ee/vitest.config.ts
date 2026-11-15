import { defineConfig } from "vitest/config";

// Each file makes its own database: one at a time, with room to make it while the other packages' suites run.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 60_000 },
});

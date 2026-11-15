import { defineConfig } from "vitest/config";

// The rate-limit tests sign in dozens of times, each one hashing a password: seconds on a laptop, a minute on a busy CI runner.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], fileParallelism: false, testTimeout: 120_000, hookTimeout: 60_000 },
});

import { defineConfig } from "vitest/config";

// Drawing a long PDF in the bundled fonts takes seconds on a slower machine (6 s on a CI runner): the other packages'
// 30-second limit, not vitest's 5.
export default defineConfig({ test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 } });

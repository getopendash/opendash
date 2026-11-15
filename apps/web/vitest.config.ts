import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // `@/` as tsconfig maps it, so a test can render a component that imports through it.
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  // Next's tsconfig keeps JSX for Next to compile; a test compiles it itself.
  oxc: { jsx: { runtime: "automatic" } },
  test: { include: ["test/**/*.test.ts"], testTimeout: 30_000 },
});

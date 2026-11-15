import { defineConfig } from "drizzle-kit";

// drizzle-kit generates migrations for ordinary tables only. Partitioned tables (usage_event, run_event, query_run,
// audit_log), SQL functions and SECURITY DEFINER functions are hand-written custom migrations; their Drizzle
// definitions live in src/schema/partitioned.ts, which is deliberately NOT listed here.
export default defineConfig({
  dialect: "postgresql",
  schema: [
    "./src/schema/auth.ts",
    "./src/schema/identity.ts",
    "./src/schema/sources.ts",
    "./src/schema/catalog.ts",
    "./src/schema/runs.ts",
    "./src/schema/knowledge.ts",
    "./src/schema/learning.ts",
    "./src/schema/projects.ts",
    "./src/schema/dashboards.ts",
    "./src/schema/evals.ts",
    "./src/schema/ai.ts",
    "./src/schema/ops.ts",
    "./src/schema/checks.ts",
    "./src/schema/tasks.ts",
    "./src/schema/delivery.ts",
    "./src/schema/routines.ts",
    "./src/schema/slack.ts",
    "./src/schema/embedding.ts",
    "./src/schema/graph.ts",
    "./src/schema/mcp.ts",
  ],
  out: "./migrations",
  entities: { roles: false },
  strict: true,
  verbose: true,
});

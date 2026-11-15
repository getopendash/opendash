/**
 * The tools that read the source: a verified metric through the semantic layer (`metric_query`), and the model's own
 * SQL through the gateway (`sql_check`, `sql_query`). Every result is a query run the answer can cite by its alias.
 */
import { assignAlias, BUDGETS, runMetricQuery, runQuery } from "@opendash/core";
import { z } from "zod";
import { nextStep, params, rowsForModel, sourceParam } from "./shared";
import { unknownSource } from "./sources";
import { defineTool, type ToolContext } from "./types";

const field = z.string().describe("A field from the metric's list: billing_interval, or plans.name for a joined one");

export const metricQuery = defineTool({
  name: "metric_query",
  effect: "read",
  time: "query",
  description:
    "Asks verified metrics (listed under Metrics) through the semantic layer: OpenDash compiles the query from definitions an admin verified and runs it. Returns its alias (q1, q2…), columns (the period, the dimensions, each metric, and <metric>_previous with a comparison) and rows. A question the definitions can't express comes back as an error that says why.",
  schema: z.object({
    title: z.string().describe("What it computes, in a few words: MRR by month"),
    metrics: z.array(z.string()).min(1).max(5).describe("Verified metrics by name, all on the same dataset"),
    dimensions: z.array(field).max(4).optional().describe("Group by these fields"),
    filters: z
      .array(
        z.object({
          field,
          op: z.enum(["=", "!=", "in", "not_in", ">", ">=", "<", "<=", "is_null", "is_not_null"]),
          value: z
            .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
            .optional()
            .describe("A list for in and not_in; a date as YYYY-MM-DD for a time field"),
        }),
      )
      .max(10)
      .optional(),
    segments: z.array(z.string()).optional().describe("Optional segments to add"),
    exclude_segments: z.array(z.string()).optional().describe("Default segments to lift, only when the user asks"),
    time: z
      .object({
        grain: z.enum(["day", "week", "month", "quarter", "year"]).optional().describe("One row per period"),
        range: z
          .union([
            z
              .string()
              .describe(
                "today, yesterday, this_week, last_week, this_month, last_month, this_quarter, last_quarter, this_year, last_year, month_to_date, year_to_date, or last_<n>_<days|weeks|months|quarters|years> (whole periods before the current one)",
              ),
            z.object({ from: z.string().describe("YYYY-MM-DD"), to: z.string().describe("YYYY-MM-DD, exclusive") }),
          ])
          .optional(),
        compare: z
          .literal("previous_period")
          .optional()
          .describe("Adds <metric>_previous: the period before each row's (for changes: pct, delta)"),
      })
      .optional(),
    order: z
      .array(z.object({ by: z.string().describe("An output column"), dir: z.enum(["asc", "desc"]) }))
      .max(4)
      .optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    source: sourceParam,
  }),
  async execute(input, ctx, call) {
    const { title, source: named, ...query } = input;
    const { deps, run } = ctx;
    const src = await ctx.sources.pick(named);
    if (!src) return unknownSource(named ?? "", ctx.sources);
    const elsewhere = src === ctx.sources.main ? {} : { source: src.name };
    const r = await runMetricQuery(ctx.gateway, {
      orgId: run.orgId,
      connectionId: src.connectionId,
      query,
      mode: "execute",
      title,
      requester: ctx.requester,
      toolCallId: call.rowId,
      signal: call.signal,
      ...(deps.now ? { now: deps.now() } : {}),
    });
    ctx.state.queries += 1;
    if (r.status !== "succeeded") {
      ctx.state.failedQueries += 1;
      const next = r.error?.fix ?? nextStep(r.error?.kind);
      return {
        value: { error: r.error, ...(next ? { next } : {}), warnings: r.warnings },
        queryRunId: r.queryRunId,
        summary: { failed: true, mode: "metric", title, kind: r.error?.kind, message: r.error?.message, ...elsewhere },
      };
    }
    const alias = await assignAlias(deps, run, r.queryRunId);
    return {
      value: {
        alias,
        title,
        ...elsewhere,
        path: "metric",
        columns: r.columns.map((c, i) => ({ name: c.name, type: c.type, role: r.roles?.[i]?.role })),
        rows: rowsForModel(r.columns, r.rows),
        rowCount: r.rowCount,
        ...(r.rowCount > BUDGETS.agent.rowsToModel ? { shown: BUDGETS.agent.rowsToModel } : {}),
        truncated: r.truncated,
        warnings: r.warnings,
      },
      queryRunId: r.queryRunId,
      summary: {
        mode: "metric",
        alias,
        title,
        ...elsewhere,
        metrics: input.metrics,
        rows: r.rowCount,
        truncated: r.truncated,
        durationMs: r.durationMs,
        warnings: r.warnings,
      },
    };
  },
});

/** One read-only statement through the gateway: checked (explain) or run (execute). */
async function sql(
  mode: "execute" | "explain",
  input: { sql: string; params?: { name: string; value: unknown }[] | undefined; title?: string; source?: string },
  ctx: ToolContext,
  call: { rowId: string; signal: AbortSignal },
) {
  const { deps, run } = ctx;
  const src = await ctx.sources.pick(input.source);
  if (!src) return unknownSource(input.source ?? "", ctx.sources);
  // Named on the result and the step when it isn't the main source: the answer says which source each came from.
  const elsewhere = src === ctx.sources.main ? {} : { source: src.name };
  const r = await runQuery(ctx.gateway, {
    orgId: run.orgId,
    connectionId: src.connectionId,
    sql: input.sql,
    ...(input.params?.length ? { params: input.params as never } : {}),
    mode,
    ...("title" in input ? { title: input.title } : {}),
    // SQL the model wrote: held to the database's advice.
    advise: true,
    requester: ctx.requester,
    toolCallId: call.rowId,
    signal: call.signal,
  });
  if (mode === "execute") ctx.state.queries += 1;
  if (r.status !== "succeeded") {
    ctx.state.failedQueries += 1;
    const next = r.error?.fix ?? nextStep(r.error?.kind);
    return {
      value: { error: r.error, ...(next ? { next } : {}), warnings: r.warnings },
      queryRunId: r.queryRunId,
      summary: {
        failed: true,
        mode,
        ...elsewhere,
        ...("title" in input ? { title: input.title } : {}),
        kind: r.error?.kind,
        message: r.error?.message,
        warnings: r.warnings,
        durationMs: r.durationMs,
      },
    };
  }
  if (mode === "explain") {
    return {
      value: { ok: true, warnings: r.warnings },
      queryRunId: r.queryRunId,
      summary: { mode, warnings: r.warnings, ...elsewhere },
    };
  }
  const alias = await assignAlias(deps, run, r.queryRunId);
  const names = r.columns.map((c) => c.name);
  const duplicates = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  return {
    value: {
      alias,
      ...("title" in input ? { title: input.title } : {}),
      ...elsewhere,
      columns: r.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: rowsForModel(r.columns, r.rows),
      rowCount: r.rowCount,
      ...(r.rowCount > BUDGETS.agent.rowsToModel ? { shown: BUDGETS.agent.rowsToModel } : {}),
      truncated: r.truncated,
      warnings: [
        ...r.warnings,
        ...(duplicates.length
          ? [`Columns ${duplicates.join(", ")} appear twice; give them distinct names so they can be cited.`]
          : []),
      ],
    },
    queryRunId: r.queryRunId,
    // What the run's steps show: "q1 · Churned MRR by plan", "98 ms · 2 rows".
    summary: {
      mode,
      alias,
      ...("title" in input ? { title: input.title } : {}),
      ...elsewhere,
      rows: r.rowCount,
      truncated: r.truncated,
      durationMs: r.durationMs,
      warnings: r.warnings,
    },
  };
}

export const sqlCheck = defineTool({
  name: "sql_check",
  effect: "read",
  time: "query",
  description:
    "Checks a query without running it: the statement, the tables, the values compared with columns, and the database's plan. Returns errors with the closest names.",
  schema: z.object({
    sql: z.string().describe("One read-only SELECT (WITH is fine)"),
    params,
    source: sourceParam,
  }),
  execute: (input, ctx, call) => sql("explain", input, ctx, call),
});

export const sqlQuery = defineTool({
  name: "sql_query",
  effect: "read",
  time: "query",
  description:
    "Runs one read-only query and returns its alias (q1, q2…), columns, up to the first rows, and warnings. Cite cells of it in the answer as ⟦alias:row:column⟧.",
  schema: z.object({
    title: z.string().describe("What the query computes, in a few words: MRR by month"),
    sql: z.string().describe("One read-only SELECT (WITH is fine). Aggregate here; name every output column."),
    params,
    source: sourceParam,
  }),
  execute: (input, ctx, call) => sql("execute", input, ctx, call),
});

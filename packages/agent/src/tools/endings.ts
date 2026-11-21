/**
 * The tools that end a run: the answer, which the gate checks and may send back for repair (`answer`), and a question
 * back to the person when no reading is defensible (`clarify`).
 */
import {
  type AnswerInput,
  BUDGETS,
  type CitableResult,
  type ClaimedRun,
  checkAnswer,
  citableResults,
  finishedToolCalls,
} from "@opendash/core";
import { sql } from "@opendash/db";
import { z } from "zod";
import type { AgentDeps } from "../harness/deps";
import { defineTool } from "./types";

/** The run's query results the answer may cite, as the gate reads them. */
export async function citable(deps: AgentDeps, run: ClaimedRun): Promise<CitableResult[]> {
  return (await citableResults(deps, run)).map((r) => ({
    alias: r.alias,
    queryRunId: r.id,
    columns: (r.result_schema ?? []).map((c) => ({
      name: c.name,
      type: c.type as CitableResult["columns"][0]["type"],
    })),
    rows: (r.preview ?? []) as CitableResult["rows"],
    path: r.path === "metric" ? "metric" : "raw_sql",
  }));
}

export const answer = defineTool({
  name: "answer",
  effect: "internal",
  description:
    "The final answer. The gate checks every reference and returns problems to fix; when it passes (or after the last repair) the run ends.",
  emptyWhenMissing: ["caveats"],
  schema: z.object({
    status: z.enum(["answered", "cannot_answer"]),
    markdown: z.string().describe("The answer, with every number as a reference: ⟦q1:0:mrr|currency:USD,compact⟧"),
    interpretation: z.array(z.string()).describe("Readings and defaults applied: 'Last month = September 2026'"),
    caveats: z.array(z.string()),
    cross_checks: z
      .array(
        z.object({
          headline: z.string().describe("The headline cell: q1:0:mrr"),
          check: z.string().describe("The same number from an independent query: q2:0:total"),
          differs_because: z.string().optional().describe("Only when the two differ on purpose (two definitions)"),
        }),
      )
      .optional(),
    charts: z
      .array(
        z.object({
          type: z.enum(["bar", "line"]).describe("bar for categories and comparisons, line for a trend over time"),
          title: z.string().describe("What it shows, in a few words: Churned MRR by plan, August vs September"),
          query: z.string().describe("The query alias it reads: q1"),
          x: z.string().describe("The column for the categories or the time axis"),
          y: z.array(z.string()).min(1).max(4).describe("Numeric columns, one series each: [mrr, mrr_previous]"),
          labels: z.array(z.string()).optional().describe("Series names for y, in order: [September, August]"),
          series_by: z
            .string()
            .optional()
            .describe("Instead: split one y column into a series per value of this column"),
          format: z.string().optional().describe("How values show, as for references: currency:USD,compact"),
          horizontal: z.boolean().optional().describe("Bars sideways, for long category names"),
        }),
      )
      .max(3)
      .optional()
      .describe("Drawn from one query's cells."),
    title: z.string().max(80).optional().describe("A short heading, in words"),
    figures: z
      .array(
        z.object({
          label: z.string().max(40),
          value: z.string().describe("One reference"),
          change: z.string().optional().describe("One reference: ⟦pct(q1:0:x,q1:1:x)⟧"),
          vs: z.string().max(40).optional().describe("vs last week"),
          detail: z.string().max(120).optional(),
          group: z.string().max(40).optional(),
          trend: z.boolean().optional().describe("Its column over time, from its query's date column"),
          trend_label: z.string().max(30).optional(),
        }),
      )
      .max(9)
      .optional()
      .describe("Headline figures, shown as cards"),
    next: z.array(z.string().max(120)).max(3).optional(),
    claims: z
      .array(
        z.object({
          kind: z.enum(["direction", "comparison", "rank"]),
          inputs: z.array(z.string()).describe("Cells: [current, previous] or [target, ...others]"),
          assertion: z.enum(["up", "down", "flat", "greater", "less", "equal", "highest", "lowest"]),
        }),
      )
      .optional(),
  }),
  async execute(input, { deps, run, definitions, askerNumbers }) {
    const previous = (await finishedToolCalls(deps, run, "answer")).length;
    const results = await citable(deps, run);
    const gate = checkAnswer(input as AnswerInput, {
      results,
      question: run.question,
      definitions,
      ...(askerNumbers ? { askerNumbers } : {}),
      rowsShown: BUDGETS.agent.rowsToModel,
    });
    // A run that tried to build or change a dashboard and saved nothing doesn't answer as if it's done: sent back once,
    // to fix the save or to say plainly what isn't built (status cannot_answer).
    const unsaved = input.status === "answered" && previous === 0 && (await dashboardUnsaved(deps, run));
    const problems = unsaved
      ? [
          ...gate.problems,
          "No save of the dashboard passed in this run, so nothing new is in its draft. Fix what was refused and save it again; or, if it can't be built now, answer with status cannot_answer, saying what isn't built and why.",
        ]
      : gate.problems;
    const last = previous >= BUDGETS.agent.answerRepairs;
    if ((gate.passed && !unsaved) || last) {
      return {
        // What the model reads, in this conversation and every later question's: the answer as shown. The cells behind
        // each number are worked out again from the ledger for the run's outcome (agents/analyst/outcome.ts).
        value: {
          accepted: true,
          // An undrawable chart on the last round is left out; only numbers, claims and checks decide this.
          verified: gate.verified,
          rendered: gate.rendered,
          caveats: gate.caveats,
          interpretation: gate.interpretation,
          problems: gate.problems,
        },
        summary: { accepted: true, verified: gate.verified, problems: gate.problems.length, ...gate.checked },
      };
    }
    return {
      value: { accepted: false, problems, repairsLeft: BUDGETS.agent.answerRepairs - previous },
      summary: { accepted: false, problems },
    };
  },
});

/** Whether this run's dashboard saves were refused by their checks and none passed. */
async function dashboardUnsaved(deps: AgentDeps, run: ClaimedRun): Promise<boolean> {
  const [row] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ tried: number; saved: number }>(sql`
      -- Tried: a save whose definition didn't pass its check (not one refused as another's dashboard).
      select count(*) filter (where result ? 'problems')::int as tried,
        count(*) filter (where result->>'saved' is not null)::int as saved
      from app.tool_call
      where org_id = ${run.orgId} and run_id = ${run.id} and tool in ('dashboard_page', 'dashboard_save')`),
  );
  return Boolean(row && row.tried > 0 && row.saved === 0);
}

export const clarify = defineTool({
  name: "clarify",
  effect: "internal",
  description:
    "Ask the user to choose between readings, when no default is defensible. Ask everything in this one call. Ends the run; their picks are their next message.",
  schema: z.object({
    questions: z
      .array(
        z.object({
          question: z.string().max(200),
          options: z.array(z.string().max(160).describe("A reading (under 120 characters)")).min(2).max(4),
          multiple: z.boolean().optional().describe("More than one may apply"),
        }),
      )
      .min(1)
      .max(4),
  }),
  execute: async () => ({ value: { asked: true } }),
});

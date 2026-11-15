/**
 * The Investigator (the second agent): a background run on the same loop as the
 * analyst's, for one insight. It reads and queries like the analyst, can't clarify, remember or change anything, ends
 * with its write-up (the `investigation` tool, through the answer gate), and keeps to its own budget: 40 tool calls,
 * 25 queries and $2.
 */
import {
  BUDGETS,
  type ClaimedRun,
  type ContextUse,
  checkAnswer,
  contextForRun,
  finishedToolCalls,
  type InvestigationOutcome,
  investigationSubject,
  recordContext,
  recordedContext,
} from "@opendash/core";
import { defineAgent } from "../../harness/agent";
import type { AgentDeps } from "../../harness/deps";
import { tablesFolder, tablesForPrompt } from "../../instructions/catalog";
import { glossaryForPrompt, glossaryNumbers } from "../../instructions/context";
import { metricsForPrompt } from "../../instructions/metrics";
import { citable } from "../../tools/endings";
import { grep, ls, read } from "../../tools/files";
import { asAnswer, type InvestigationInput, investigation } from "../../tools/investigation";
import { contextSearch, valueLookup } from "../../tools/knowledge";
import { metricQuery, sqlCheck, sqlQuery } from "../../tools/queries";
import { onlySource } from "../../tools/sources";
import type { AgentTool } from "../../tools/types";
import { loadSource } from "../analyst";
import { INVESTIGATION_NUDGE, INVESTIGATION_WRAP_UP, investigatorSections } from "./prompt";

/** Investigator: 40 tool calls, 25 queries, $2 per investigation. */
export const INVESTIGATOR_BUDGET = { maxSteps: 30, maxToolCalls: 40, maxQueries: 25, maxCostUsd: 2 };

/** Its tools: the analyst's to read and query, and its write-up. */
export const INVESTIGATOR_TOOLS: AgentTool[] = [
  metricQuery,
  sqlQuery,
  sqlCheck,
  ls,
  read,
  grep,
  valueLookup,
  contextSearch,
  investigation,
] as AgentTool[];

/** Its write-up, read from the ledger once accepted, with the gate run again for the traced pieces. */
export async function investigatorOutcome(deps: AgentDeps, run: ClaimedRun): Promise<InvestigationOutcome | null> {
  const [call] = await finishedToolCalls(deps, run, "investigation");
  const result = call?.result as { accepted?: boolean; verified?: boolean; problems?: string[] } | undefined;
  if (!call || !result?.accepted) return null;
  const args = call.args as unknown as InvestigationInput;
  const { glossary: definitions } = await recordedContext(deps, run);
  const gate = checkAnswer(asAnswer(args), {
    results: await citable(deps, run),
    question: run.question,
    definitions,
    rowsShown: BUDGETS.agent.rowsToModel,
  });
  return {
    kind: "investigation",
    confirmed: args.confirmed,
    verified: Boolean(result.verified),
    moved: { rendered: gate.rendered, segments: gate.segments.markdown },
    reasons: args.reasons.map((r, i) => ({
      weight: r.weight,
      rendered: gate.interpretation[i] ?? r.text,
      segments: gate.segments.interpretation[i] ?? [{ text: r.text }],
    })),
    unchecked: args.unchecked.map((u, i) => ({
      rendered: gate.caveats[i] ?? u,
      segments: gate.segments.caveats[i] ?? [{ text: u }],
    })),
    citations: gate.citations,
    problems: result.problems ?? [],
  };
}

export const investigator = defineAgent({
  name: "investigator",
  kind: "background",
  tools: INVESTIGATOR_TOOLS,

  async prepare(deps, run) {
    const source = await loadSource(deps, run);
    const [context, insight] = await deps.withTenant(run.orgId, async (tx) => [
      await contextForRun(tx, run.orgId, run.connectionId),
      await investigationSubject(tx, run.orgId, run.id),
    ]);
    if (!insight) throw new Error("This run has no insight to investigate.");
    // The glossary it was given, recorded with its versions, like the analyst's: what the gate lets it echo.
    const given: ContextUse[] = context.terms.map((t) => ({
      id: t.id,
      kind: "term" as const,
      title: t.spec.term,
      version: t.version,
      how: "glossary" as const,
    }));
    const definitions = glossaryNumbers(context.terms);
    if (given.length) await recordContext(deps, run, given, definitions);
    return {
      instructions: investigatorSections({
        sourceName: source.name,
        dialectName: source.dialect.name,
        dialectNotes: source.dialect.notes(),
        catalog: tablesForPrompt(source.tables, tablesFolder(source.name)),
        metrics: metricsForPrompt(source.semantic),
        glossary: glossaryForPrompt(context.terms),
        insight,
        now: (deps.now ?? (() => new Date()))(),
        rowsShown: BUDGETS.agent.rowsToModel,
        maxQueries: INVESTIGATOR_BUDGET.maxQueries,
      }),
      tools: INVESTIGATOR_TOOLS.filter((t) => source.semantic || t.name !== "metric_query"),
      context: { source, sources: onlySource(source), context, definitions, asker: null },
    };
  },

  outcome: investigatorOutcome,

  ending: {
    reached: (results) =>
      results.some(
        (r) => r.toolName === "investigation" && Boolean((r.output as { accepted?: boolean } | undefined)?.accepted),
      ),
    tools: ["investigation"],
    wrapUp: INVESTIGATION_WRAP_UP,
    nudge: INVESTIGATION_NUDGE,
    stopped: {
      unfinished: "The Investigator stopped without a write-up it could stand behind.",
      budget: "The investigation reached its $2 budget before its write-up.",
      time: "The Investigator ran out of time before its write-up.",
      failing: "The Investigator stopped unexpectedly.",
    },
  },
  budget: INVESTIGATOR_BUDGET,
});

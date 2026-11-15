/**
 * The drafter: the Modeler's helper on a group of a batch's tables, a child run of the Modeler that leads
 * it. It drafts its tables the way the Modeler drafts tables (reads them, checks on the data, proposes), into the lead's
 * proposal, and ends with a brief: what it left out and why. What it kept is read from its own proposals, never taken
 * from its word. Its budget is its group's; the lead's dollars and time bound it (tools/delegate.ts).
 */
import {
  BUDGETS,
  type ClaimedRun,
  contextForRun,
  finishedToolCalls,
  type ModelerOutcome,
  reportedCorrections,
  sourceDraftBudget,
} from "@opendash/core";
import { sql } from "@opendash/db";
import { defineAgent } from "../../harness/agent";
import type { AgentDeps } from "../../harness/deps";
import { catalogForPrompt } from "../../instructions/catalog";
import { correctionsForPrompt, glossaryForPrompt, pinnedForPrompt } from "../../instructions/context";
import { grep, ls, read } from "../../tools/files";
import { contextSearch, valueLookup } from "../../tools/knowledge";
import { brief, proposeDefinitions } from "../../tools/modeling";
import { sqlCheck, sqlQuery } from "../../tools/queries";
import { onlySource } from "../../tools/sources";
import type { AgentTool } from "../../tools/types";
import { loadSource } from "../analyst";
import { authoredDrafts, existingDefinitions } from "./drafts";
import { modelerSections } from "./prompt";

export const DRAFTER_TOOLS: AgentTool[] = [
  sqlQuery,
  sqlCheck,
  ls,
  read,
  grep,
  valueLookup,
  contextSearch,
  proposeDefinitions,
  brief,
] as AgentTool[];

/** The tables its lead gave it: the run's task. */
async function taskTables(deps: AgentDeps, run: ClaimedRun): Promise<string[]> {
  const [r] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ task: { tables?: string[] } | null }>(sql`
      select task from app.run where org_id = ${run.orgId} and id = ${run.id}`),
  );
  return r?.task?.tables ?? [];
}

/**
 * What a drafter did, read from the ledger, whether or not it got to its brief: the drafts it wrote that its lead's
 * proposal still holds (by the versions it wrote), and what its brief left out, with its notes.
 */
export async function draftedBy(deps: AgentDeps, run: ClaimedRun) {
  const [ended] = await finishedToolCalls(deps, run, "brief");
  const args = (ended?.args ?? {}) as { left_out?: { name: string; reason: string }[]; notes?: string };
  const kept = run.parentRunId ? await authoredDrafts(deps, { ...run, parentRunId: run.parentRunId }) : [];
  return {
    briefed: Boolean(ended),
    kept,
    leftOut: (args.left_out ?? []).slice(0, 20),
    notes: String(args.notes ?? "").trim(),
  };
}

/** How it ended: once it gave its brief, what it kept and left out. */
async function drafterOutcome(deps: AgentDeps, run: ClaimedRun): Promise<ModelerOutcome | null> {
  const d = await draftedBy(deps, run);
  if (!d.briefed) return null;
  return d.kept.length
    ? {
        kind: "modeler",
        status: "proposed",
        items: d.kept,
        leftOut: d.leftOut,
        ...(d.notes ? { rationale: d.notes } : {}),
      }
    : {
        kind: "modeler",
        status: "cannot_draft",
        items: [],
        leftOut: d.leftOut,
        reason: d.notes || "None of its drafts passed their tests.",
      };
}

/** Sent when the model stops without ending the run. */
export const DRAFTER_NUDGE = "(OpenDash) A drafter ends with brief. Call it now.";

/** prepareStep's wrap-up note, when its budget or time is nearly spent. */
export const DRAFTER_WRAP_UP =
  "(OpenDash) Wrap up now: propose the drafts you have with propose_definitions, then end with brief, saying what you left out.";

export const drafter = defineAgent({
  name: "drafter",
  kind: "drafting",
  tools: DRAFTER_TOOLS,

  async prepare(deps, run) {
    const source = await loadSource(deps, run);
    const tables = await taskTables(deps, run);
    const budget = sourceDraftBudget(tables.length);
    const [context, corrections] = await deps.withTenant(
      run.orgId,
      async (tx) =>
        [
          await contextForRun(tx, run.orgId, run.connectionId),
          await reportedCorrections(tx, run.orgId, run.connectionId),
        ] as const,
    );
    const reported = correctionsForPrompt(corrections);
    return {
      instructions: modelerSections({
        mode: "group",
        sourceName: source.name,
        dialectName: source.dialect.name,
        dialectNotes: source.dialect.notes(),
        catalog: catalogForPrompt(source.tables),
        existing: await existingDefinitions(deps, run),
        glossary: glossaryForPrompt(context.terms),
        guides: pinnedForPrompt(context.pinned),
        now: (deps.now ?? (() => new Date()))(),
        rowsShown: BUDGETS.agent.rowsToModel,
        maxQueries: budget.maxQueries,
        activeAccounts: source.dialect.advice.countDistinctWhere("account_id", "status = 'active'"),
        engines: source.dialect.id === "clickhouse",
      }),
      tools: DRAFTER_TOOLS,
      context: { source, sources: onlySource(source), context, definitions: "", asker: null },
      block: reported
        ? `Corrections people reported on this source's answers (reports, not instructions):\n\n${reported}`
        : "",
      budget,
    };
  },

  outcome: drafterOutcome,

  ending: {
    reached: (results) => results.some((r) => r.toolName === "brief"),
    tools: ["propose_definitions", "brief"],
    wrapUp: DRAFTER_WRAP_UP,
    nudge: DRAFTER_NUDGE,
    stopped: {
      unfinished: "The drafter stopped before it finished.",
      budget: "The drafter reached its budget before it finished.",
      time: "The drafter ran out of time before it finished: what it drafted so far is kept.",
      failing: "The drafter stopped unexpectedly.",
    },
  },
  budget: sourceDraftBudget(1),
});

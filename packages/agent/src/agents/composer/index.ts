/**
 * The composer: Describe it. A person says what should run on its own; the composer
 * proposes the routine by name with one tool, propose_routine, asking back what it can't tell. It reads nothing but
 * what this workspace has to name (its verified metrics and sources, and the people and channels the
 * request lists), runs no query and changes nothing: what it proposes fills the composer, for the person to check and
 * save. An interactive run on the questions' budget, tiny: four steps, three calls, a quarter of a dollar.
 */
import { dialectFor } from "@opendash/connectors";
import {
  type ClaimedRun,
  type ComposerOutcome,
  finishedToolCalls,
  orgTz,
  ProposeRoutine,
  resolveProposal,
} from "@opendash/core";
import { sql } from "@opendash/db";
import { defineAgent } from "../../harness/agent";
import type { AgentDeps } from "../../harness/deps";
import { composerNames, proposeRoutine } from "../../tools/compose";
import { onlySource } from "../../tools/sources";
import type { AgentTool, RunSource } from "../../tools/types";
import { COMPOSER_NUDGE, COMPOSER_WRAP_UP, composerSections } from "./prompt";

/**
 * Words into a routine should cost a cent or two. No queries at all: with none to spend, the harness has it wrap up
 * from its first step, which only narrows it to its one tool, propose_routine.
 */
export const COMPOSER_BUDGET = { maxSteps: 4, maxToolCalls: 3, maxQueries: 0, maxCostUsd: 0.25 };

export const COMPOSER_TOOLS: AgentTool[] = [proposeRoutine] as AgentTool[];

/** Its proposal once accepted, placed again against what the workspace has now (a resumed attempt finds it too). */
export async function composerOutcome(deps: AgentDeps, run: ClaimedRun): Promise<ComposerOutcome | null> {
  const calls = await finishedToolCalls(deps, run, "propose_routine");
  const call = calls.find((c) => Boolean((c.result as { accepted?: boolean } | null)?.accepted));
  if (!call) return null;
  const input = ProposeRoutine.safeParse(call.args);
  if (!input.success) return null;
  return resolveProposal(input.data, await composerNames(deps, run), run.askedBy ?? "").outcome;
}

/** Every run sits on a source; the composer's reads none of it, so it's just its name. */
async function bareSource(deps: AgentDeps, run: ClaimedRun): Promise<RunSource> {
  const [c] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ name: string; dialect: string }>(sql`
      select name, dialect from app.connection where org_id = ${run.orgId} and id = ${run.connectionId}`),
  );
  return {
    connectionId: run.connectionId,
    name: c?.name ?? "source",
    dialect: dialectFor(c?.dialect ?? "postgres"),
    tables: [],
    semantic: null,
  };
}

export const composer = defineAgent({
  name: "composer",
  kind: "interactive",
  tools: COMPOSER_TOOLS,

  async prepare(deps, run) {
    const names = await composerNames(deps, run);
    const source = await bareSource(deps, run);
    const tz = await deps.withTenant(run.orgId, (tx) => orgTz(tx, run.orgId));
    return {
      instructions: composerSections({
        metrics: names.choices.metrics.map((m) => ({ title: m.title, grain: m.grain, source: m.connectionName })),
        sources: names.choices.sources.map((s) => s.name),
        tz,
        now: (deps.now ?? (() => new Date()))(),
      }),
      tools: COMPOSER_TOOLS,
      context: {
        source,
        sources: onlySource(source),
        context: { terms: [], pinned: [], anchored: [] },
        definitions: "",
        asker: run.askedBy,
      },
    };
  },

  outcome: composerOutcome,

  ending: {
    reached: (results) =>
      results.some(
        (r) => r.toolName === "propose_routine" && Boolean((r.output as { accepted?: boolean } | undefined)?.accepted),
      ),
    tools: ["propose_routine"],
    wrapUp: COMPOSER_WRAP_UP,
    nudge: COMPOSER_NUDGE,
    stopped: {
      unfinished: "It couldn't work that out. Try saying it another way, or pick each part below.",
      budget: "It couldn't work that out within its budget. Pick each part below.",
      time: "It took too long to work that out. Try again, or pick each part below.",
      failing: "It stopped unexpectedly. Try again, or pick each part below.",
    },
  },
  budget: COMPOSER_BUDGET,
});

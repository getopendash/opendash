/**
 * The Curator: a drafting agent that turns people's corrections into one proposed glossary term, or says
 * why there's nothing to learn. It reads the source's tables and confirms values, and its only writing tool is its
 * ending, which writes nothing itself: code reads it from the ledger (`settleLearning`), then checks, tests and decides.
 */
import { type CuratorOutcome, contextForRun, finishedToolCalls, learningBrief } from "@opendash/core";
import { sql } from "@opendash/db";
import { defineAgent } from "../../harness/agent";
import { catalogForPrompt } from "../../instructions/catalog";
import { glossaryForPrompt } from "../../instructions/context";
import { grep, ls, read } from "../../tools/files";
import { valueLookup } from "../../tools/knowledge";
import { proposeLearning } from "../../tools/learning";
import { onlySource } from "../../tools/sources";
import type { AgentTool } from "../../tools/types";
import { loadSource } from "../analyst";
import { CURATOR_NUDGE, CURATOR_WRAP_UP, curatorSections } from "./prompt";

export const CURATOR_TOOLS: AgentTool[] = [ls, read, grep, valueLookup, proposeLearning] as AgentTool[];

export const curator = defineAgent({
  name: "curator",
  kind: "drafting",
  tools: CURATOR_TOOLS,

  async prepare(deps, run) {
    const source = await loadSource(deps, run);
    const [task] = await deps.withTenant(run.orgId, (tx) =>
      tx.execute<{ task: { proposalId?: string } | null }>(sql`
        select task from app.run where org_id = ${run.orgId} and id = ${run.id}`),
    );
    const [brief, context] = await deps.withTenant(
      run.orgId,
      async (tx) =>
        [
          await learningBrief(tx, run.orgId, task?.task?.proposalId ?? ""),
          await contextForRun(tx, run.orgId, run.connectionId),
        ] as const,
    );
    return {
      instructions: curatorSections({
        sourceName: source.name,
        dialectName: source.dialect.name,
        catalog: catalogForPrompt(source.tables),
        glossary: glossaryForPrompt(context.terms),
        corrections: (brief?.signals ?? []).map((s) => ({ at: s.at, text: s.text })),
        read: brief?.read ?? [],
        now: (deps.now ?? (() => new Date()))(),
      }),
      tools: CURATOR_TOOLS,
      context: { source, sources: onlySource(source), context, definitions: "", asker: null },
    };
  },

  async outcome(deps, run): Promise<CuratorOutcome | null> {
    const [ended] = await finishedToolCalls(deps, run, "propose_learning");
    const a = (ended?.args ?? null) as Record<string, unknown> | null;
    // Only an ending it accepted: one refused (a term without its quote) left the run going.
    if (!a || (ended?.result as { ended?: boolean } | null)?.ended !== true) return null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    if (a.learned !== true) {
      return { kind: "curator", status: "discarded", reason: String(a.reason ?? "").slice(0, 300) };
    }
    return {
      kind: "curator",
      status: "proposed",
      learning: {
        term: String(a.term ?? "").trim(),
        means: String(a.means ?? "").trim(),
        synonyms: list(a.synonyms).slice(0, 6),
        ...(typeof a.column === "string" ? { column: a.column } : {}),
        ...(list(a.values).length ? { values: list(a.values).slice(0, 10) } : {}),
        not: list(a.not).slice(0, 10),
        quote: String(a.quote ?? ""),
        question: String(a.question ?? ""),
      },
    };
  },

  ending: {
    reached: (results) =>
      results.some((r) => r.toolName === "propose_learning" && (r.output as { ended?: boolean })?.ended === true),
    tools: ["propose_learning"],
    wrapUp: CURATOR_WRAP_UP,
    nudge: CURATOR_NUDGE,
    stopped: {
      unfinished: "The Curator stopped before it proposed anything.",
      budget: "The Curator reached its budget before it proposed anything.",
      time: "The Curator ran out of time before it proposed anything.",
      failing: "The Curator stopped unexpectedly.",
    },
  },
  budget: { maxSteps: 12, maxToolCalls: 14, maxQueries: 6, maxCostUsd: 0.3 },
});

/**
 * The composer's ending: a routine proposed from someone's words, by name. OpenDash places each name
 * (a metric's, a source's, a person, a #channel) against what this person may use, and sends back what
 * it couldn't place for the model to fix; the last round is kept as it is, with what it couldn't place left open. It
 * changes nothing: the proposal fills the composer, and the person saves it.
 */
import {
  BUDGETS,
  type ComposerNames,
  composerBriefLists,
  composerChoices,
  finishedToolCalls,
  ProposeRoutine,
  resolveProposal,
} from "@opendash/core";
import { sql } from "@opendash/db";
import type { AgentDeps } from "../harness/deps";
import { defineTool } from "./types";

/** What this run may name: the composer's choices for its asker, and the people and channels its brief gave. */
export async function composerNames(
  deps: AgentDeps,
  run: { orgId: string; askedBy: string | null; question: string },
): Promise<ComposerNames> {
  const userId = run.askedBy ?? "";
  const { canManage, choices } = await deps.withTenant(run.orgId, async (tx) => {
    // The role is read live, never taken from the brief.
    const [r] = userId ? await tx.execute<{ role: string | null }>(sql`select app.member_role(${userId}) as role`) : [];
    const canManage = r?.role === "owner" || r?.role === "admin";
    return { canManage, choices: await composerChoices(tx, { orgId: run.orgId, userId, canManage }) };
  });
  const lists = composerBriefLists(run.question);
  return {
    choices,
    canManage,
    people: canManage ? lists.people : [],
    channels: canManage ? lists.channels : [],
  };
}

export const proposeRoutine = defineTool({
  name: "propose_routine",
  effect: "internal",
  emptyWhenMissing: ["questions"],
  description:
    "Propose the routine, which ends your work: what you could tell from their words, by name, and at most three questions for what you couldn't. Names OpenDash can't place come back to fix.",
  schema: ProposeRoutine,
  async execute(input, { deps, run }) {
    const previous = (await finishedToolCalls(deps, run, "propose_routine")).length;
    const names = await composerNames(deps, run);
    const { outcome, problems } = resolveProposal(input, names, run.askedBy ?? "");
    if (!problems.length || previous >= BUDGETS.agent.answerRepairs) {
      return {
        value: { accepted: true, ...(problems.length ? { leftOpen: problems } : {}) },
        summary: { accepted: true, open: outcome.open, questions: outcome.questions.length },
      };
    }
    return {
      value: { accepted: false, problems, repairsLeft: BUDGETS.agent.answerRepairs - previous },
      summary: { accepted: false, problems },
    };
  },
});

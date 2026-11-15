/**
 * Ask a question on a schedule: the Analyst answers it as background work, in a thread that's nobody's
 * conversation (channel `routine`, so it reads the workspace's knowledge, never a person's), within the background
 * budget. Answered, the answer stays in that conversation and is sent; an answer it couldn't give fails the run, saying
 * why.
 */

import { sql, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { type DeploymentKeys, defaultChoice } from "../../ai/settings";
import type { GatewayDeps } from "../../gateway/gateway";
import { enqueueOnce } from "../../jobs/boss";
import { agentBackgroundQueue } from "../../jobs/queues";
import { nextMessageSeq } from "../../runs/ledger";
import { BackgroundBudgetReached, checkBackgroundBudget } from "../../usage/limits";
import { holds } from "../deliver";
import { privateOwnerOf } from "../privacy";

/** `lost`: a later attempt of its job took the run over, so this one does nothing. */
export type QuestionStart = { status: "queued" } | { status: "failed"; error: string } | { status: "lost" };

/** Starts the Analyst on the question, once per routine run (a retried job finds the run it started). */
export async function startQuestion(
  deps: Pick<GatewayDeps, "withTenant"> & { boss: PgBoss; deploymentKeys: DeploymentKeys },
  r: { orgId: string; routineRunId: string; attempt: number; connectionId: string; question: string },
  now = new Date(),
): Promise<QuestionStart> {
  const { orgId } = r;
  return deps.withTenant(orgId, async (tx) => {
    if (!(await holds(tx, orgId, { id: r.routineRunId, attempt: r.attempt }))) return { status: "lost" };
    const [run] = await tx.execute<{ run_id: string | null }>(sql`
      select run_id from app.routine_run where org_id = ${orgId} and id = ${r.routineRunId}`);
    if (!run) return { status: "failed", error: "Its run is gone." };
    if (run.run_id) {
      await tx.execute(sql`
        update app.routine_run set status = 'writing', updated_at = now()
        where org_id = ${orgId} and id = ${r.routineRunId} and status = 'running'`);
      return { status: "queued" };
    }
    const [source] = await tx.execute(sql`
      select 1 from app.connection where org_id = ${orgId} and id = ${r.connectionId} and deleted_at is null`);
    if (!source) return { status: "failed", error: "Its source was removed." };
    try {
      await checkBackgroundBudget(tx, orgId, now);
    } catch (error) {
      if (!(error instanceof BackgroundBudgetReached)) throw error;
      return { status: "failed", error: error.message };
    }
    const threadId = uuidv7();
    const messageId = uuidv7();
    const runId = uuidv7();
    await tx.execute(sql`
      insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
      values (${orgId}, ${threadId}, ${r.connectionId}, ${privateOwnerOf(orgId, r.routineRunId)},
        ${r.question.slice(0, 120)}, 'routine', 'private')`);
    await tx.execute(sql`
      insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
      values (${orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, orgId, threadId)}, 'user', null,
        ${JSON.stringify({ role: "user", content: r.question })}::jsonb, ${r.question})`);
    const choice = await defaultChoice(tx, orgId, deps.deploymentKeys);
    await tx.execute(sql`
      insert into app.run (org_id, id, thread_id, trigger, profile, input_message_id, model, provider, reasoning)
      values (${orgId}, ${runId}, ${threadId}, 'routine', 'analyst', ${messageId}, ${choice.model}, ${choice.provider},
        ${choice.reasoning})`);
    // Its routine run now waits on the Analyst: the worker files the answer when the Analyst's run ends.
    await tx.execute(sql`
      update app.routine_run set run_id = ${runId}, status = 'writing', updated_at = now()
      where org_id = ${orgId} and id = ${r.routineRunId}`);
    await enqueueOnce(deps.boss, tx, agentBackgroundQueue, { orgId, runId }, { singletonKey: runId });
    return { status: "queued" };
  });
}

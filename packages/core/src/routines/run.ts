/**
 * The `routine.run` job: one run of a routine, claimed by each attempt of its job (a retry takes a running
 * run over: pg-boss hands a job out again only after giving up on the last attempt), its action done as the routine's
 * spec said when the run was made, and what it made handed to the outbox. A run that needs an agent (a scheduled
 * question) waits for the agent's run to end, then sends its answer (`finishAgentRun`). Every
 * stage is kept, so a retried job carries on where it stopped, and every write after the claim is the claiming
 * attempt's only (`holds`): an earlier attempt that comes back late changes nothing.
 */
import { sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { DeploymentKeys } from "../ai/settings";
import type { GatewayDeps } from "../gateway/gateway";
import { startQuestion } from "./actions/ask";
import { failRun, holds, queueSends, skipRun } from "./deliver";
import { asksOpenDash, needsManager, OWNER_CANT_REACH, type RoutineSpec, VIEWERS_DONT_ASK } from "./spec";
import { memberLeft, reconcileChecks } from "./store";

export type RunDeps = GatewayDeps & { boss: PgBoss; deploymentKeys: DeploymentKeys };

export type RunResult = "sending" | "writing" | "failed" | "skipped";

interface Claimed {
  id: string;
  /** The attempt that claimed it. */
  attempt: number;
  routineId: string;
  triggerKey: string;
  spec: RoutineSpec;
  insightIds: string[];
  ownerId: string;
}

export async function runRoutineRun(
  deps: RunDeps,
  job: { orgId: string; routineRunId: string },
  now = new Date(),
): Promise<RunResult> {
  const { orgId } = job;
  const claimed = await deps.withTenant(orgId, async (tx): Promise<Claimed | RunResult> => {
    const [r] = await tx.execute<{
      routine_id: string;
      trigger_key: string;
      spec: RoutineSpec;
      insight_ids: string[];
      attempt: number;
    }>(sql`
      update app.routine_run set status = 'running', attempt = attempt + 1, updated_at = now()
      where org_id = ${orgId} and id = ${job.routineRunId} and status in ('queued', 'running')
      returning routine_id, trigger_key, spec_snapshot as spec, insight_ids, attempt`);
    if (!r) return "skipped";
    const [routine] = await tx.execute<{
      owner_id: string;
      key: string | null;
      status: string;
      deleted: boolean;
      user_ids: string[];
      slack: unknown[];
    }>(sql`
      select owner_id, key, status, deleted_at is not null as deleted, user_ids, slack from app.routine
      where org_id = ${orgId} and id = ${r.routine_id} for update`);
    if (!routine || routine.deleted) {
      await skipRun(tx, orgId, job.routineRunId, "Its routine was deleted.");
      return "skipped";
    }
    if (routine.status !== "active") {
      await skipRun(tx, orgId, job.routineRunId, "Its routine is paused.");
      return "skipped";
    }
    // Nothing runs on behalf of someone who left: their routines pause, saying so.
    const [owner] = await tx.execute(sql`select 1 from app.member_recipient(${routine.owner_id})`);
    if (!owner) {
      await memberLeft(tx, orgId, routine.owner_id);
      await skipRun(tx, orgId, job.routineRunId, "Its owner left the workspace.");
      return "skipped";
    }
    // It runs only while its owner may make it: one that reaches past them, an owner or admin; one that asks, not a
    // viewer. A found routine's run only tells: its investigation was asked for (or, for a viewer's, not) before the
    // run was made.
    const reachesOthers = needsManager({
      key: routine.key,
      ownerId: routine.owner_id,
      userIds: routine.user_ids,
      slack: routine.slack,
    });
    const asks = r.spec.trigger === "schedule" && asksOpenDash(r.spec);
    if (reachesOthers || asks) {
      const [role] = await tx.execute<{ role: string | null }>(
        sql`select app.member_role(${routine.owner_id}) as role`,
      );
      const reason =
        reachesOthers && role?.role !== "owner" && role?.role !== "admin"
          ? OWNER_CANT_REACH
          : asks && role?.role === "viewer"
            ? VIEWERS_DONT_ASK
            : null;
      if (reason) {
        await tx.execute(sql`
          update app.routine set status = 'paused', paused_reason = ${reason}, updated_at = now()
          where org_id = ${orgId} and id = ${r.routine_id}`);
        // Paused, it reads nothing more: the checks only it needed go.
        if (r.spec.trigger === "found") await reconcileChecks(tx, orgId, now);
        await skipRun(tx, orgId, job.routineRunId, reason);
        return "skipped";
      }
    }
    return {
      id: job.routineRunId,
      attempt: r.attempt,
      routineId: r.routine_id,
      triggerKey: r.trigger_key,
      spec: r.spec,
      insightIds: r.insight_ids,
      ownerId: routine.owner_id,
    };
  });
  if (typeof claimed === "string") return claimed;
  try {
    return await perform(deps, orgId, claimed, now);
  } catch (error) {
    // Back in the queue for the job's retry, which claims it again (each stage is safe to run again); after the last
    // one, its dead letter fails it, and the streak counts it. Unwritten (the database gone too), the retry takes the
    // running run over all the same, and the error that stopped the work is the one reported.
    await deps
      .withTenant(orgId, (tx) =>
        tx.execute(sql`
          update app.routine_run set status = 'queued', updated_at = now()
          where org_id = ${orgId} and id = ${claimed.id} and status = 'running' and attempt = ${claimed.attempt}`),
      )
      .catch(() => {});
    throw error;
  }
}

/** A claimed run's work: its action, and its sends handed to the outbox, each written only while it holds the run. */
async function perform(deps: RunDeps, orgId: string, run: Claimed, now: Date): Promise<RunResult> {
  const held = <T extends RunResult>(write: (tx: TenantTx) => Promise<T>) =>
    deps.withTenant(
      orgId,
      async (tx): Promise<T | "skipped"> => ((await holds(tx, orgId, run)) ? write(tx) : "skipped"),
    );
  const fail = (error: string) =>
    held(async (tx) => {
      await failRun(tx, deps.boss, orgId, run.id, error);
      return "failed" as const;
    });
  const send = (payload: Parameters<typeof queueSends>[4]) =>
    held(async (tx) => {
      await queueSends(tx, deps.boss, orgId, { id: run.id, routineId: run.routineId }, payload);
      return "sending" as const;
    });
  const spec = run.spec;
  if (spec.trigger === "found") {
    if (!run.insightIds.length) {
      return held(async (tx) => {
        await skipRun(tx, orgId, run.id, "It had no findings to tell.");
        return "skipped" as const;
      });
    }
    return send({ kind: run.triggerKey.startsWith("roundup:") ? "roundup" : "alert", insightIds: run.insightIds });
  }
  const action = spec.action;
  if (action.kind === "digest") return send({ kind: "digest" });
  const started = await startQuestion(
    deps,
    { orgId, routineRunId: run.id, attempt: run.attempt, connectionId: action.connectionId, question: action.question },
    now,
  );
  if (started.status === "lost") return "skipped";
  return started.status === "queued" ? "writing" : fail(started.error);
}

/**
 * The agent's part of a routine run ended (the worker calls this when a background run of a routine's ends, however
 * it ended): its answer is sent, or the run fails saying why. The answer stays where it was asked, the run in the
 * routine's conversation, shared as widely as the routine reaches. Null when the agent run isn't a routine's, or its
 * routine run already moved on.
 */
export async function finishAgentRun(
  deps: Pick<GatewayDeps, "withTenant"> & { boss: PgBoss },
  orgId: string,
  agentRunId: string,
): Promise<RunResult | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [r] = await tx.execute<{
      id: string;
      routine_id: string;
      owner_id: string;
      key: string | null;
      user_ids: string[];
      slack: unknown[];
      thread_id: string;
      agent_status: string;
      outcome: { kind?: string; status?: string; reason?: string; question?: string } | null;
    }>(sql`
      select rr.id, rr.routine_id, ro.owner_id, ro.key, ro.user_ids, ro.slack, a.thread_id,
        a.status as agent_status, a.outcome
      from app.routine_run rr
      join app.routine ro on ro.org_id = rr.org_id and ro.id = rr.routine_id
      join app.run a on a.org_id = rr.org_id and a.id = rr.run_id
      where rr.org_id = ${orgId} and rr.run_id = ${agentRunId} and rr.status = 'writing'
      for update of rr`);
    if (!r || !["succeeded", "failed", "cancelled"].includes(r.agent_status)) return null;
    const answered = r.agent_status === "succeeded" && r.outcome?.kind === "answer" && r.outcome.status === "answered";
    if (!answered) {
      const why =
        r.outcome?.kind === "clarify"
          ? "It needed to ask something back. Make the question more specific."
          : `It wasn't answered${r.outcome?.reason ? `: ${r.outcome.reason}` : "."}`;
      await failRun(tx, deps.boss, orgId, r.id, why);
      return "failed" as const;
    }
    // Its readers read the conversation the answer is in, as the routine reaches now (it may have changed while the
    // answer was written): past its owner, the workspace's, with no owner; only its owner, theirs alone (privacy.ts).
    const team = needsManager({ key: r.key, ownerId: r.owner_id, userIds: r.user_ids, slack: r.slack });
    await tx.execute(sql`
      update app.thread set
        visibility = ${team ? "org" : "private"},
        created_by = ${team ? null : r.owner_id}
      where org_id = ${orgId} and id = ${r.thread_id}`);
    await queueSends(
      tx,
      deps.boss,
      orgId,
      { id: r.id, routineId: r.routine_id },
      { kind: "answer", runId: agentRunId },
    );
    return "sending" as const;
  });
}

/** The dead letter's part: a run whose job kept failing fails, and counts towards pausing its routine. */
export async function routineRunFailed(
  deps: Pick<GatewayDeps, "withTenant"> & { boss: PgBoss },
  job: { orgId: string; routineRunId: string },
): Promise<void> {
  await deps.withTenant(job.orgId, (tx) =>
    failRun(tx, deps.boss, job.orgId, job.routineRunId, "It couldn't finish, twice."),
  );
}

/**
 * Learning from corrections in the worker: every minute the Curator starts on corrections waiting for it,
 * and a learning a new correction joined is decided again; after a Curator run, its proposed term is checked on the
 * data, tested by one analyst run given it, graded on what that run's queries read, and decided: the rule releases it
 * when all five predicates hold, otherwise it waits for an approver's tap.
 */
import { type AgentDeps, runAttempt } from "@opendash/agent";
import {
  checkLearning,
  type DeploymentKeys,
  decideLearning,
  type GatewayDeps,
  gradeLearningTest,
  type LearningEvaluateJob,
  learningDispatchDeadLetter,
  learningDispatchQueue,
  learningEvaluateDeadLetter,
  learningEvaluateQueue,
  loggableError,
  startDueLearnings,
  startLearningTest,
} from "@opendash/core";
import { type SystemTx, sql } from "@opendash/db";
import type { PgBoss } from "pg-boss";

export interface LearningCtx extends GatewayDeps {
  boss: PgBoss;
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  deploymentKeys: () => DeploymentKeys;
  agentDeps: AgentDeps;
  workerId: string;
  drain: AbortSignal;
  log: (msg: string, fields?: Record<string, unknown>) => void;
  /** Tells a decided learning in Slack, where its corrections came from (when Slack is on). */
  tell?: (orgId: string, proposalId: string) => Promise<unknown> | null;
}

/** A decided learning told in Slack; Slack refusing it never fails the job. */
const told = async (ctx: LearningCtx, orgId: string, proposalId: string) => {
  try {
    await ctx.tell?.(orgId, proposalId);
  } catch (error) {
    ctx.log("learning not told in slack", { orgId, proposalId, error: loggableError(error) });
  }
};

export async function startLearning(ctx: LearningCtx): Promise<void> {
  const { boss } = ctx;
  await boss.work(learningDispatchQueue.name, async () => {
    const due = await startDueLearnings({ ...ctx, deploymentKeys: ctx.deploymentKeys() });
    if (due.started || due.held) ctx.log("learnings started", due);
    // A learning a new correction joined after it was structured: decided again (two people may now have said it).
    const again = await ctx.withSystem((tx) =>
      tx.execute<{ org_id: string; id: string }>(sql`
        select org_id, id from app.proposal
        where source = 'curator' and status = 'open' and (evidence->>'recheck')::boolean is true
        order by created_at limit 50`),
    );
    for (const p of again) {
      const decided = await decideLearning(ctx, p.org_id, p.id);
      if (decided?.automatic) ctx.log("learned for the team", { orgId: p.org_id, proposalId: p.id });
      if (decided) await told(ctx, p.org_id, p.id);
    }
  });
  await boss.schedule(learningDispatchQueue.name, "* * * * *");
  await boss.work(learningDispatchDeadLetter.name, async () => {
    ctx.log("learning dispatch dead-lettered; the next minute picks up what's due");
  });

  await boss.work<LearningEvaluateJob>(learningEvaluateQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const { orgId, proposalId } = job.data;
    const check = await checkLearning(ctx, orgId, proposalId);
    if (!check) return;
    // The test: one analyst run given the unreleased term, run here like an eval case, then graded.
    const runId = await startLearningTest({ ...ctx, deploymentKeys: ctx.deploymentKeys() }, orgId, proposalId);
    if (runId) {
      const attempt = await runAttempt(
        ctx.agentDeps,
        { orgId, runId },
        { workerId: ctx.workerId, signal: job.signal, drain: ctx.drain },
      );
      // Handed off at a shutdown: nothing is graded or decided yet. The job runs again, and its test goes on from
      // where it stopped (startLearningTest hands back the run it started).
      if (attempt?.status === "handed_off") {
        throw new Error("Handed off: the worker is shutting down; the learning's test goes on.");
      }
      await gradeLearningTest(ctx, orgId, proposalId);
    }
    const decided = await decideLearning(ctx, orgId, proposalId);
    ctx.log("learning evaluated", { orgId, proposalId, check: check.ok, ...decided });
    if (decided) await told(ctx, orgId, proposalId);
  });
  await boss.work<LearningEvaluateJob>(learningEvaluateDeadLetter.name, async ([job]) => {
    if (!job) return;
    // Its test never finished: decided on what it has, which the rule won't release. A failure here is thrown, so
    // the dead letter's own retries decide it rather than leaving it undecided.
    await decideLearning(ctx, job.data.orgId, job.data.proposalId);
    ctx.log("learning evaluation dead-lettered", { ...job.data });
  });
}

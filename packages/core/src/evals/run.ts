/**
 * Running the organization's evals (decisions 3 to 8). "Run now" (or the
 * nightly schedule) writes an eval_run and its job; the job syncs the suite and queues one job per case; each case job
 * recomputes the case's reference, asks the analyst as of the case's time, grades the answer and records the result;
 * whichever case writes the last result finishes the run, under a lock on the run row.
 */

import type { SystemTx, TenantTx } from "@opendash/db";
import { sql, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { Level } from "../ai/catalog";
import type { ProviderKind } from "../ai/kinds";
import { defaultChoice } from "../ai/settings";
import { displayMetric, type MetricFormat } from "../figures/metric";
import type { GatewayDeps, QueryReads } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { type EvalCaseJob, type EvalRunJob, evalCaseQueue, evalRunQueue } from "../jobs/queues";
import { gradeReads } from "../learning/curator";
import { loadSemanticModel } from "../semantic/definitions";
import { runMetricQuery } from "../semantic/run";
import { checkSpend, SpendLimitReached } from "../usage/limits";
import { type AnswerOutcome, type ExpectedNumber, expectedNumbers, gradeAnswer } from "./grade";
import { ensureSuite, getCase, syncCases } from "./suite";

/** A run with no news for this long is taken as dead: it stops blocking the next one. */
const STALE_RUN_MS = 2 * 3600_000;

/**
 * A case's ask stopped for a worker's shutdown: thrown through the case, so its job runs again rather than counting
 * the case as answered with an error.
 */
export class EvalHandedOff extends Error {}

export class EvalProblem extends Error {
  constructor(
    readonly code: "busy" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

type Deps = { withTenant: GatewayDeps["withTenant"]; boss: PgBoss };

/**
 * Starts a run of the organization's suite: one at a time (a second while one is queued or running is refused, as
 * the database also enforces). A run that has been going for hours with no result is taken as dead first.
 */
export async function startEvalRun(
  deps: Deps,
  input: { orgId: string; userId: string | null; trigger: "manual" | "schedule"; model?: string },
): Promise<{ evalRunId: string }> {
  try {
    return await deps.withTenant(input.orgId, async (tx) => {
      const suite = await ensureSuite(tx, input.orgId);
      await tx.execute(sql`
        update app.eval_run set status = 'failed', finished_at = now(),
          metrics = metrics || jsonb_build_object('stopped', ${"It stopped without finishing."}::text)
        where org_id = ${input.orgId} and suite_id = ${suite.id} and status in ('queued', 'running')
          and greatest(created_at, coalesce((select max(created_at) from app.eval_result r
            where r.org_id = eval_run.org_id and r.eval_run_id = eval_run.id), created_at))
            < now() - ${`${STALE_RUN_MS / 1000} seconds`}::interval`);
      const [busy] = await tx.execute(sql`
        select 1 from app.eval_run
        where org_id = ${input.orgId} and suite_id = ${suite.id} and status in ('queued', 'running')`);
      if (busy) throw new EvalProblem("busy", "A run is already going. Wait for it to finish.");
      // Evals spend like questions: none starts past a spend limit.
      await checkSpend(tx, input.orgId);
      const evalRunId = uuidv7();
      // Evals ask with the organization's default, as a question nobody chose a model for would.
      const choice = await defaultChoice(tx, input.orgId);
      const model = input.model ?? choice.model;
      await tx.execute(sql`
        insert into app.eval_run (org_id, id, suite_id, model, provider, reasoning, trigger, status, requested_by)
        values (${input.orgId}, ${evalRunId}, ${suite.id}, ${model}, ${choice.provider}, ${choice.reasoning},
          ${input.trigger}, 'queued', ${input.userId})`);
      const job: EvalRunJob = { orgId: input.orgId, evalRunId };
      await enqueueOnce(deps.boss, tx, evalRunQueue, job, { singletonKey: evalRunId });
      return { evalRunId };
    });
  } catch (error) {
    // Two starts at once: the one-active-run index refuses the second (the driver's error is the query error's cause).
    const pg = error as { code?: string; cause?: { code?: string } };
    if ((pg.code ?? pg.cause?.code) === "23505") {
      throw new EvalProblem("busy", "A run is already going. Wait for it to finish.");
    }
    throw error;
  }
}

/** A run whose start failed for good (dead-lettered): failed, with why, so it stops blocking the next one. */
export async function failEvalRun(deps: { withTenant: GatewayDeps["withTenant"] }, job: EvalRunJob): Promise<void> {
  await deps.withTenant(job.orgId, (tx) =>
    tx.execute(sql`
      update app.eval_run set status = 'failed', finished_at = now(),
        metrics = metrics || jsonb_build_object('stopped', ${"It couldn't start: its cases couldn't be read."}::text)
      where org_id = ${job.orgId} and id = ${job.evalRunId} and status in ('queued', 'running')`),
  );
}

/** The run's job: syncs the suite, fixes the run's cases, and queues one job for each. */
export async function beginEvalRun(deps: Deps, job: EvalRunJob): Promise<{ cases: number }> {
  return deps.withTenant(job.orgId, async (tx) => {
    const [run] = await tx.execute<{ status: string }>(sql`
      select status from app.eval_run where org_id = ${job.orgId} and id = ${job.evalRunId} for update`);
    if (run?.status !== "queued") return { cases: 0 };
    const cases = await syncCases(tx, job.orgId);
    const ids = cases.map((c) => c.id);
    await tx.execute(sql`
      update app.eval_run set status = ${ids.length ? "running" : "done"}, started_at = now(),
        finished_at = ${ids.length ? null : sql`now()`}, case_ids = ${JSON.stringify(ids)}::jsonb,
        metrics = ${JSON.stringify({ total: ids.length, done: 0, passed: 0, failed: 0, errors: 0, untraced: 0, calls: 0, costUsd: 0 } satisfies EvalRunMetrics)}::jsonb
      where org_id = ${job.orgId} and id = ${job.evalRunId}`);
    for (const caseId of ids) {
      const caseJob: EvalCaseJob = { orgId: job.orgId, evalRunId: job.evalRunId, caseId };
      await enqueueOnce(deps.boss, tx, evalCaseQueue, caseJob, { singletonKey: `${job.evalRunId}:${caseId}` });
    }
    return { cases: ids.length };
  });
}

/** What a case's answer was, as the analyst gave it. The worker asks; tests pass a stand-in. */
export interface EvalAnswer {
  runId: string | null;
  outcome: AnswerOutcome | null;
  usage: { modelCalls?: number; costUsd?: number };
  error?: string;
  /** The question was refused before the analyst ran (a spend limit), rather than the analyst stopping. */
  refused?: boolean;
}
export type EvalAsk = (input: {
  orgId: string;
  connectionId: string;
  question: string;
  asOf: Date;
  model: string;
  provider: ProviderKind;
  reasoning: Level;
}) => Promise<EvalAnswer>;

/** A run's progress and score, kept on the run as its results come in. */
export interface EvalRunMetrics {
  total: number;
  done: number;
  passed: number;
  failed: number;
  errors: number;
  untraced: number;
  calls: number;
  costUsd: number;
}

export interface EvalResultDiff {
  reason: string;
  expected: ExpectedNumber[];
  cited: { value: number; display: string }[];
  /** The answer as people read it, cut at 2,000 characters. */
  answer: string | null;
  path: string | null;
  untraced: boolean;
  asOf: string;
  usage: { modelCalls: number; costUsd: number };
  /** How long the analyst took to answer. */
  seconds?: number;
}

/**
 * One case of a run: its reference (recomputed as of the case's time), the analyst's answer as of the same time, the
 * grade. A case already graded in this run is skipped (a resumed or repeated job), and a run that isn't running
 * any more runs nothing.
 */
export async function executeEvalCase(deps: GatewayDeps, job: EvalCaseJob, ask: EvalAsk): Promise<void> {
  const found = await deps.withTenant(job.orgId, async (tx) => {
    const [run] = await tx.execute<{
      status: string;
      started_at: string | null;
      model: string;
      provider: ProviderKind;
      reasoning: Level;
    }>(sql`
      select status, started_at, model, provider, reasoning from app.eval_run
      where org_id = ${job.orgId} and id = ${job.evalRunId}`);
    const [done] = await tx.execute(sql`
      select 1 from app.eval_result where org_id = ${job.orgId} and eval_run_id = ${job.evalRunId}
        and case_id = ${job.caseId}`);
    if (run?.status !== "running" || done) return null;
    const c = await getCase(tx, job.orgId, job.caseId);
    if (!c) return null;
    const model = await loadSemanticModel(tx, job.orgId, c.connectionId);
    const formatOf = (metric: string): MetricFormat => {
      const m = model?.model.metrics.get(metric);
      const measure = m ? model?.model.datasets.get(m.dataset)?.measures.find((x) => x.name === m.measure) : undefined;
      return (m?.format ?? measure?.format ?? "number") as MetricFormat;
    };
    return { run, c, formatOf };
  });
  if (!found) return;
  const { run, c, formatOf } = found;
  const asOf = new Date(c.asOf ?? run.started_at ?? Date.now());
  const base = { asOf: asOf.toISOString(), expected: [] as ExpectedNumber[], cited: [], answer: null, path: null };
  // A structural case: no reference to compute; graded on what the answer's queries read.
  if (c.expect) return executeStructural(deps, job, ask, { c, run, asOf, base });
  if (!c.referenceSpec) return;
  const reference = await runMetricQuery(deps, {
    orgId: job.orgId,
    connectionId: c.connectionId,
    query: c.referenceSpec,
    mode: "execute",
    title: `Eval · ${c.question}`,
    requester: { type: "eval", id: job.evalRunId },
    now: asOf,
  });
  const ungradable = (reason: string) =>
    recordEvalResult(deps, job, {
      verdict: "error",
      runId: null,
      referenceQrId: reference.queryRunId,
      diff: { ...base, reason, untraced: false, usage: { modelCalls: 0, costUsd: 0 } },
    });
  if (reference.status !== "succeeded" || !reference.roles) {
    return ungradable(`Its reference didn't run: ${reference.error?.message ?? reference.status}.`);
  }
  const expected = expectedNumbers(reference.roles, reference.rows, (value, column) =>
    displayMetric(formatOf(column.source), value),
  );
  if (!expected.length) return ungradable("Its reference has no value to check against (no rows, or only nulls).");
  const asked = Date.now();
  const answer = await ask({
    orgId: job.orgId,
    connectionId: c.connectionId,
    question: c.question,
    asOf,
    model: run.model,
    provider: run.provider,
    reasoning: run.reasoning,
  }).catch((error: unknown): EvalAnswer => {
    if (error instanceof EvalHandedOff) throw error;
    return {
      runId: null,
      outcome: null,
      usage: {},
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof SpendLimitReached ? { refused: true } : {}),
    };
  });
  const usage = { modelCalls: answer.usage.modelCalls ?? 0, costUsd: Number(answer.usage.costUsd ?? 0) };
  const seconds = Math.round((Date.now() - asked) / 100) / 10;
  if (answer.error) {
    return recordEvalResult(deps, job, {
      verdict: "error",
      runId: answer.runId,
      referenceQrId: reference.queryRunId,
      diff: {
        ...base,
        expected,
        reason: answer.refused ? `Refused: ${answer.error}` : `The analyst stopped: ${answer.error}`,
        untraced: false,
        usage,
        seconds,
      },
    });
  }
  const graded = gradeAnswer(expected, answer.outcome);
  await recordEvalResult(deps, job, {
    verdict: graded.verdict,
    runId: answer.runId,
    referenceQrId: reference.queryRunId,
    diff: {
      ...base,
      expected,
      cited: graded.cited,
      reason: graded.reason,
      answer: answer.outcome?.rendered?.slice(0, 2000) ?? null,
      path: answer.outcome?.path ?? null,
      untraced: graded.untraced,
      usage,
      seconds,
    },
  });
}

/** A structural case's run: the analyst asked, then graded on the tables and filters its queries read. */
async function executeStructural(
  deps: GatewayDeps,
  job: EvalCaseJob,
  ask: EvalAsk,
  p: {
    c: NonNullable<Awaited<ReturnType<typeof getCase>>>;
    run: { model: string; provider: ProviderKind; reasoning: Level };
    asOf: Date;
    base: { asOf: string; expected: ExpectedNumber[]; cited: never[]; answer: null; path: null };
  },
): Promise<void> {
  const expect = p.c.expect;
  if (!expect) return;
  const asked = Date.now();
  const answer = await ask({
    orgId: job.orgId,
    connectionId: p.c.connectionId,
    question: p.c.question,
    asOf: p.asOf,
    model: p.run.model,
    provider: p.run.provider,
    reasoning: p.run.reasoning,
  }).catch((error: unknown): EvalAnswer => {
    if (error instanceof EvalHandedOff) throw error;
    return {
      runId: null,
      outcome: null,
      usage: {},
      error: error instanceof Error ? error.message : String(error),
      ...(error instanceof SpendLimitReached ? { refused: true } : {}),
    };
  });
  const usage = { modelCalls: answer.usage.modelCalls ?? 0, costUsd: Number(answer.usage.costUsd ?? 0) };
  const seconds = Math.round((Date.now() - asked) / 100) / 10;
  const reads = answer.runId
    ? await deps.withTenant(job.orgId, (tx) =>
        tx.execute<{ reads: QueryReads }>(sql`
          select reads from app.query_run
          where org_id = ${job.orgId} and requester_type = 'run' and requester_id = ${answer.runId}
            and status = 'succeeded' and reads is not null`),
      )
    : [];
  const graded = answer.error
    ? { ok: false, why: answer.refused ? `Refused: ${answer.error}` : `The analyst stopped: ${answer.error}` }
    : gradeReads(
        expect,
        reads.map((r) => r.reads),
      );
  await recordEvalResult(deps, job, {
    verdict: answer.error ? "error" : graded.ok ? "pass" : "fail",
    runId: answer.runId,
    referenceQrId: null,
    diff: {
      ...p.base,
      reason: graded.ok
        ? `It read ${expect.reads}${expect.compared ? ` with ${expect.compared.column} = ${expect.compared.values.join(", ")}` : ""}.`
        : (graded.why ?? "It didn't read what the learning says."),
      answer: answer.outcome?.rendered?.slice(0, 2000) ?? null,
      path: answer.outcome?.path ?? null,
      untraced: false,
      usage,
      seconds,
    },
  });
}

/**
 * Records a case's result (once: a repeated job changes nothing) and, if it was the run's last, finishes the run.
 * The run row is locked first, then the result written and the results counted, so cases finishing together take
 * turns and finish it exactly once. (Locked after the insert, two of them deadlock: each insert holds a key-share
 * lock on the run through its foreign key.)
 */
export async function recordEvalResult(
  deps: { withTenant: GatewayDeps["withTenant"] },
  job: EvalCaseJob,
  result: {
    verdict: "pass" | "fail" | "error";
    runId: string | null;
    referenceQrId: string | null;
    diff: EvalResultDiff;
  },
): Promise<void> {
  await deps.withTenant(job.orgId, async (tx) => {
    await tx.execute(sql`
      select 1 from app.eval_run where org_id = ${job.orgId} and id = ${job.evalRunId} for no key update`);
    await tx.execute(sql`
      insert into app.eval_result (org_id, eval_run_id, case_id, run_id, reference_qr_id, verdict, diff)
      values (${job.orgId}, ${job.evalRunId}, ${job.caseId}, ${result.runId}, ${result.referenceQrId},
        ${result.verdict}, ${JSON.stringify(result.diff)}::jsonb)
      on conflict do nothing`);
    await finishIfDone(tx, job.orgId, job.evalRunId);
  });
}

async function finishIfDone(tx: TenantTx, orgId: string, evalRunId: string): Promise<void> {
  // The caller holds the run's lock.
  const [run] = await tx.execute<{ status: string; total: number }>(sql`
    select status, jsonb_array_length(case_ids) as total from app.eval_run
    where org_id = ${orgId} and id = ${evalRunId}`);
  if (run?.status !== "running") return;
  const [m] = await tx.execute<{
    done: number;
    passed: number;
    failed: number;
    errors: number;
    untraced: number;
    calls: number;
    cost: string;
  }>(sql`
    select count(*)::int as done, (count(*) filter (where verdict = 'pass'))::int as passed,
      (count(*) filter (where verdict = 'fail'))::int as failed, (count(*) filter (where verdict = 'error'))::int as errors,
      (count(*) filter (where (diff->>'untraced')::boolean))::int as untraced,
      coalesce(sum((diff->'usage'->>'modelCalls')::int), 0)::int as calls,
      round(coalesce(sum((diff->'usage'->>'costUsd')::numeric), 0), 6)::text as cost
    from app.eval_result where org_id = ${orgId} and eval_run_id = ${evalRunId}`);
  const { cost, ...counts } = m ?? { done: 0, passed: 0, failed: 0, errors: 0, untraced: 0, calls: 0, cost: "0" };
  const metrics: EvalRunMetrics = { total: run.total, ...counts, costUsd: Number(cost) };
  const finished = metrics.done >= run.total;
  await tx.execute(sql`
    update app.eval_run set metrics = ${JSON.stringify(metrics)}::jsonb,
      status = ${finished ? "done" : "running"}, finished_at = ${finished ? sql`now()` : sql`null`}
    where org_id = ${orgId} and id = ${evalRunId}`);
}

/** A case job that died (dead-lettered): an error result, so the run still finishes. */
export async function failEvalCase(deps: { withTenant: GatewayDeps["withTenant"] }, job: EvalCaseJob) {
  await recordEvalResult(deps, job, {
    verdict: "error",
    runId: null,
    referenceQrId: null,
    diff: {
      reason: "The check stopped before it finished.",
      expected: [],
      cited: [],
      answer: null,
      path: null,
      untraced: false,
      asOf: new Date().toISOString(),
      usage: { modelCalls: 0, costUsd: 0 },
    },
  });
}

/** The nightly run, for each organization that turned it on. A run already going is left alone. */
export async function dispatchNightlyEvals(
  deps: Deps & { withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T> },
): Promise<{ started: number }> {
  const orgs = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string }>(sql`select org_id from app.eval_suite where scope = 'org' and nightly`),
  );
  let started = 0;
  for (const { org_id } of orgs) {
    try {
      await startEvalRun(deps, { orgId: org_id, userId: null, trigger: "schedule" });
      started += 1;
    } catch (error) {
      // Busy, or past a spend limit: that organization waits for tomorrow night.
      if (!(error instanceof EvalProblem) && !(error instanceof SpendLimitReached)) throw error;
    }
  }
  return { started };
}

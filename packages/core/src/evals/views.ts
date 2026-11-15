/**
 * What Knowledge → Evals shows: the suite with each case's last result and the recent runs, and one run
 * with every case's result. Admins only; the API checks the role.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { EvalResultDiff, EvalRunMetrics } from "./run";
import { ensureSuite, syncCases } from "./suite";

export interface EvalRunSummary {
  id: string;
  status: "queued" | "running" | "done" | "failed";
  trigger: string;
  requestedBy: string | null;
  metrics: Partial<EvalRunMetrics>;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface EvalCaseView {
  id: string;
  question: string;
  origin: "onboarding" | "admin" | "correction";
  originRef: string | null;
  /** What it checks: the metric's title, for a case made from a metric. */
  metric: string | null;
  connectionId: string;
  asOf: string | null;
  active: boolean;
  last: { verdict: string; reason: string; path: string | null; evalRunId: string; at: string } | null;
}

export interface EvalOverview {
  nightly: boolean;
  cases: EvalCaseView[];
  runs: EvalRunSummary[];
}

export interface EvalResultView {
  caseId: string;
  question: string;
  origin: "onboarding" | "admin" | "correction";
  verdict: "pass" | "fail" | "error" | "pending";
  diff: EvalResultDiff | null;
  runId: string | null;
  referenceQrId: string | null;
}

type RunRow = {
  id: string;
  status: EvalRunSummary["status"];
  trigger: string;
  requested_by: string | null;
  metrics: Partial<EvalRunMetrics>;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);
const runOf = (r: RunRow): EvalRunSummary => ({
  id: r.id,
  status: r.status,
  trigger: r.trigger,
  requestedBy: r.requested_by,
  metrics: r.metrics,
  createdAt: iso(r.created_at) as string,
  startedAt: iso(r.started_at),
  finishedAt: iso(r.finished_at),
});

/**
 * The suite (made if it isn't yet), its active cases with their last results, and the last 10 runs. The cases are
 * synced first, so a metric verified a minute ago is listed (syncing writes nothing when nothing changed), except
 * while a run is going: it fixed its cases when it started, and the page polls.
 */
export async function evalOverview(tx: TenantTx, orgId: string): Promise<EvalOverview> {
  const suite = await ensureSuite(tx, orgId);
  const [going] = await tx.execute(sql`
    select 1 from app.eval_run where org_id = ${orgId} and suite_id = ${suite.id} and status in ('queued', 'running')`);
  if (!going) await syncCases(tx, orgId);
  const cases = await tx.execute<{
    id: string;
    question: string;
    origin: EvalCaseView["origin"];
    origin_ref: string | null;
    metric: string | null;
    connection_id: string;
    as_of: string | null;
    active: boolean;
    verdict: string | null;
    diff: EvalResultDiff | null;
    eval_run_id: string | null;
    at: string | null;
  }>(sql`
    select c.id, c.question, c.origin, c.origin_ref, c.connection_id, c.as_of, c.active,
      case when c.origin = 'onboarding' then i.title end as metric,
      l.verdict, l.diff, l.eval_run_id, l.created_at as at
    from app.eval_case c
    left join app.context_item i on i.org_id = c.org_id and i.id = c.origin_ref
    left join lateral (
      select r.verdict, r.diff, r.eval_run_id, r.created_at from app.eval_result r
      where r.org_id = c.org_id and r.case_id = c.id order by r.created_at desc limit 1
    ) l on true
    where c.org_id = ${orgId} and c.suite_id = ${suite.id} and c.active
    order by (l.verdict = 'fail' or l.verdict = 'error') desc nulls last, (c.origin = 'admin') desc, c.question`);
  const runs = await tx.execute<RunRow>(sql`
    select id, status, trigger, requested_by, metrics, created_at, started_at, finished_at from app.eval_run
    where org_id = ${orgId} and suite_id = ${suite.id} order by created_at desc limit 10`);
  return {
    nightly: suite.nightly,
    cases: cases.map((c) => ({
      id: c.id,
      question: c.question,
      origin: c.origin,
      originRef: c.origin_ref,
      metric: c.metric,
      connectionId: c.connection_id,
      asOf: iso(c.as_of),
      active: c.active,
      last:
        c.verdict && c.eval_run_id && c.at
          ? {
              verdict: c.verdict,
              reason: c.diff?.reason ?? "",
              path: c.diff?.path ?? null,
              evalRunId: c.eval_run_id,
              at: iso(c.at) as string,
            }
          : null,
    })),
    runs: runs.map(runOf),
  };
}

/** One run with every case it checks: failed and errored first, then passed, then those still to come. */
export async function evalRunDetail(
  tx: TenantTx,
  orgId: string,
  evalRunId: string,
): Promise<(EvalRunSummary & { results: EvalResultView[] }) | null> {
  if (!isUuid(evalRunId)) return null;
  const [run] = await tx.execute<RunRow & { case_ids: string[] }>(sql`
    select id, status, trigger, requested_by, metrics, created_at, started_at, finished_at, case_ids
    from app.eval_run where org_id = ${orgId} and id = ${evalRunId}`);
  if (!run) return null;
  const rows = await tx.execute<{
    id: string;
    question: string;
    origin: EvalResultView["origin"];
    verdict: EvalResultView["verdict"] | null;
    diff: EvalResultDiff | null;
    run_id: string | null;
    reference_qr_id: string | null;
  }>(sql`
    select c.id, c.question, c.origin, r.verdict, r.diff, r.run_id, r.reference_qr_id
    from app.eval_case c
    left join app.eval_result r on r.org_id = c.org_id and r.eval_run_id = ${evalRunId} and r.case_id = c.id
    where c.org_id = ${orgId} and c.id in (select (jsonb_array_elements_text(${JSON.stringify(run.case_ids)}::jsonb))::uuid)
    order by case r.verdict when 'fail' then 0 when 'error' then 1 when 'pass' then 2 else 3 end, c.question`);
  return {
    ...runOf(run),
    results: rows.map((r) => ({
      caseId: r.id,
      question: r.question,
      origin: r.origin,
      verdict: r.verdict ?? "pending",
      diff: r.diff,
      runId: r.run_id,
      referenceQrId: r.reference_qr_id,
    })),
  };
}

/** Turns the nightly run on or off. */
export async function setNightlyEvals(tx: TenantTx, orgId: string, nightly: boolean): Promise<void> {
  const suite = await ensureSuite(tx, orgId);
  await tx.execute(sql`
    update app.eval_suite set nightly = ${nightly}, updated_at = now() where org_id = ${orgId} and id = ${suite.id}`);
}

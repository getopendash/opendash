/**
 * A done task's outcome check (the `outcome.check` job): its metric's months around the task through the
 * gateway (so the values are query-run cells), judged by tasks/outcome.ts. A horizon month that hasn't landed waits a
 * day, for up to two weeks, before the check says it's inconclusive.
 */
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { SeriesPoint } from "../checks/detect";
import { displayMetric, type MetricFormat } from "../figures/metric";
import type { GatewayDeps } from "../gateway/gateway";
import { runMetricQuery } from "../semantic/run";
import { addMonths, checkAt, judgeOutcome, type OutcomeJudgement, type OutcomeSpec } from "./outcome";

/** How long a check waits for its horizon's last month before it's inconclusive. */
const WAIT_DAYS = 14;

type CheckSpec = OutcomeSpec & { metricId: string; connectionId: string };

export async function checkOutcome(
  deps: GatewayDeps,
  job: { orgId: string; todoId: string },
  now = new Date(),
): Promise<{ status: "checked" | "waiting" | "skipped"; verdict?: string }> {
  const t = await deps.withTenant(job.orgId, async (tx) => {
    const [row] = await tx.execute<{
      check_spec: CheckSpec | null;
      done_at: string;
      slug: string | null;
      title: string | null;
      format: string | null;
      usable: boolean | null;
    }>(sql`
      select t.check_spec, t.done_at, i.slug, i.title, v.spec->>'format' as format,
        (c.deleted_at is null and c.status <> 'disabled') as usable
      from app.todo t
      left join app.context_item i on i.org_id = t.org_id and i.id = t.metric_id and i.kind = 'metric'
        and i.deleted_at is null and i.released_version is not null
      left join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
      left join app.connection c on c.org_id = t.org_id and c.id = t.connection_id
      where t.org_id = ${job.orgId} and t.id = ${job.todoId} and t.status = 'done' and t.check_no = 0`);
    return row ?? null;
  });
  if (!t?.check_spec) return { status: "skipped" };
  const spec = t.check_spec;
  const write = (
    judged: OutcomeJudgement,
    queryRunId: string | null,
    format: MetricFormat,
    column: string,
    decimals = 2,
  ) => deps.withTenant(job.orgId, (tx) => saveOutcome(tx, job, judged, queryRunId, format, column, decimals));
  if (!t.slug || !t.title) {
    await write(
      { verdict: "inconclusive", reason: "Its metric was deleted, or isn't verified any more." },
      null,
      "number",
      "",
    );
    return { status: "checked", verdict: "inconclusive" };
  }
  if (!t.usable) {
    await write({ verdict: "inconclusive", reason: "Its source was removed or turned off." }, null, "number", t.slug);
    return { status: "checked", verdict: "inconclusive" };
  }
  const outcome = await runMetricQuery(deps, {
    orgId: job.orgId,
    connectionId: spec.connectionId,
    query: {
      metrics: [t.slug],
      time: {
        grain: "month",
        range: { from: addMonths(spec.fromMonth, -10), to: addMonths(spec.fromMonth, spec.horizonMonths) },
      },
    },
    mode: "execute",
    title: `Outcome · ${t.title}`,
    requester: { type: "task", id: job.todoId },
    now,
  });
  const format = (t.format ?? "number") as MetricFormat;
  if (outcome.status !== "succeeded") {
    await write(
      { verdict: "inconclusive", reason: outcome.error?.message ?? "Its query didn't finish." },
      outcome.queryRunId,
      format,
      t.slug,
    );
    return { status: "checked", verdict: "inconclusive" };
  }
  const names = outcome.columns.map((c) => c.name);
  const at = { month: names.indexOf("month"), value: names.indexOf(t.slug) };
  const points: SeriesPoint[] = outcome.rows.map((r, row) => {
    const raw = at.value >= 0 ? r[at.value] : null;
    const value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    return {
      period: String(at.month >= 0 ? r[at.month] : "").slice(0, 10),
      value: Number.isFinite(value) ? value : null,
      row,
    };
  });
  const judged = judgeOutcome(points, spec);
  const waited = now.getTime() - checkAt(new Date(t.done_at), spec.horizonMonths).getTime();
  if (
    judged.verdict === "inconclusive" &&
    /horizon's last month/.test(judged.reason ?? "") &&
    waited < WAIT_DAYS * 86_400_000
  ) {
    return { status: "waiting" };
  }
  // The projection is an estimate: shown as precisely as the metric's own values are (91 for a count).
  const decimals = Math.min(
    2,
    Math.max(0, ...points.map((p) => (p.value === null ? 0 : (String(p.value).split(".")[1] ?? "").length))),
  );
  await write(judged, outcome.queryRunId, format, t.slug, decimals);
  return { status: "checked", verdict: judged.verdict };
}

async function saveOutcome(
  tx: TenantTx,
  job: { orgId: string; todoId: string },
  j: OutcomeJudgement,
  queryRunId: string | null,
  format: MetricFormat,
  column: string,
  decimals: number,
) {
  const cell = (p: { period: string; value: number; row: number } | undefined) =>
    p && queryRunId ? { ...p, queryRunId, column, display: displayMetric(format, p.value) } : undefined;
  const counterfactual = {
    method: "prior_trend",
    ...(j.reason ? { reason: j.reason } : {}),
    ...(j.baseline ? { baseline: cell(j.baseline) } : {}),
    ...(j.observed ? { observed: cell(j.observed) } : {}),
    ...(j.projected !== undefined
      ? { projected: { value: j.projected, display: displayMetric(format, Number(j.projected.toFixed(decimals))) } }
      : {}),
    ...(j.trend ? { trend: j.trend } : {}),
  };
  await tx.execute(sql`
    insert into app.outcome (org_id, id, todo_id, check_no, baseline, observed, counterfactual, delta, query_run_ids, verdict)
    values (${job.orgId}, ${uuidv7()}, ${job.todoId}, 1, ${j.baseline?.value ?? null}, ${j.observed?.value ?? null},
      ${JSON.stringify(counterfactual)}::jsonb, ${j.delta ?? null}, ${`{${queryRunId ?? ""}}`}::uuid[], ${j.verdict})
    on conflict (org_id, todo_id, check_no) do nothing`);
  await tx.execute(sql`
    update app.todo set check_no = 1, updated_at = now() where org_id = ${job.orgId} and id = ${job.todoId}`);
}

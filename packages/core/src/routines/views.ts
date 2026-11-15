/**
 * What routines' screens read: the composer's choices (metrics with how they're checked and their
 * latest checked periods, sources), every watched metric with the routines that watch it (Insights →
 * Watching). Each names only routines the viewer may see (`listRoutines`' rule): a
 * private routine is counted, never named.
 */
import { sql, type TenantTx } from "@opendash/db";
import type { CheckState } from "../checks/check";
import { insightReadableBy } from "../checks/insights";
import { type WatchableMetric, watchableMetrics } from "../checks/metrics";
import { displayMetric, type MetricFormat } from "../figures/metric";
import type { CheckGrain } from "./schedule";
import { type SentencePart, sentenceText } from "./sentence";
import type { FoundSpec } from "./spec";
import { type Actor, listRoutines, orgTz } from "./store";

export interface MetricChoice {
  id: string;
  title: string;
  connectionId: string;
  connectionName: string;
  format: MetricFormat;
  grain: CheckGrain;
  /** Active routines that watch it already. */
  watchedBy: number;
  /** Its latest checked period, when it has been checked. */
  latest: { display: string; period: string } | null;
  /** Its last 12 checked periods by its own period, oldest first: a sparkline, and a line's preview. */
  points: { period: string; value: number; display: string }[];
}

export interface ComposerChoices {
  metrics: MetricChoice[];
  sources: { id: string; name: string }[];
  tz: string;
}

/** Each metric's last 12 checked periods, by its own period (its primary check), oldest first. */
async function seriesOf(
  tx: TenantTx,
  orgId: string,
  metrics: WatchableMetric[],
): Promise<Map<string, { period: string; value: number }[]>> {
  const ids = metrics.filter((m) => m.grain).map((m) => m.id);
  if (!ids.length) return new Map();
  const rows = await tx.execute<{ metric_id: string; grain: string; period: string; value: number }>(sql`
    select k.metric_id, k.grain, o.period_start::text as period, o.value from app.metric_check k
    join lateral (
      select period_start, value from app.observation o
      where o.org_id = k.org_id and o.check_id = k.id order by period_start desc limit 12
    ) o on true
    where k.org_id = ${orgId} and k.deleted_at is null and k.metric_id = any(${`{${ids.join(",")}}`}::uuid[])
    order by k.metric_id, o.period_start`);
  const out = new Map<string, { period: string; value: number }[]>();
  for (const m of metrics) {
    const points = rows
      .filter((r) => r.metric_id === m.id && r.grain === m.grain)
      .map((r) => ({ period: r.period.slice(0, 10), value: Number(r.value) }));
    if (points.length) out.set(m.id, points);
  }
  return out;
}

/** How many active routines watch each metric. */
async function watcherCounts(tx: TenantTx, orgId: string): Promise<Map<string, number>> {
  const rows = await tx.execute<{ metric_id: string; n: number }>(sql`
    select m.metric_id, count(*)::int as n from app.routine r
    cross join lateral jsonb_array_elements_text(r.spec->'metricIds') m(metric_id)
    where r.org_id = ${orgId} and r.trigger = 'found' and r.status = 'active' and r.deleted_at is null
    group by 1`);
  return new Map(rows.map((r) => [r.metric_id, r.n]));
}

/** What the composer offers: the verified metrics it can watch, the sources, the zone. */
export async function composerChoices(tx: TenantTx, viewer: Actor): Promise<ComposerChoices> {
  const watchable = (await watchableMetrics(tx, viewer.orgId)).filter((m) => m.grain);
  const [series, counts, sources, tz] = [
    await seriesOf(tx, viewer.orgId, watchable),
    await watcherCounts(tx, viewer.orgId),
    await tx.execute<{ id: string; name: string }>(sql`
      select id, name from app.connection where org_id = ${viewer.orgId} and deleted_at is null order by created_at`),
    await orgTz(tx, viewer.orgId),
  ];
  return {
    metrics: watchable.map((m) => {
      const points = series.get(m.id) ?? [];
      const last = points.at(-1);
      return {
        id: m.id,
        title: m.title,
        connectionId: m.connectionId,
        connectionName: m.connectionName,
        format: m.format,
        grain: m.grain as CheckGrain,
        watchedBy: counts.get(m.id) ?? 0,
        latest: last ? { display: displayMetric(m.format, last.value), period: last.period } : null,
        points: points.map((p) => ({ ...p, display: displayMetric(m.format, p.value) })),
      };
    }),
    sources: sources.map((c) => ({ id: c.id, name: c.name })),
    tz,
  };
}

/** A watched metric (Insights → Watching), with the routines that watch it. */
export interface WatchedRow {
  metric: { id: string; title: string; format: MetricFormat };
  connectionName: string;
  grain: CheckGrain | null;
  /** Its own period's check: its last read, and its next. */
  state: CheckState;
  nextCheckAt: string | null;
  openInsights: number;
  /** The routines watching it the viewer may see, by name; and how many more there are. */
  watchers: { id: string; label: string; watching: boolean }[];
  others: number;
}

/** A routine's short name: its own (Watching, Growth alerts), or its sentence. */
const labelOf = (r: { name: string | null; sentence: SentencePart[] }) => r.name ?? sentenceText(r.sentence);

/** Every metric an active routine watches, by name, with its check and its watchers. */
export async function watchedByRoutines(tx: TenantTx, viewer: Actor): Promise<WatchedRow[]> {
  const all = await tx.execute<{ id: string; spec: FoundSpec }>(sql`
    select id, spec from app.routine
    where org_id = ${viewer.orgId} and trigger = 'found' and status = 'active' and deleted_at is null`);
  const ids = [...new Set(all.flatMap((r) => r.spec.metricIds))];
  if (!ids.length) return [];
  const visible = new Map(
    (await listRoutines(tx, viewer)).filter((r) => r.trigger === "found").map((r) => [r.id, r] as const),
  );
  const metrics = await watchableMetrics(tx, viewer.orgId, ids);
  const checks = await tx.execute<{
    metric_id: string;
    grain: CheckGrain;
    state: CheckState;
    next_check_at: string;
  }>(sql`
    select metric_id, grain, state, next_check_at from app.metric_check
    where org_id = ${viewer.orgId} and deleted_at is null and metric_id = any(${`{${ids.join(",")}}`}::uuid[])`);
  const open = await tx.execute<{ metric_id: string; n: number }>(sql`
    select n.metric_id, count(*)::int as n from app.insight n
    where n.org_id = ${viewer.orgId} and n.status in ('new', 'seen') and ${insightReadableBy(viewer.userId)}
      and n.metric_id = any(${`{${ids.join(",")}}`}::uuid[])
    group by 1`);
  return metrics.map((m) => {
    const watching = all.filter((r) => r.spec.metricIds.includes(m.id));
    const named = watching.flatMap((r) => {
      const v = visible.get(r.id);
      return v ? [{ id: v.id, label: labelOf(v), watching: v.key !== null }] : [];
    });
    const c = checks.find((x) => x.metric_id === m.id && x.grain === m.grain);
    return {
      metric: { id: m.id, title: m.title, format: m.format },
      connectionName: m.connectionName,
      grain: m.grain,
      state: c?.state ?? {},
      nextCheckAt: c ? new Date(c.next_check_at).toISOString() : null,
      openInsights: open.find((o) => o.metric_id === m.id)?.n ?? 0,
      watchers: named,
      others: watching.length - named.length,
    };
  });
}

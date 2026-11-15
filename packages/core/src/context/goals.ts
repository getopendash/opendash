/**
 * Goals (`goal {metric, target, due}`): what the team is working towards,
 * each on a verified metric. Owners and admins set them, and a goal applies when saved. Home shows each
 * against its metric's last test; the analyst doesn't read them yet.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { z } from "zod";
import { forecastGoal } from "../checks/goal-risk";
import { displayMetric, type MetricFormat } from "../figures/metric";
import { MetricSpec } from "../semantic/spec";
import { ContextProblem, slugOf, writeVersion } from "./items";

export const GoalSpec = z.object({
  /** The verified metric it's measured by (its item id). */
  metric: z.uuid(),
  target: z.number().finite(),
  /** The day it's due, YYYY-MM-DD. */
  due: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Reach at least the target, or stay at most at it: the metric's direction, or the goal's for a neutral metric. */
  direction: z.enum(["at_least", "at_most"]),
});
export type GoalSpec = z.infer<typeof GoalSpec>;

export interface Goal {
  id: string;
  version: number;
  title: string;
  spec: GoalSpec;
  /** The metric as released now: null when it was deleted or isn't verified any more. */
  metric: { id: string; title: string; format: MetricFormat; connectionName: string } | null;
  /** The metric's latest value, from its last test (the one its tile shows): null before one ran. */
  current: { value: number; label: string; period: string | null; checkedAt: string } | null;
  /**
   * Its forecast, from its metric's month check: the latest month projected on its trend to the goal's
   * month. Null when the metric isn't watched, or there isn't enough history.
   */
  forecast: { onCourse: boolean; projected: number; dueMonth: string } | null;
  updatedAt: string;
}

const dueLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const isDay = (s: string) =>
  !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);

type MetricRow = { id: string; title: string; spec: unknown; measure_format: string | null };

/** A released metric's title, format and direction, or null. */
async function releasedMetric(tx: TenantTx, orgId: string, id: string): Promise<MetricRow | null> {
  if (!isUuid(id)) return null;
  const [m] = await tx.execute<MetricRow>(sql`
    select i.id, i.title, v.spec,
      (select m->>'format' from app.context_item d
        join app.context_item_version dv on dv.org_id = d.org_id and dv.item_id = d.id and dv.version = d.released_version
        cross join lateral jsonb_array_elements(dv.spec->'measures') m
        where d.org_id = i.org_id and d.connection_id = i.connection_id and d.kind = 'dataset' and d.deleted_at is null
          and d.slug = v.spec->>'dataset' and m->>'name' = v.spec->>'measure' limit 1) as measure_format
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    where i.org_id = ${orgId} and i.id = ${id} and i.kind = 'metric' and i.deleted_at is null`);
  return m ?? null;
}

const formatOf = (m: MetricRow): MetricFormat => {
  const spec = MetricSpec.safeParse(m.spec);
  return ((spec.success ? spec.data.format : undefined) ?? m.measure_format ?? "number") as MetricFormat;
};

/**
 * Saves a goal: its metric must be verified, its target a number, its due date a day (a new one not in the
 * past). "Monthly recurring revenue to $500,000 by Dec 31, 2026": the title says it, and the goal applies at once.
 */
export async function saveGoal(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { id?: string; metricId: string; target: number; due: string; direction?: "at_least" | "at_most" },
  now = new Date(),
): Promise<{ id: string; version: number }> {
  const metric = await releasedMetric(tx, ctx.orgId, input.metricId);
  if (!metric) throw new ContextProblem("invalid", "Pick a verified metric.");
  if (typeof input.target !== "number" || !Number.isFinite(input.target)) {
    throw new ContextProblem("invalid", "The target is a number.");
  }
  if (!isDay(input.due)) throw new ContextProblem("invalid", "The due date is a day: YYYY-MM-DD.");
  if (!input.id && input.due < now.toISOString().slice(0, 10)) {
    throw new ContextProblem("invalid", "Pick a due date from today on.");
  }
  const spec = MetricSpec.safeParse(metric.spec);
  const metricDirection = spec.success ? spec.data.direction : "neutral";
  const direction =
    metricDirection === "higher_is_better"
      ? "at_least"
      : metricDirection === "lower_is_better"
        ? "at_most"
        : input.direction;
  if (!direction)
    throw new ContextProblem("invalid", "Say whether the goal is to reach at least the target, or stay at most at it.");
  const goal: GoalSpec = { metric: metric.id, target: input.target, due: input.due, direction };
  const target = displayMetric(formatOf(metric), input.target);
  const due = dueLabel.format(new Date(`${input.due}T00:00:00Z`));
  const title = `${metric.title} ${direction === "at_least" ? "to" : "at most"} ${target} by ${due}`;
  const saved = await writeVersion(tx, ctx, {
    ...(input.id ? { id: input.id } : {}),
    kind: "goal",
    title,
    slug: slugOf(`${metric.title} ${input.due} ${direction}`),
    connectionId: null,
    body: `${title}.`,
    spec: goal,
  });
  // A goal applies when saved: this version is the released one.
  await tx.execute(sql`
    update app.context_item set status = 'verified', released_version = current_version, verified_by = ${ctx.userId},
      verified_at = now()
    where org_id = ${ctx.orgId} and id = ${saved.id}`);
  return saved;
}

/** The goals (for Home), soonest due first, each with its metric as released now and the metric's latest value. */
export async function listGoals(tx: TenantTx, orgId: string): Promise<Goal[]> {
  const rows = await tx.execute<{
    id: string;
    title: string;
    version: number;
    spec: GoalSpec;
    updated_at: string;
    metric_title: string | null;
    metric_spec: unknown;
    measure_format: string | null;
    derived: { sample?: { label: string; period?: string; value: number | string | null }; checkedAt?: string } | null;
    connection_name: string | null;
    observed: { period: string; value: number; row: number }[] | null;
  }>(sql`
    select g.id, g.title, gv.version, gv.spec, g.updated_at, m.title as metric_title, mv.spec as metric_spec,
      mv.derived, c.name as connection_name,
      (select ms->>'format' from app.context_item d
        join app.context_item_version dv on dv.org_id = d.org_id and dv.item_id = d.id and dv.version = d.released_version
        cross join lateral jsonb_array_elements(dv.spec->'measures') ms
        where d.org_id = m.org_id and d.connection_id = m.connection_id and d.kind = 'dataset' and d.deleted_at is null
          and d.slug = mv.spec->>'dataset' and ms->>'name' = mv.spec->>'measure' limit 1) as measure_format,
      (select jsonb_agg(jsonb_build_object('period', o.period_start::text, 'value', o.value, 'row', o.row)
          order by o.period_start)
        from app.metric_check k join app.observation o on o.org_id = k.org_id and o.check_id = k.id
        where k.org_id = g.org_id and k.deleted_at is null and k.grain = 'month' and k.metric_id::text = gv.spec->>'metric'
          and o.period_start >= current_date - interval '13 months') as observed
    from app.context_item g
    join app.context_item_version gv on gv.org_id = g.org_id and gv.item_id = g.id and gv.version = g.released_version
    left join app.context_item m on m.org_id = g.org_id and m.kind = 'metric' and m.deleted_at is null
      and m.released_version is not null and m.id::text = gv.spec->>'metric'
    left join app.context_item_version mv on mv.org_id = m.org_id and mv.item_id = m.id and mv.version = m.released_version
    left join app.connection c on c.org_id = m.org_id and c.id = m.connection_id
    where g.org_id = ${orgId} and g.kind = 'goal' and g.deleted_at is null
    order by gv.spec->>'due', lower(g.title)`);
  return rows.map((r) => {
    const sample = r.derived?.sample;
    const value = typeof sample?.value === "number" ? sample.value : Number(sample?.value);
    const known = r.metric_title !== null;
    return {
      id: r.id,
      version: r.version,
      title: r.title,
      spec: r.spec,
      metric: known
        ? {
            id: r.spec.metric,
            title: r.metric_title as string,
            format: formatOf({ id: r.spec.metric, title: "", spec: r.metric_spec, measure_format: r.measure_format }),
            connectionName: r.connection_name ?? "",
          }
        : null,
      current:
        known && sample && sample.value !== null && Number.isFinite(value)
          ? { value, label: sample.label, period: sample.period ?? null, checkedAt: r.derived?.checkedAt ?? "" }
          : null,
      forecast: (() => {
        const f = known && r.observed?.length ? forecastGoal(r.observed, r.spec) : null;
        return f ? { onCourse: f.onCourse, projected: f.projected, dueMonth: f.dueMonth } : null;
      })(),
      updatedAt: new Date(r.updated_at).toISOString(),
    };
  });
}

/** The metrics a goal can be on (the choices when saving one): every released metric, with its direction and format. */
export async function goalMetricChoices(
  tx: TenantTx,
  orgId: string,
): Promise<
  {
    id: string;
    title: string;
    direction: "higher_is_better" | "lower_is_better" | "neutral";
    format: MetricFormat;
    connectionName: string;
  }[]
> {
  const rows = await tx.execute<MetricRow & { connection_name: string }>(sql`
    select i.id, i.title, v.spec, c.name as connection_name,
      (select m->>'format' from app.context_item d
        join app.context_item_version dv on dv.org_id = d.org_id and dv.item_id = d.id and dv.version = d.released_version
        cross join lateral jsonb_array_elements(dv.spec->'measures') m
        where d.org_id = i.org_id and d.connection_id = i.connection_id and d.kind = 'dataset' and d.deleted_at is null
          and d.slug = v.spec->>'dataset' and m->>'name' = v.spec->>'measure' limit 1) as measure_format
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    join app.connection c on c.org_id = i.org_id and c.id = i.connection_id and c.deleted_at is null
    where i.org_id = ${orgId} and i.kind = 'metric' and i.deleted_at is null
    order by lower(i.title)`);
  return rows.map((r) => {
    const spec = MetricSpec.safeParse(r.spec);
    return {
      id: r.id,
      title: r.title,
      direction: spec.success ? spec.data.direction : "neutral",
      format: formatOf(r),
      connectionName: r.connection_name,
    };
  });
}

/** Removes a goal (and nothing else by that id): it leaves Home at once, and its open goal risks resolve. */
export async function deleteGoal(tx: TenantTx, orgId: string, id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await tx.execute(sql`
    update app.context_item set deleted_at = now()
    where org_id = ${orgId} and id = ${id} and kind = 'goal' and deleted_at is null returning id`);
  if (rows.length) {
    await tx.execute(sql`
      update app.insight set status = 'resolved', status_at = now()
      where org_id = ${orgId} and kind = 'goal_risk' and starts_with(dedupe_key, ${`goal_risk:${id}:`})
        and status in ('new', 'seen')`);
  }
  return rows.length > 0;
}

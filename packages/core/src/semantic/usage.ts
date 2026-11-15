/**
 * "Used by" (review panel): what depends on a dataset or metric, so whoever changes it knows
 * what moves with it. It counts what exists: the metrics over a dataset, dashboards, verified queries and eval
 * questions. A dataset's dependents include its metrics' (a dashboard on MRR moves when the subscriptions dataset
 * does). Dashboards someone else keeps private are counted, never named.
 */
import { sql, type TenantTx } from "@opendash/db";
import { dashboardReadableBy } from "../projects/access";

export interface DefinitionUsage {
  /** A dataset's metrics (none for a metric). */
  metrics: { id: string; title: string }[];
  /** Dashboards this person can open, and how many others there are. */
  dashboards: { visible: { id: string; title: string }[]; hidden: number };
  verifiedQueries: { id: string; title: string }[];
  /** Active eval questions whose reference names it (or one of a dataset's metrics). */
  evalQuestions: number;
  /** Goals measured by it (or by one of a dataset's metrics): their progress moves with it. */
  goals: { id: string; title: string }[];
}

export async function definitionUsage(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  item: { id: string; kind: "dataset" | "metric"; slug: string; connectionId: string },
): Promise<DefinitionUsage> {
  const metrics =
    item.kind === "dataset"
      ? await tx.execute<{ id: string; title: string; slug: string }>(sql`
          select i.id, i.title, i.slug from app.context_item i
          join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
          where i.org_id = ${viewer.orgId} and i.connection_id = ${item.connectionId} and i.kind = 'metric'
            and i.deleted_at is null and v.spec->>'dataset' = ${item.slug}
          order by lower(i.title)`)
      : [];
  const ids = [item.id, ...metrics.map((m) => m.id)];
  const slugs = item.kind === "metric" ? [item.slug] : metrics.map((m) => m.slug);
  const idList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

  // A dashboard's current version names them in its queries: a query on this source that reads the dataset, or that
  // asks for the metric's own measure of its dataset (`["measure", name]`).
  const [measured] =
    item.kind === "metric"
      ? await tx.execute<{ dataset: string | null; measure: string | null }>(sql`
          select v.spec->>'dataset' as dataset, v.spec->>'measure' as measure from app.context_item i
          join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
          where i.org_id = ${viewer.orgId} and i.id = ${item.id}`)
      : [];
  const reads =
    item.kind === "dataset"
      ? sql`q.value->'source'->>'dataset' = ${item.slug}`
      : sql`q.value->'source'->>'dataset' = ${measured?.dataset ?? null}
          and exists (
            select 1 from jsonb_each(coalesce(q.value->'measures', '{}'::jsonb)) m
            where m.value->>0 = 'measure' and m.value->>1 = ${measured?.measure ?? null})`;
  const dashboards = await tx.execute<{ id: string; title: string; readable: boolean }>(sql`
    select d.id, d.title, ${dashboardReadableBy(viewer.userId)} as readable from app.dashboard d
    join app.dashboard_version v on v.org_id = d.org_id and v.dashboard_id = d.id and v.version = d.current_version
    where d.org_id = ${viewer.orgId} and d.deleted_at is null
      and exists (
        select 1 from jsonb_each(coalesce(v.definition->'queries', '{}'::jsonb)) q
        where q.value->'source'->>'connection' = ${item.connectionId} and ${reads})
    order by lower(d.title)`);

  // A verified query records the definitions it compiled from.
  const verifiedQueries = await tx.execute<{ id: string; title: string }>(sql`
    select distinct i.id, i.title from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    cross join lateral jsonb_array_elements(coalesce(v.spec->'definitions', '[]'::jsonb)) d
    where i.org_id = ${viewer.orgId} and i.kind = 'verified_query' and i.deleted_at is null
      and d->>'id' in (${idList})
    order by i.title`);

  // An eval question names the metrics its reference reads.
  const [evals] = slugs.length
    ? await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from app.eval_case c
        where c.org_id = ${viewer.orgId} and c.connection_id = ${item.connectionId} and c.active
          and coalesce(c.reference_spec->'metrics', '[]'::jsonb) ?| ${sql`array[${sql.join(
            slugs.map((s) => sql`${s}`),
            sql`, `,
          )}]::text[]`}`)
    : [{ n: 0 }];

  const goals = await tx.execute<{ id: string; title: string }>(sql`
    select g.id, g.title from app.context_item g
    join app.context_item_version v on v.org_id = g.org_id and v.item_id = g.id and v.version = g.released_version
    where g.org_id = ${viewer.orgId} and g.kind = 'goal' and g.deleted_at is null and v.spec->>'metric' in (${idList})
    order by v.spec->>'due'`);

  return {
    metrics: metrics.map(({ id, title }) => ({ id, title })),
    dashboards: {
      visible: dashboards.filter((d) => d.readable).map(({ id, title }) => ({ id, title })),
      hidden: dashboards.filter((d) => !d.readable).length,
    },
    verifiedQueries: [...verifiedQueries],
    evalQuestions: evals?.n ?? 0,
    goals: [...goals],
  };
}

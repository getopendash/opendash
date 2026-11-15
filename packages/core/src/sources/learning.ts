/**
 * Choosing what OpenDash learns: every table and view a source's schema read found, ranked by how
 * useful it is likely to be, with what it joins to; the ones its admin picks are profiled on every sync, the rest are
 * known (their names and columns) and profiled only when a question first reads them.
 */
import { type ColumnInfo, joinCandidates, type RelationInfo } from "@opendash/connectors";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { requestSync } from "./catalog";

/** How many tables the screen ticks for a source no one has chosen for yet. */
export const LEARN_DEFAULT = 10;

export interface LearningTable {
  /** schema.table */
  name: string;
  kind: "table" | "view";
  rows: number | null;
  /** How many of the team's queries read it (query history). */
  queries: number;
  /** What it joins to: checked on its data when it's learned, else declared, else likely by its columns' names. */
  joinsTo: string[];
  /** Learned now. */
  learned: boolean;
  /** Ticked on the screen: what's learned, or for a source never chosen, the most useful ones. */
  ticked: boolean;
  /** First seen since its admin last chose: not learned until it's picked. */
  new: boolean;
}

export interface LearningChoice {
  /** An admin chose (or the source was connected before choosing existed); a new source isn't, until its admin does. */
  chosen: boolean;
  chosenAt: string | null;
  /** The sample company learns everything without being asked. */
  sample: boolean;
  tables: LearningTable[];
}

export class LearningProblem extends Error {
  constructor(
    readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

/** Every table of a source to choose from, most useful first. Null for a source that doesn't exist. */
export async function learningChoice(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
): Promise<LearningChoice | null> {
  if (!isUuid(connectionId)) return null;
  const [source] = await tx.execute<{ chosen_at: string | null; sample: boolean }>(sql`
    select learning_chosen_at as chosen_at, coalesce((config->>'sample')::boolean, false) as sample
    from app.connection where org_id = ${orgId} and id = ${connectionId} and deleted_at is null`);
  if (!source) return null;
  const rows = await tx.execute<{
    fq_name: string;
    schema: string;
    name: string;
    kind: "table" | "view";
    learn: boolean;
    queries: number;
    rows: number | null;
    created_at: string;
    primary_key: string[] | null;
    reads: { schema: string; name: string }[] | null;
    columns: { name: string; ref: { schema: string; table: string } | null }[];
  }>(sql`
    select t.fq_name, s.name as schema, t.name, t.kind, t.learn, round(t.usage_score)::int as queries,
      nullif(t.profile->>'rows', '')::float8 as rows, t.created_at,
      (select array_agg(x) from jsonb_array_elements_text(t.profile->'primaryKey') x) as primary_key,
      t.schema_info->'reads' as reads,
      coalesce((
        select json_agg(json_build_object('name', c.name, 'ref', c.profile->'references') order by c.id)
        from app.catalog_object c
        where c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column' and c.removed_at is null
      ), '[]'::json) as columns
    from app.catalog_object t
    join app.catalog_object s on s.org_id = t.org_id and s.id = t.parent_id
    where t.org_id = ${orgId} and t.connection_id = ${connectionId} and t.kind in ('table', 'view')
      and t.removed_at is null`);
  // Joins the database declares, from the latest schema read (they aren't kept per column before a profile).
  const [snapshot] = await tx.execute<{
    snapshot: { relations: { name: string; foreignKeys: { refSchema: string; refTable: string }[] }[] };
  }>(sql`
    select snapshot from app.schema_snapshot where org_id = ${orgId} and connection_id = ${connectionId}
    order by id desc limit 1`);
  const declared = new Map(
    (snapshot?.snapshot.relations ?? []).map((r) => [r.name, r.foreignKeys.map((f) => `${f.refSchema}.${f.refTable}`)]),
  );
  // The name rules, for tables not learned yet: what a sync would check once both sides are learned.
  const relations = rows.map(
    (r) =>
      ({
        schema: r.schema,
        name: r.name,
        kind: r.kind,
        columns: r.columns.map((c) => ({ name: c.name }) as ColumnInfo),
        primaryKey: r.primary_key?.length === 1 ? r.primary_key : [],
        build: { reads: r.reads ?? [] },
      }) as RelationInfo,
  );
  const catalog = { schemas: [], relations, truncated: false };
  const joinsOf = rows.map((r, i) => {
    const checked = r.columns.flatMap((c) => (c.ref ? [`${c.ref.schema}.${c.ref.table}`] : []));
    const likely = r.columns.flatMap((c) => {
      if (c.ref) return [];
      const [best] = joinCandidates({ name: c.name } as ColumnInfo, relations[i] as RelationInfo, catalog);
      return best ? [`${best.target.schema}.${best.target.name}`] : [];
    });
    return [...new Set([...checked, ...(declared.get(r.fq_name) ?? []), ...likely])]
      .filter((n) => n !== r.fq_name)
      .sort();
  });
  const joinedBy = new Map<string, number>();
  for (const joins of joinsOf) for (const j of joins) joinedBy.set(j, (joinedBy.get(j) ?? 0) + 1);
  const chosenAt = source.chosen_at ? new Date(source.chosen_at).getTime() : null;
  const tables = rows
    .map((r, i) => ({
      name: r.fq_name,
      kind: r.kind,
      rows: r.rows === null ? null : Number(r.rows),
      queries: Number(r.queries),
      joinsTo: joinsOf[i] as string[],
      learned: r.learn,
      ticked: r.learn,
      new: chosenAt !== null && !r.learn && new Date(r.created_at).getTime() > chosenAt,
      // In the join graph (joined, or joining others): an archive or an import that joins nothing comes last.
      connected: (joinedBy.get(r.fq_name) ?? 0) + (joinsOf[i] as string[]).length,
      joinedBy: joinedBy.get(r.fq_name) ?? 0,
    }))
    .sort(
      (a, b) =>
        b.queries - a.queries ||
        Number(b.connected > 0) - Number(a.connected > 0) ||
        b.joinedBy - a.joinedBy ||
        (b.rows ?? -1) - (a.rows ?? -1) ||
        a.name.localeCompare(b.name),
    );
  const chosen = source.chosen_at !== null || source.sample;
  if (!chosen) {
    for (const [i, t] of tables.entries()) t.ticked = i < LEARN_DEFAULT;
  }
  return {
    chosen,
    chosenAt: source.chosen_at ? new Date(source.chosen_at).toISOString() : null,
    sample: source.sample,
    tables: tables.map(({ joinedBy: _, connected: __, ...t }) => t),
  };
}

/**
 * Saves its admin's pick: the tables named are learned, the rest known. A sync starts to learn the new ones (one
 * running already picks them up when it ends: `learnPickedMeanwhile`). Returns the sync run that learns them.
 */
export async function chooseLearnedTables(
  deps: { boss: PgBoss },
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  connectionId: string,
  names: string[],
): Promise<{ learned: number; syncRunId: string }> {
  if (!isUuid(connectionId)) throw new LearningProblem("not_found", "That source doesn't exist.");
  const [source] = await tx.execute<{ id: string }>(sql`
    select id from app.connection where org_id = ${ctx.orgId} and id = ${connectionId} and deleted_at is null
    for update`);
  if (!source) throw new LearningProblem("not_found", "That source doesn't exist.");
  const picked = [...new Set(names)];
  if (!picked.length) throw new LearningProblem("invalid", "Pick at least one table to learn.");
  const known = await tx.execute<{ fq_name: string }>(sql`
    select fq_name from app.catalog_object
    where org_id = ${ctx.orgId} and connection_id = ${connectionId} and kind in ('table', 'view') and removed_at is null`);
  const has = new Set(known.map((k) => k.fq_name));
  const missing = picked.filter((n) => !has.has(n));
  if (missing.length) {
    throw new LearningProblem("invalid", `${missing.slice(0, 3).join(", ")} isn't a table of this source.`);
  }
  await tx.execute(sql`
    update app.catalog_object set learn = fq_name in (${sql.join(
      picked.map((n) => sql`${n}`),
      sql`, `,
    )}), updated_at = now()
    where org_id = ${ctx.orgId} and connection_id = ${connectionId} and kind in ('table', 'view')
      and removed_at is null`);
  await tx.execute(sql`
    update app.connection set learning_chosen_at = now(), learning_chosen_by = ${ctx.userId}
    where org_id = ${ctx.orgId} and id = ${connectionId}`);
  const syncRunId = await requestSync(deps, tx, ctx, connectionId);
  return { learned: picked.length, syncRunId };
}

/**
 * A pick made while a sync was already profiling isn't in it: once that sync succeeds, one more learns what's picked
 * and not yet profiled. Only for a pick made after the run started, so it never loops.
 */
export async function learnPickedMeanwhile(
  deps: { boss: PgBoss; withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T> },
  job: { orgId: string; connectionId: string; syncRunId: string },
): Promise<string | null> {
  return deps.withTenant(job.orgId, async (tx) => {
    const [r] = await tx.execute<{ again: boolean }>(sql`
      select exists (
          select 1 from app.catalog_object o
          where o.org_id = ${job.orgId} and o.connection_id = ${job.connectionId} and o.kind in ('table', 'view')
            and o.learn and o.removed_at is null and not (o.profile ? 'method'))
        and coalesce((select c.learning_chosen_at > coalesce(s.started_at, s.created_at)
          from app.connection c, app.sync_run s
          where c.org_id = ${job.orgId} and c.id = ${job.connectionId} and s.org_id = ${job.orgId}
            and s.id = ${job.syncRunId}), false) as again`);
    return r?.again ? requestSync(deps, tx, { orgId: job.orgId, userId: null }, job.connectionId) : null;
  });
}

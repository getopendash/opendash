// A column's most common values, read live on request: a glossary term mapped to a column shows
// them when someone asks, never on opening the page, and OpenDash keeps no copy. The web asks; a worker reads (only
// workers reach a customer's database); the read is a recorded query run, under a key the web reads it back by
// until its freshness bucket ends.
import { type DialectId, dialectFor } from "@opendash/connectors";
import { sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { columnValuesSql } from "../gateway/column-values";
import { cacheKeyFor, type GatewayDeps, runQuery } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { type ValuesReadJob, valuesReadQueue } from "../jobs/queues";
import type { Viewer } from "../runs/ledger";

/** A column's values are read again at most every 15 minutes, like a dashboard's. */
export const COLUMN_VALUES_REFRESH_SECONDS = 900;
/** How many of a column's most common values are shown. */
export const COMMON_VALUES = 12;

export type CommonValuesAnswer =
  | { status: "queued" }
  | {
      status: "succeeded";
      column: string;
      values: { value: string; rows: number }[];
      /** The column has more values than these. */
      more: boolean;
      ranAt: string;
    }
  | { status: "failed"; message: string };

/** The column, if its values may be read: a known text column of a usable source, not personal, secret or free text. */
async function readable(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  column: string,
): Promise<{ dialect: DialectId } | { problem: string }> {
  const [c] = await tx.execute<{ dialect: DialectId; usable: boolean; open: boolean | null }>(sql`
    select c.dialect, (c.deleted_at is null and c.status <> 'disabled') as usable,
      (select o.sensitivity = 'none' and not coalesce(o.profile->'roles' ? 'free_text', false)
       from app.catalog_object o
       where o.org_id = c.org_id and o.connection_id = c.id and o.kind = 'column' and o.fq_name = ${column}
         and o.removed_at is null) as open
    from app.connection c where c.org_id = ${orgId} and c.id = ${connectionId}`);
  if (!c?.usable) return { problem: "Its source was removed or disabled." };
  if (c.open === null) return { problem: `${column} isn't a column of this source any more.` };
  if (!c.open) return { problem: `${column} is personal data or free text: its values aren't shown.` };
  return { dialect: c.dialect };
}

const queryOf = (dialect: DialectId, connectionId: string, column: string, now: Date) => {
  const query = columnValuesSql(dialect, column, undefined, COMMON_VALUES + 1);
  return {
    query,
    cacheKey: cacheKeyFor({
      connectionId,
      sql: query.sql,
      params: query.params,
      scope: "column-values",
      refreshSeconds: COLUMN_VALUES_REFRESH_SECONDS,
      now,
    }),
  };
};

/** The values read in this bucket, or a read queued for a worker (one per column per bucket, however many ask). */
export async function requestCommonValues(
  deps: { boss: PgBoss | null },
  tx: TenantTx,
  viewer: Viewer,
  input: { connectionId: string; column: string; now?: Date },
): Promise<CommonValuesAnswer> {
  const now = input.now ?? new Date();
  const ok = await readable(tx, viewer.orgId, input.connectionId, input.column);
  if ("problem" in ok) return { status: "failed", message: ok.problem };
  let read: ReturnType<typeof queryOf>;
  try {
    read = queryOf(ok.dialect, input.connectionId, input.column, now);
  } catch {
    return { status: "failed", message: `${input.column} can't be read for its values.` };
  }
  const [run] = await tx.execute<{
    status: string;
    error: { message?: string } | null;
    result_schema: { name: string }[] | null;
    preview: unknown[][] | null;
    created_at: string;
  }>(sql`
    select status, error, result_schema, preview, created_at from app.query_run
    where org_id = ${viewer.orgId} and cache_key = ${read.cacheKey}
      and id >= app.uuidv7_floor(${now.toISOString()}::timestamptz - interval '1 day')
    order by id desc limit 1`);
  if (run) {
    if (run.status !== "succeeded") return { status: "failed", message: run.error?.message ?? "It didn't finish." };
    const at = (run.result_schema ?? []).findIndex((c) => c.name === "value");
    const n = (run.result_schema ?? []).findIndex((c) => c.name === "n");
    const rows = run.preview ?? [];
    return {
      status: "succeeded",
      column: input.column,
      values: rows
        .slice(0, COMMON_VALUES)
        .map((r) => ({ value: String(r[at] ?? ""), rows: Number(r[n] ?? 0) }))
        .filter((v) => v.value !== ""),
      more: rows.length > COMMON_VALUES,
      ranAt: new Date(run.created_at).toISOString(),
    };
  }
  if (!deps.boss) return { status: "failed", message: "Values can't be read right now." };
  const job: ValuesReadJob = {
    orgId: viewer.orgId,
    connectionId: input.connectionId,
    column: input.column,
    cacheKey: read.cacheKey,
    requestedBy: viewer.userId ?? null,
    now: now.toISOString(),
  };
  await enqueueOnce(deps.boss, tx, valuesReadQueue, job, { singletonKey: read.cacheKey });
  return { status: "queued" };
}

/**
 * values.read, in the worker: checks the column again (it may have been marked personal since it was asked for) and
 * reads its values under the key the web asked with. Nothing runs when the key no longer matches.
 */
export async function executeCommonValues(deps: GatewayDeps, job: ValuesReadJob): Promise<"read" | "skipped"> {
  const ok = await deps.withTenant(job.orgId, (tx) => readable(tx, job.orgId, job.connectionId, job.column));
  if ("problem" in ok) return "skipped";
  const read = queryOf(dialectFor(ok.dialect).id, job.connectionId, job.column, new Date(job.now));
  if (read.cacheKey !== job.cacheKey) return "skipped";
  await runQuery(deps, {
    orgId: job.orgId,
    connectionId: job.connectionId,
    sql: read.query.sql,
    ...(read.query.params.length ? { params: read.query.params } : {}),
    mode: "execute",
    title: `Most common values of ${job.column}`,
    requester: { type: "api", id: job.requestedBy },
    cacheKey: job.cacheKey,
  });
  return "read";
}

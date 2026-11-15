/**
 * What the Sources list, a source's page and the sidebar show about each source: one status, how much
 * OpenDash learned, and how fresh the data is. Derived from the connection, its latest check, and its learning runs
 * (sync_run); nothing here is stored.
 */
import { isFreshnessValue, parseDataTime } from "@opendash/connectors";
import { isUuid, type SQL, sql, type TenantTx } from "@opendash/db";
import type { SyncFacts, SyncStatus } from "./catalog";
import { effectiveLimits, type SourceLimits } from "./limits";

/**
 * In order of precedence: disabled, then a source that can't be reached (its last check failed), one whose queries
 * can't connect (its latest query was refused at the door: a wrong password, a host gone), a failed learning run, one
 * learning now (for the first time: learning; again: syncing), a user that can change data, and healthy.
 */
export type SourceStatus =
  | "disabled"
  | "error"
  | "failing"
  | "failed"
  | "learning"
  | "syncing"
  | "write_access"
  | "healthy";

export interface SourceSummary {
  id: string;
  name: string;
  dialect: string;
  host: string;
  port: number | null;
  database: string;
  user: string;
  sslMode: string | null;
  /** verify-full's CA, as pasted (a certificate: nothing secret). */
  ca: string | null;
  /** From the latest connection check, e.g. "16.4". */
  serverVersion: string | null;
  /** The demo company: a database whose comment marks it as sample data. */
  sample: boolean;
  status: SourceStatus;
  /** Why it's failed, failing or in error, in words a person can act on. */
  statusDetail: string | null;
  /** From the last successful learning run, or the current one while it's the first. */
  tables: number | null;
  columns: number | null;
  personalData: number | null;
  /** The newest value of the tables' time columns, as an ISO instant: "Data to Oct 7, 23:00". */
  dataTo: string | null;
  /** When the last learning run succeeded. */
  learnedAt: string | null;
  /** The query limits that apply (sources/limits.ts). */
  limits: SourceLimits;
  /** When it's learned again on its own (sources/schedule.ts), and when that's next due; null when off. */
  syncRule: string | null;
  nextSyncAt: string | null;
  /** The latest learning run, for the learning view. */
  syncRunId: string | null;
  syncStatus: SyncStatus | null;
  createdAt: string;
}

type Row = {
  id: string;
  name: string;
  dialect: string;
  config: {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    sslMode?: string;
    ca?: string;
    sample?: boolean;
  };
  status: "ok" | "error" | "disabled";
  last_error: string | null;
  sync_rrule: string | null;
  next_sync_at: string | null;
  limits: unknown;
  created_at: string;
  write_accepted: boolean;
  test_facts: { serverVersion?: string } | null;
  run_id: string | null;
  run_status: SyncStatus | null;
  run_message: string | null;
  run_facts: SyncFacts | null;
  ok_facts: SyncFacts | null;
  learned_at: string | null;
  data_to: string[] | null;
  /** The latest finished query's connection error, when it couldn't connect and no check passed since. */
  query_error: string | null;
};

const iso = (v: string | null) => (v ? new Date(v).toISOString() : null);

/** The status rules, apart from the query, so they can be tested on their own. */
export function sourceStatus(r: {
  connection: "ok" | "error" | "disabled";
  writeAccess: boolean;
  latestRun: SyncStatus | null;
  learnedBefore: boolean;
  /** Its latest query couldn't connect (and no check passed since). */
  queriesFailing?: boolean;
}): SourceStatus {
  if (r.connection === "disabled") return "disabled";
  if (r.connection === "error") return "error";
  if (r.queriesFailing) return "failing";
  if (r.latestRun === "failed") return "failed";
  if (r.latestRun === "queued" || r.latestRun === "running") return r.learnedBefore ? "syncing" : "learning";
  if (r.writeAccess) return "write_access";
  return "healthy";
}

/** The newest per-table freshness that is a real time and not in the future (older profiles may hold one). */
function newest(values: string[] | null): string | null {
  let best: string | null = null;
  for (const v of values ?? []) {
    const iso = isFreshnessValue(v) ? parseDataTime(v) : null;
    if (iso && (!best || iso > best)) best = iso;
  }
  return best;
}

function summary(r: Row): SourceSummary {
  const facts = r.ok_facts ?? (r.run_status !== "failed" ? r.run_facts : null);
  const status = sourceStatus({
    connection: r.status,
    writeAccess: r.write_accepted,
    latestRun: r.run_status,
    learnedBefore: r.learned_at !== null,
    queriesFailing: r.query_error !== null,
  });
  return {
    id: r.id,
    name: r.name,
    dialect: r.dialect,
    host: r.config.host ?? "",
    port: r.config.port ?? null,
    database: r.config.database ?? "",
    user: r.config.user ?? "",
    sslMode: r.config.sslMode ?? null,
    ca: r.config.ca ?? null,
    serverVersion: r.test_facts?.serverVersion ?? null,
    sample: r.config.sample === true,
    status,
    statusDetail:
      status === "error"
        ? r.last_error
        : status === "failing"
          ? r.query_error
          : status === "failed"
            ? r.run_message
            : null,
    tables: facts?.tables ?? null,
    columns: facts?.columns ?? null,
    personalData: facts?.personalData ?? null,
    dataTo: newest(r.data_to),
    learnedAt: iso(r.learned_at),
    limits: effectiveLimits(r.limits),
    syncRule: r.sync_rrule,
    nextSyncAt: iso(r.next_sync_at),
    syncRunId: r.run_id,
    syncStatus: r.run_status,
    createdAt: iso(r.created_at) as string,
  };
}

/**
 * A source whose queries can't connect: of its queries in the last week that reached the door (one that ran, or one the
 * server refused: the user or password, or no server there), the latest couldn't connect, and no connection check has
 * passed since. The next query that runs, or a check that passes, clears it; a query refused for its own reasons (a
 * write, a table it may not read) says nothing about the source. Nothing is stored: a failed query never marked the
 * source, so one with a wrong password showed as healthy while every query failed.
 */
export const QUERY_ERROR = sql`(
  select q.error->>'message' from (
    select q.status, q.error, q.created_at from app.query_run q
    where q.org_id = c.org_id and q.connection_id = c.id and q.created_at > now() - interval '7 days'
      and (q.status = 'succeeded' or (q.status = 'failed' and q.error->>'kind' = 'connection'))
    order by q.id desc limit 1
  ) q
  where q.status = 'failed'
    and not exists (
      select 1 from app.connection_test ct
      where ct.org_id = c.org_id and ct.connection_id = c.id and ct.status in ('passed', 'warning')
        and ct.created_at > q.created_at))`;

const FRESHNESS = sql`
    left join lateral (
      select array_agg(o.profile->'freshness'->>'max') filter (where o.profile->'freshness' ? 'max') as data_to
      from app.catalog_object o
      where o.org_id = c.org_id and o.connection_id = c.id and o.kind in ('table', 'view') and o.removed_at is null
    ) f on true`;

async function query(
  tx: TenantTx,
  orgId: string,
  where: SQL,
  options: { freshness: boolean } = { freshness: true },
): Promise<SourceSummary[]> {
  const rows = await tx.execute<Row>(sql`
    select c.id, c.name, c.dialect, c.config, c.status, c.last_error, c.sync_rrule, c.next_sync_at, c.limits, c.created_at,
           -- Connected knowingly with write access, or a later check found it (a re-check, settle).
           c.read_only_verified_at is null as write_accepted,
           t.facts as test_facts,
           r.id as run_id, r.status as run_status, r.message as run_message, r.facts as run_facts,
           ok.facts as ok_facts, ok.finished_at as learned_at,
           ${options.freshness ? sql`f.data_to` : sql`null::text[] as data_to`},
           ${QUERY_ERROR} as query_error
    from app.connection c
    left join lateral (
      -- The server's version from the latest check that reached it (a failed re-check doesn't know it).
      select facts from app.connection_test t
      where t.org_id = c.org_id and t.connection_id = c.id and t.facts ? 'serverVersion'
      order by t.created_at desc limit 1
    ) t on true
    left join lateral (
      select id, status, message, facts from app.sync_run r
      where r.org_id = c.org_id and r.connection_id = c.id order by r.created_at desc limit 1
    ) r on true
    left join lateral (
      select facts, finished_at from app.sync_run s
      where s.org_id = c.org_id and s.connection_id = c.id and s.status = 'succeeded'
      order by s.finished_at desc limit 1
    ) ok on true
    ${options.freshness ? FRESHNESS : sql``}
    where c.org_id = ${orgId} and c.deleted_at is null and ${where}
    order by c.created_at`);
  return rows.map(summary);
}

/** Every live source of the organization, oldest first. */
export function listSources(tx: TenantTx, orgId: string): Promise<SourceSummary[]> {
  return query(tx, orgId, sql`true`);
}

/**
 * The same list without data freshness (which reads the catalog), for what every page shows: the sidebar's setup
 * card and status pill.
 */
export function listSourceStates(tx: TenantTx, orgId: string): Promise<SourceSummary[]> {
  return query(tx, orgId, sql`true`, { freshness: false });
}

/** One live source, or null (also for an id that isn't a uuid). */
export async function getSource(tx: TenantTx, orgId: string, id: string): Promise<SourceSummary | null> {
  if (!isUuid(id)) return null;
  const [source] = await query(tx, orgId, sql`c.id = ${id}`);
  return source ?? null;
}

/**
 * The sources one can ask about: learned at least once (a source being learned for the first time has no catalog
 * yet), and usable (not disabled, not failing its checks). Oldest first, like the Sources list.
 */
export async function askableSources(
  tx: TenantTx,
  orgId: string,
): Promise<{ id: string; name: string; dialect: string; sample: boolean; failing: string | null }[]> {
  const sources = await listSourceStates(tx, orgId);
  // A source whose queries can't connect stays askable (the analyst says why first), marked so the picker says it.
  return sources
    .filter((s) => s.learnedAt !== null && s.status !== "disabled" && s.status !== "error")
    .map((s) => ({
      id: s.id,
      name: s.name,
      dialect: s.dialect,
      sample: s.sample,
      failing: s.status === "failing" ? (s.statusDetail ?? "Its queries can't connect.") : null,
    }));
}

/** Why a source's queries can't connect (its latest query was refused at the door), or null: what the analyst is told. */
export async function sourceQueryError(tx: TenantTx, orgId: string, connectionId: string): Promise<string | null> {
  if (!isUuid(connectionId)) return null;
  const [r] = await tx.execute<{ query_error: string | null }>(sql`
    select ${QUERY_ERROR} as query_error from app.connection c
    where c.org_id = ${orgId} and c.id = ${connectionId} and c.deleted_at is null`);
  return r?.query_error ?? null;
}

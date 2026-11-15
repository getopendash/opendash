/**
 * Learning a source (onboarding). One sync_run per learning pass, in two
 * jobs:
 *   catalog.sync:  read the schema → snapshot + catalog_object rows; profile every table → profiles, roles, personal
 *                  data; then, in the transaction that records the last step, hand over to catalog.history.
 *   catalog.history: the team's own queries, from the source's query history; then settle the run.
 * No values are kept: a profile keeps stats, roles and sensitivity; the values read to profile a table
 * stay in memory.
 * Customer queries and our writes never share a transaction: each profile is read, then written in its own short
 * transaction. A failed step is a result on the run, not a job failure (as with connection tests).
 */

import { createHash } from "node:crypto";
import {
  type BuildInfo,
  type CatalogSnapshot,
  type ColumnInfo,
  type ColumnProfile,
  type Dialect,
  type DialectSession,
  dialectFor,
  type Edition,
  NetworkRefused,
  newJoinChecks,
  type RelationInfo,
  type Sensitivity,
  type SourceConfig,
  type Step,
  sensitivityOf,
  type TableProfile,
} from "@opendash/connectors";
import { isUuid, type SQL, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { BUDGETS } from "../budgets";
import { enqueue, enqueueOnce } from "../jobs/boss";
import { type CatalogSyncJob, catalogHistoryQueue, catalogSyncQueue } from "../jobs/queues";
import { loggableError } from "../loggable";
import type { SecretStore } from "../secrets/store";
import { storable } from "../storable";
import { mineHistory } from "./history";

/** How many rows of a table to sample: the usual number, fewer for a wide one (BUDGETS.catalogSync.maxSampleCells). */
export const sampleRowsFor = (columns: number) => {
  const b = BUDGETS.catalogSync;
  return Math.min(b.sampleRows, Math.floor(b.maxSampleCells / Math.max(1, columns)));
};

/** A source's comment as it's kept: at most BUDGETS.catalogSync.maxCommentChars characters, never half of one. */
export const keptComment = (comment: string | null | undefined): string | null => {
  const max = BUDGETS.catalogSync.maxCommentChars;
  if (!comment) return comment ?? null;
  if (comment.length <= max) return comment;
  // By code point, as Postgres counts them: a character outside the BMP (an emoji) is one, and is never split.
  let kept = "";
  let count = 0;
  for (const character of comment) {
    if (count++ === max) break;
    kept += character;
  }
  return kept;
};

export type SyncStatus = "queued" | "running" | "succeeded" | "failed";
/** The steps of a sync. Older runs also had "values" (the value index), kept in their own steps. */
export type SyncStepKey = "schema" | "profile" | "history";

/** The source was removed while it was being learned: the one failure here whose words are for people. */
class SourceRemoved extends Error {
  constructor() {
    super("This source was removed.");
  }
}

/**
 * What a run says when it couldn't start: the source's removal in its own words; anything else (a database error,
 * whose text holds SQL and ids) is logged, and the run says only that it couldn't start.
 */
function startFailure(job: CatalogSyncJob, step: string, error: unknown): string {
  if (error instanceof SourceRemoved) return error.message;
  console.error(
    JSON.stringify({ msg: `${step} couldn't start`, syncRunId: job.syncRunId, error: loggableError(error) }),
  );
  return "Couldn't start learning this source. Try again.";
}

export interface SyncFacts {
  schemas?: number;
  tables?: number;
  columns?: number;
  personalData?: number;
  joins?: number;
  /** Tables its admin picked to learn, profiled this sync. */
  learned?: number;
  /** Columns whose values only partly match another table (a subset). */
  partialJoins?: number;
  /** Statements read from the source's own query history that matched its catalog. */
  historyStatements?: number;
  truncated?: boolean;
  skippedTables?: string[];
}

export interface SyncRunView {
  id: string;
  connectionId: string;
  status: SyncStatus;
  steps: Step<SyncStepKey>[];
  facts: SyncFacts;
  message: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

const LABELS: Record<SyncStepKey, { pending: string; running: string; done: string }> = {
  schema: { pending: "Read the schema", running: "Reading the schema", done: "Read the schema" },
  profile: { pending: "Profile tables", running: "Profiling tables", done: "Profiled tables" },
  history: {
    pending: "Read how your team queries it",
    running: "Reading how your team queries it",
    done: "Read how your team queries it",
  },
};

const initialSteps = (): Step<SyncStepKey>[] =>
  (["schema", "profile", "history"] as const).map((key) => ({
    key,
    status: "pending",
    label: LABELS[key].pending,
  }));

const fmt = (n: number) => n.toLocaleString("en-US");
const plural = (n: number, one: string, many = `${one}s`) => `${fmt(n)} ${n === 1 ? one : many}`;

export interface SyncDeps {
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  /** Hands catalog.sync over to catalog.history. */
  boss: PgBoss;
  secrets: SecretStore;
  edition: Edition;
}

// ---------------------------------------------------------------------------------------------------------------
// Requesting and reading runs

/**
 * Starts learning a source, unless a run is already queued or running for it (then that run is returned). The
 * database allows one active run per source (sync_run_active_uq), so two clicks can't start two runs.
 */
export async function requestSync(
  deps: { boss: PgBoss },
  tx: TenantTx,
  ctx: { orgId: string; userId: string | null },
  connectionId: string,
): Promise<string> {
  const id = uuidv7();
  const [inserted] = await tx.execute<{ id: string }>(sql`
    insert into app.sync_run (org_id, id, connection_id, steps, requested_by)
    values (${ctx.orgId}, ${id}, ${connectionId}, ${JSON.stringify(initialSteps())}::jsonb, ${ctx.userId})
    on conflict (org_id, connection_id) where status in ('queued', 'running') do nothing
    returning id`);
  if (!inserted) {
    const [active] = await tx.execute<{ id: string }>(sql`
      select id from app.sync_run
      where org_id = ${ctx.orgId} and connection_id = ${connectionId} and status in ('queued', 'running')`);
    if (active) return active.id;
    throw new Error("Couldn't start learning this source");
  }
  await enqueue<CatalogSyncJob>(
    deps.boss,
    tx,
    catalogSyncQueue,
    { orgId: ctx.orgId, connectionId, syncRunId: id },
    { singletonKey: id },
  );
  return id;
}

type SyncRow = {
  id: string;
  connection_id: string;
  status: SyncStatus;
  steps: Step<SyncStepKey>[];
  facts: SyncFacts;
  message: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

const view = (r: SyncRow): SyncRunView => ({
  id: r.id,
  connectionId: r.connection_id,
  status: r.status,
  steps: r.steps,
  facts: r.facts,
  message: r.message,
  createdAt: new Date(r.created_at).toISOString(),
  startedAt: r.started_at ? new Date(r.started_at).toISOString() : null,
  finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
});

export async function getSyncRun(tx: TenantTx, orgId: string, id: string): Promise<SyncRunView | null> {
  if (!isUuid(id)) return null;
  const [row] = await tx.execute<SyncRow>(sql`
    select id, connection_id, status, steps, facts, message, created_at, started_at, finished_at
    from app.sync_run where org_id = ${orgId} and id = ${id}`);
  return row ? view(row) : null;
}

/** The most recent run for a source, and when it last learned successfully. */
export async function latestSync(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
): Promise<{ latest: SyncRunView | null; lastSucceededAt: string | null }> {
  const [row] = await tx.execute<SyncRow>(sql`
    select id, connection_id, status, steps, facts, message, created_at, started_at, finished_at
    from app.sync_run where org_id = ${orgId} and connection_id = ${connectionId}
    order by created_at desc limit 1`);
  const [ok] = await tx.execute<{ at: string | null }>(sql`
    select max(finished_at) as at from app.sync_run
    where org_id = ${orgId} and connection_id = ${connectionId} and status = 'succeeded'`);
  return { latest: row ? view(row) : null, lastSucceededAt: ok?.at ? new Date(ok.at).toISOString() : null };
}

/** What a learning run changed in the schema, from its snapshot (empty for the first run, or no change). */
export interface SchemaDiff {
  addedTables?: string[];
  removedTables?: string[];
  addedColumns?: string[];
  removedColumns?: string[];
}

/** A source's latest learning runs, newest first, each with its schema changes (a source's Recent syncs). */
export async function listSyncRuns(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  limit = 10,
): Promise<(SyncRunView & { diff: SchemaDiff | null })[]> {
  const rows = await tx.execute<SyncRow & { diff: SchemaDiff | null }>(sql`
    select r.id, r.connection_id, r.status, r.steps, r.facts, r.message, r.created_at, r.started_at, r.finished_at,
           s.diff
    from app.sync_run r
    left join app.schema_snapshot s on s.org_id = r.org_id and s.sync_run_id = r.id
    where r.org_id = ${orgId} and r.connection_id = ${connectionId}
    order by r.created_at desc limit ${Math.min(Math.max(limit, 1), 50)}`);
  return rows.map((r) => ({ ...view(r), diff: r.diff }));
}

// ---------------------------------------------------------------------------------------------------------------
// The jobs

interface Loaded {
  dialect: Dialect;
  config: SourceConfig;
  password: string;
}

/** A delivery of a run's job, as it claimed the run: its writes to the run count only while it's the latest. */
type Attempt = CatalogSyncJob & { attempt: number };

/** `and attempt = …` for a delivery's writes to its run; nothing for the dead letter's, which ends the run whatever. */
const ofAttempt = (job: CatalogSyncJob & { attempt?: number }) =>
  job.attempt === undefined ? sql`` : sql`and attempt = ${job.attempt}`;

async function updateRun(
  deps: SyncDeps,
  job: Attempt,
  patch: { steps?: Step<SyncStepKey>[]; facts?: SyncFacts },
  then?: (tx: TenantTx) => Promise<unknown>,
) {
  await deps.withTenant(job.orgId, async (tx) => {
    const rows = await tx.execute(sql`
      update app.sync_run set
        steps = coalesce(${patch.steps ? JSON.stringify(patch.steps) : null}::jsonb, steps),
        facts = facts || coalesce(${patch.facts ? JSON.stringify(patch.facts) : null}::jsonb, '{}'::jsonb)
      where org_id = ${job.orgId} and id = ${job.syncRunId} and status = 'running' ${ofAttempt(job)}
      returning id`);
    // A retried delivery replaced this one: it hands nothing over.
    if (then && rows.length) await then(tx);
  });
}

/** Ends a run that hasn't finished. Also the dead-letter path, for a worker that died or hung. */
export async function settleSync(
  deps: Pick<SyncDeps, "withTenant">,
  job: CatalogSyncJob & { attempt?: number },
  status: "succeeded" | "failed",
  result: { steps?: Step<SyncStepKey>[]; facts?: SyncFacts; message: string | null },
): Promise<boolean> {
  return deps.withTenant(job.orgId, async (tx) => {
    const rows = await tx.execute(sql`
      update app.sync_run set status = ${status}, finished_at = now(), message = ${result.message},
        steps = coalesce(${result.steps ? JSON.stringify(result.steps) : null}::jsonb, steps),
        facts = facts || coalesce(${result.facts ? JSON.stringify(result.facts) : null}::jsonb, '{}'::jsonb)
      where org_id = ${job.orgId} and id = ${job.syncRunId} and status in ('queued', 'running') ${ofAttempt(job)}
      returning id`);
    return rows.length > 0;
  });
}

function connect(deps: SyncDeps, loaded: Loaded, signal?: AbortSignal): Promise<DialectSession> {
  const b = BUDGETS.catalogSync;
  return loaded.dialect.open(loaded.config, loaded.password, {
    edition: deps.edition,
    connectTimeoutMs: b.connectMs,
    statementTimeoutMs: b.statementMs,
    applicationName: "opendash-catalog",
    signal,
  });
}

/** catalog.sync. Never throws: a failure is written to the run. */
export async function runCatalogSync(
  deps: SyncDeps,
  job: CatalogSyncJob,
  signal?: AbortSignal,
): Promise<SyncStatus | null> {
  const started = Date.now();
  const steps = initialSteps();
  const set = (key: SyncStepKey, patch: Partial<Step<SyncStepKey>>) => {
    const step = steps.find((s) => s.key === key);
    if (step) Object.assign(step, patch);
    return steps.map((s) => ({ ...s }));
  };
  // Until this delivery claims the run, a failure ends it whatever; after, only while it's the latest delivery.
  let me: CatalogSyncJob & { attempt?: number } = job;
  const fail = async (key: SyncStepKey, message: string) => {
    set(key, { status: "fail", label: LABELS[key].pending, detail: message });
    for (const s of steps) if (s.status === "pending") s.status = "skipped";
    await settleSync(deps, me, "failed", { steps, message });
    return "failed" as const;
  };

  let loaded: Loaded | null;
  try {
    const claimed = await deps.withTenant(job.orgId, async (tx) => {
      // A queued run, or one whose earlier delivery stalled and was retried (the queue retries once): this delivery
      // starts it over, and the earlier one's writes to it stop counting.
      const [run] = await tx.execute<{ connection_id: string; attempt: number }>(sql`
        update app.sync_run set status = 'running', attempt = attempt + 1, started_at = coalesce(started_at, now()),
          steps = ${JSON.stringify(set("schema", { status: "running", label: LABELS.schema.running }))}::jsonb
        where org_id = ${job.orgId} and id = ${job.syncRunId} and status in ('queued', 'running')
        returning connection_id, attempt`);
      if (!run) return null;
      const [c] = await tx.execute<{ dialect: string; config: Loaded["config"]; secret_id: string | null }>(sql`
        select dialect, config, secret_id from app.connection
        where org_id = ${job.orgId} and id = ${run.connection_id} and deleted_at is null`);
      if (!c?.secret_id) throw new SourceRemoved();
      return {
        attempt: run.attempt,
        loaded: {
          dialect: dialectFor(c.dialect),
          config: c.config,
          password: await deps.secrets.reveal(tx, job.orgId, c.secret_id, "connection"),
        } as Loaded,
      };
    });
    // The claim counts once its transaction committed: a failure inside it left the run as it was.
    if (claimed) me = { ...job, attempt: claimed.attempt };
    loaded = claimed?.loaded ?? null;
  } catch (error) {
    return fail("schema", startFailure(job, "catalog sync", error));
  }
  if (!loaded) return null; // already run: a duplicate delivery

  const b = BUDGETS.catalogSync;
  let session: DialectSession;
  try {
    session = await connect(deps, loaded, signal);
  } catch (error) {
    const message =
      error instanceof NetworkRefused ? error.message : loaded.dialect.friendlyError(error, loaded.config, b.connectMs);
    return fail("schema", message);
  }

  try {
    // 1. The schema.
    let catalog: CatalogSnapshot;
    try {
      catalog = await loaded.dialect.readCatalog(session, { maxRelations: b.maxRelations });
    } catch (error) {
      return await fail("schema", loaded.dialect.friendlyError(error, loaded.config, b.connectMs));
    }
    const columns = catalog.relations.reduce((n, r) => n + r.columns.length, 0);
    const facts: SyncFacts = {
      schemas: catalog.schemas.length,
      tables: catalog.relations.length,
      columns,
      truncated: catalog.truncated,
    };
    const tableIds = await deps.withTenant(job.orgId, (tx) => writeCatalog(tx, job, catalog));
    // Admins' personal-data choices, by table, so profiling never keeps what an admin marked personal.
    const overrides = new Map<string, Record<string, "none" | "pii" | "secret">>();
    const marked = await deps.withTenant(job.orgId, (tx) =>
      tx.execute<{ fq_name: string; sensitivity: "none" | "pii" | "secret" }>(sql`
        select fq_name, sensitivity from app.catalog_object
        where org_id = ${job.orgId} and connection_id = ${job.connectionId} and kind = 'column'
          and sensitivity_set_by is not null`),
    );
    for (const m of marked) {
      const at = m.fq_name.lastIndexOf(".");
      const table = m.fq_name.slice(0, at);
      overrides.set(table, { ...overrides.get(table), [m.fq_name.slice(at + 1)]: m.sensitivity });
    }
    await updateRun(deps, me as Attempt, {
      steps: set("schema", {
        status: catalog.truncated ? "warn" : "ok",
        label: LABELS.schema.done,
        detail: `${plural(catalog.relations.length, "table")} · ${plural(columns, "column")}${catalog.truncated ? ` (first ${fmt(b.maxRelations)})` : ""}`,
      }),
      facts,
    });

    // 2. Profiles of the tables its admin picked to learn, one at a time, each in its own short
    // transaction. Joins are looked for among them only: a table not learned is known, never read by a sync.
    const picked = await deps.withTenant(job.orgId, (tx) =>
      tx.execute<{ fq_name: string }>(sql`
        select fq_name from app.catalog_object
        where org_id = ${job.orgId} and connection_id = ${job.connectionId} and kind in ('table', 'view') and learn
          and removed_at is null`),
    );
    const learnSet = new Set(picked.map((r) => r.fq_name));
    const learned = { ...catalog, relations: catalog.relations.filter((r) => learnSet.has(`${r.schema}.${r.name}`)) };
    set("profile", {
      status: "running",
      label: LABELS.profile.running,
      detail: `0 of ${fmt(learned.relations.length)}`,
    });
    await updateRun(deps, me as Attempt, { steps });
    const skipped: string[] = [];
    let personal = 0;
    let joins = 0;
    let partialJoins = 0;
    let done = 0;
    // Join checks are shared by the sync's tables (a key ten tables point at is checked once), and stop once most of
    // the time is spent, so profiling the rest comes first.
    const joinChecks = newJoinChecks();
    for (const relation of learned.relations) {
      if (signal?.aborted) throw new Error("aborted");
      if (Date.now() - started > b.wallMs) {
        skipped.push(`${relation.schema}.${relation.name}`);
        continue;
      }
      if (Date.now() - started > b.wallMs * 0.6) joinChecks.left = 0;
      let profile: TableProfile | null = null;
      try {
        profile = await loaded.dialect.profile(session, relation, learned, {
          sampleRows: sampleRowsFor(relation.columns.length),
          categoryMaxNdv: b.categoryMaxNdv,
          sensitivity: overrides.get(`${relation.schema}.${relation.name}`),
          joins: joinChecks,
        });
      } catch {
        skipped.push(`${relation.schema}.${relation.name}`);
      }
      done += 1;
      if (profile) {
        personal += Object.values(profile.columns).filter((c) => c.sensitivity === "pii").length;
        joins += Object.values(profile.columns).filter((c) => c.references).length;
        partialJoins += Object.values(profile.columns).filter((c) => c.partialJoins?.length).length;
      }
      const tableId = tableIds.get(`${relation.schema}.${relation.name}`);
      await deps.withTenant(job.orgId, async (tx) => {
        if (profile && tableId) await writeProfile(tx, job, relation, tableId, profile);
        await tx.execute(sql`
          update app.sync_run set steps = ${JSON.stringify(set("profile", { detail: `${fmt(done)} of ${fmt(learned.relations.length)}` }))}::jsonb
          where org_id = ${job.orgId} and id = ${job.syncRunId} and status = 'running' ${ofAttempt(me)}`);
      });
    }
    const profiled = learned.relations.length - skipped.length;
    // Personal data among every known column, learned or not (names say what they can before a profile).
    const [pii] = await deps.withTenant(job.orgId, (tx) =>
      tx.execute<{ n: number }>(sql`
        select count(*)::int as n from app.catalog_object
        where org_id = ${job.orgId} and connection_id = ${job.connectionId} and kind = 'column'
          and sensitivity = 'pii' and removed_at is null`),
    );
    personal = pii?.n ?? personal;
    Object.assign(facts, {
      learned: learned.relations.length,
      personalData: personal,
      joins,
      partialJoins,
      skippedTables: skipped.slice(0, 20),
    });
    set(
      "profile",
      !learned.relations.length
        ? {
            status: "skipped",
            label: "Choose what OpenDash learns",
            detail: "Pick the tables to learn on the source's Overview: until then they're known, not profiled.",
          }
        : {
            status: skipped.length ? "warn" : "ok",
            label: LABELS.profile.done,
            detail: skipped.length
              ? `${fmt(profiled)} of ${fmt(learned.relations.length)} tables · ${fmt(skipped.length)} skipped (too slow)`
              : `${plural(learned.relations.length, "table")} learned · keys, joins, time columns, units${personal ? ` · ${plural(personal, "personal-data column")}` : ""}`,
          },
    );
    set("history", { status: "running", label: LABELS.history.running });
    // Hand over to the history step in the same transaction that records this one.
    await updateRun(deps, me as Attempt, { steps, facts }, (tx) =>
      // Once: a retried delivery that got this far again finds the history step already waiting, which is fine.
      enqueueOnce<CatalogSyncJob>(deps.boss, tx, catalogHistoryQueue, job, { singletonKey: job.syncRunId }),
    );
    return "running";
  } catch (error) {
    const running = steps.find((s) => s.status === "running")?.key ?? "profile";
    console.error(
      JSON.stringify({ msg: "catalog sync crashed", syncRunId: job.syncRunId, error: loggableError(error) }),
    );
    return await fail(running, "Something went wrong while learning this source. Try again.");
  } finally {
    await session.close();
  }
}

/**
 * catalog.history, the sync's last step: the team's own queries, from the history the database keeps (query history
 * v0). It reads no values: OpenDash keeps none (this step used to index them first). A history it can't read
 * never fails the sync. Never throws: a failure is written to the run, which it then settles.
 */
export async function runSyncHistory(
  deps: SyncDeps,
  job: CatalogSyncJob,
  signal?: AbortSignal,
): Promise<SyncStatus | null> {
  const b = BUDGETS.catalogSync;
  type Row = {
    steps: Step<SyncStepKey>[];
    attempt: number;
    dialect: string;
    config: Loaded["config"];
    secret_id: string;
  };
  let state: { me: Attempt; steps: Step<SyncStepKey>[]; loaded: Loaded } | null;
  try {
    state = await deps.withTenant(job.orgId, async (tx) => {
      // The run the profile step handed over, or one whose earlier delivery of this job stalled and was retried: this
      // delivery reads it from the start, and the earlier one's writes to it stop counting.
      const [r] = await tx.execute<Row>(sql`
        update app.sync_run s set attempt = s.attempt + 1
        from app.connection c
        where s.org_id = ${job.orgId} and s.id = ${job.syncRunId} and s.status = 'running'
          and c.org_id = s.org_id and c.id = s.connection_id and c.deleted_at is null
        returning s.steps, s.attempt, c.dialect, c.config, c.secret_id`);
      if (!r) return null;
      return {
        me: { ...job, attempt: r.attempt },
        steps: r.steps,
        loaded: {
          dialect: dialectFor(r.dialect),
          config: r.config,
          password: await deps.secrets.reveal(tx, job.orgId, r.secret_id, "connection"),
        },
      };
    });
  } catch (error) {
    await settleSync(deps, job, "failed", { message: startFailure(job, "query history", error) });
    return "failed";
  }
  if (!state) return null;
  const { me, steps, loaded } = state;
  const set = (patch: Partial<Step<SyncStepKey>>) => {
    const step = steps.find((s) => s.key === "history");
    if (step) Object.assign(step, patch);
    return steps;
  };

  let session: DialectSession;
  try {
    session = await connect(deps, loaded, signal);
  } catch (error) {
    // The source was learned: a history that can't be reached now is skipped, said in the step.
    const message =
      error instanceof NetworkRefused ? error.message : loaded.dialect.friendlyError(error, loaded.config, b.connectMs);
    await settleSync(deps, me, "succeeded", {
      steps: set({ status: "skipped", label: LABELS.history.pending, detail: message }),
      facts: { historyStatements: 0 },
      message: null,
    });
    return "succeeded";
  }
  try {
    set({ status: "running", label: LABELS.history.running });
    await deps.withTenant(job.orgId, (tx) =>
      tx.execute(sql`
        update app.sync_run set steps = ${JSON.stringify(steps)}::jsonb
        where org_id = ${job.orgId} and id = ${job.syncRunId} and status = 'running' ${ofAttempt(me)}`),
    );
    const history = await mineHistory(deps, job, loaded.dialect, session).catch((error: unknown) => {
      console.error(
        JSON.stringify({ msg: "query history failed", syncRunId: job.syncRunId, error: loggableError(error) }),
      );
      return { status: "skipped" as const, reason: "Couldn't read its query history this time." };
    });
    set(
      history.status === "ok"
        ? {
            status: "ok",
            label: LABELS.history.done,
            detail: `${plural(history.statements, "query", "queries")} over ${plural(history.tables, "table")}`,
          }
        : { status: "skipped", label: LABELS.history.pending, detail: history.reason },
    );
    await settleSync(deps, me, "succeeded", {
      steps,
      facts: { historyStatements: history.status === "ok" ? history.statements : 0 },
      message: null,
    });
    return "succeeded";
  } catch (error) {
    console.error(
      JSON.stringify({ msg: "sync history crashed", syncRunId: job.syncRunId, error: loggableError(error) }),
    );
    await settleSync(deps, me, "failed", {
      steps: set({ status: "fail", label: LABELS.history.pending, detail: "Something went wrong. Try again." }),
      message: "Something went wrong while reading its query history. Try again.",
    });
    return "failed";
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Writes

const BATCH = 500;

function chunks<T>(items: T[], size = BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const join = (parts: SQL[]) => sql.join(parts, sql.raw(", "));

interface ObjectRow {
  kind: "schema" | "table" | "view" | "column";
  fqName: string;
  name: string;
  parentFq: string | null;
  dataType: string | null;
  nullable: boolean | null;
  comment: string | null;
  /** How a table or view is built; empty for a schema or a column. */
  build: BuildInfo | Record<string, never>;
  /**
   * What's known before any profile: a table's row estimate, a column's kind (text, time, number), kept
   * until it's profiled, so a table first read by a question can be profiled from the catalog alone.
   */
  known: { rows?: number; textual?: boolean; temporal?: boolean; numeric?: boolean };
  /** A column's sensitivity by its name alone, until it's profiled or an admin decides. */
  sensitivity: Sensitivity;
}

/** The snapshot plus every schema, table and column, upserted; anything not seen this time is marked removed. */
/** A sync writes nothing for a source that was removed meanwhile (removeSource locks the same row, first). */
async function stillPresent(tx: TenantTx, job: Pick<CatalogSyncJob, "orgId" | "connectionId">) {
  const [c] = await tx.execute<{ id: string }>(sql`
    select id from app.connection
    where org_id = ${job.orgId} and id = ${job.connectionId} and deleted_at is null
    for share`);
  if (!c) throw new SourceRemoved();
}

async function writeCatalog(tx: TenantTx, job: CatalogSyncJob, catalog: CatalogSnapshot): Promise<Map<string, string>> {
  await stillPresent(tx, job);
  const shape = {
    schemas: catalog.schemas.map((s) => s.name),
    relations: catalog.relations.map((r) => ({
      name: `${r.schema}.${r.name}`,
      kind: r.kind,
      columns: r.columns.map((c) => [c.name, c.type, c.nullable]),
      primaryKey: r.primaryKey,
      foreignKeys: r.foreignKeys,
    })),
  };
  const hash = createHash("sha256").update(JSON.stringify(shape)).digest("hex");
  // A retried run replaces its earlier attempt's snapshot, so its diff is against the run before it.
  await tx.execute(sql`
    delete from app.schema_snapshot where org_id = ${job.orgId} and sync_run_id = ${job.syncRunId}`);
  const [previous] = await tx.execute<{ snapshot: typeof shape }>(sql`
    select snapshot from app.schema_snapshot where org_id = ${job.orgId} and connection_id = ${job.connectionId}
    order by id desc limit 1`);
  const snapshotId = uuidv7();
  await tx.execute(sql`
    insert into app.schema_snapshot (org_id, id, connection_id, sync_run_id, content_hash, snapshot, diff)
    values (${job.orgId}, ${snapshotId}, ${job.connectionId}, ${job.syncRunId}, ${hash},
            ${JSON.stringify(shape)}::jsonb, ${JSON.stringify(previous ? diffShapes(previous.snapshot, shape) : {})}::jsonb)`);

  const rows: ObjectRow[] = [
    ...catalog.schemas.map((s) => ({
      kind: "schema" as const,
      fqName: s.name,
      name: s.name,
      parentFq: null,
      dataType: null,
      nullable: null,
      comment: keptComment(s.comment),
      build: {},
      known: {},
      sensitivity: "none" as const,
    })),
    // How each table is built, and its row estimate, for every table known, learned or not.
    ...catalog.relations.map((r) => ({
      kind: r.kind,
      fqName: `${r.schema}.${r.name}`,
      name: r.name,
      parentFq: r.schema,
      dataType: null,
      nullable: null,
      comment: keptComment(r.comment),
      build: r.build ?? {},
      known: r.rowsEstimate === null ? {} : { rows: r.rowsEstimate },
      sensitivity: "none" as const,
    })),
    ...catalog.relations.flatMap((r) =>
      r.columns.map((c) => ({
        kind: "column" as const,
        fqName: `${r.schema}.${r.name}.${c.name}`,
        name: c.name,
        parentFq: `${r.schema}.${r.name}`,
        dataType: c.type,
        nullable: c.nullable,
        comment: keptComment(c.comment),
        build: {},
        known: { textual: c.textual, temporal: c.temporal, numeric: c.numeric },
        // A table not learned is never read until it's profiled; its columns' names say what they can before that.
        sensitivity: sensitivityOf(c, [], r.name).sensitivity,
      })),
    ),
  ];
  // The sample company learns everything without being asked; any other source's new tables wait to be picked.
  const [source] = await tx.execute<{ sample: boolean }>(sql`
    select coalesce((config->>'sample')::boolean, false) as sample from app.connection
    where org_id = ${job.orgId} and id = ${job.connectionId}`);
  const learnNew = source?.sample === true;
  const ids = new Map<string, string>();
  // Parents first, so each level can point at the one above.
  for (const level of ["schema", "table", "column"] as const) {
    const batch = rows.filter((r) => (level === "table" ? r.kind === "table" || r.kind === "view" : r.kind === level));
    for (const part of chunks(batch)) {
      const values = part.map(
        (r) =>
          sql`(${job.orgId}, ${uuidv7()}, ${job.connectionId}, ${r.parentFq ? (ids.get(r.parentFq) ?? null) : null}::uuid,
               ${r.kind}, ${r.fqName}, ${r.name}, ${r.dataType}, ${r.nullable}::boolean, ${storable(r.comment)},
               ${JSON.stringify(storable(r.build))}::jsonb, ${JSON.stringify(r.known)}::jsonb, ${r.sensitivity},
               ${learnNew && (r.kind === "table" || r.kind === "view")}, ${snapshotId}::uuid, ${snapshotId}::uuid)`,
      );
      const returned = await tx.execute<{ id: string; fq_name: string }>(sql`
        insert into app.catalog_object (org_id, id, connection_id, parent_id, kind, fq_name, name, data_type, nullable,
                                        comment, schema_info, profile, sensitivity, learn, first_seen_snapshot,
                                        last_seen_snapshot)
        values ${join(values)}
        on conflict (org_id, connection_id, fq_name) do update set
          parent_id = excluded.parent_id, kind = excluded.kind, data_type = excluded.data_type,
          nullable = excluded.nullable, comment = excluded.comment, schema_info = excluded.schema_info,
          -- What's known before a profile is kept only until there is one; an admin's choice always stands.
          profile = case when catalog_object.profile ? 'method' or catalog_object.profile ? 'roles'
            then catalog_object.profile else excluded.profile end,
          sensitivity = case when catalog_object.sensitivity_set_by is not null or catalog_object.profile ? 'roles'
            then catalog_object.sensitivity else excluded.sensitivity end,
          last_seen_snapshot = excluded.last_seen_snapshot,
          removed_at = null, updated_at = now()
        returning id, fq_name`);
      for (const r of returned) ids.set(r.fq_name, r.id);
    }
  }
  // What the source no longer has is marked removed. Its profile keeps only stats (an older profile
  // could still hold values: they go).
  await tx.execute(sql`
    update app.catalog_object set removed_at = now(), updated_at = now(),
      profile = profile - 'top' - 'min' - 'max' - 'maxValue'
    where org_id = ${job.orgId} and connection_id = ${job.connectionId}
      and last_seen_snapshot is distinct from ${snapshotId}::uuid and removed_at is null`);
  return ids;
}

function diffShapes(
  before: { relations: { name: string; columns: unknown[][] }[] },
  after: { relations: { name: string; columns: unknown[][] }[] },
) {
  const tables = (s: typeof before) => new Set(s.relations.map((r) => r.name));
  const cols = (s: typeof before) => new Set(s.relations.flatMap((r) => r.columns.map((c) => `${r.name}.${c[0]}`)));
  const [tb, ta, cb, ca] = [tables(before), tables(after), cols(before), cols(after)];
  return {
    addedTables: [...ta].filter((t) => !tb.has(t)),
    removedTables: [...tb].filter((t) => !ta.has(t)),
    addedColumns: [...ca].filter((c) => !cb.has(c) && tb.has(c.split(".").slice(0, 2).join("."))),
    removedColumns: [...cb].filter((c) => !ca.has(c) && ta.has(c.split(".").slice(0, 2).join("."))),
  };
}

/**
 * One table's profile and its columns'. An admin's sensitivity choice is never overwritten. Exported for tests (the
 * race with an admin's change is simulated there).
 */
export async function writeProfile(
  tx: TenantTx,
  job: Pick<CatalogSyncJob, "orgId" | "connectionId">,
  relation: RelationInfo,
  tableId: string,
  profile: TableProfile,
) {
  await stillPresent(tx, job);
  await tx.execute(sql`
    update app.catalog_object set updated_at = now(), profile = ${JSON.stringify({
      rows: profile.rows,
      method: profile.method,
      sampled: profile.sampled,
      freshness: storable(profile.freshness ?? null),
      primaryKey: relation.primaryKey,
    })}::jsonb
    where org_id = ${job.orgId} and id = ${tableId}`);
  const values = relation.columns.map((c) => {
    // Stats, roles and sensitivity only: a column's values (its most common ones, min and max) were read into memory
    // to profile it and aren't kept.
    const { top: _top, min: _min, max: _max, maxValue: _maxValue, ...p } = profile.columns[c.name] as ColumnProfile;
    return sql`(${`${relation.schema}.${relation.name}.${c.name}`}, ${JSON.stringify(
      storable({ ...p, textual: c.textual, temporal: c.temporal, numeric: c.numeric }),
    )}::jsonb, ${p.sensitivity})`;
  });
  // The sensitivity that applies: a detected secret always; otherwise an admin's choice; otherwise detection. It is
  // decided here, against the row as it is when written (an admin may have marked the column while this sync was
  // profiling).
  const effective = sql`(case when v.sensitivity = 'secret' or o.sensitivity_set_by is null then v.sensitivity
                              else o.sensitivity end)`;
  for (const part of chunks(values)) {
    await tx.execute(sql`
      update app.catalog_object o set
        profile = v.profile,
        sensitivity = ${effective},
        updated_at = now()
      from (values ${join(part)}) as v(fq_name, profile, sensitivity)
      where o.org_id = ${job.orgId} and o.connection_id = ${job.connectionId} and o.fq_name = v.fq_name`);
  }
  // Nor is the table's freshness read from a column that is personal or secret.
  await tx.execute(sql`
    update app.catalog_object t set profile = jsonb_set(t.profile, '{freshness}', 'null'::jsonb)
    where t.org_id = ${job.orgId} and t.id = ${tableId} and exists (
      select 1 from app.catalog_object c
      where c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column' and c.sensitivity <> 'none'
        and c.name = t.profile->'freshness'->>'column')`);
}

/** At most this many tables a query may read that no sync has profiled: each is profiled first, on its session. */
export const FIRST_USE_MAX = 3;

/**
 * Profiles a table that isn't learned, before a question's query reads it: a sample read into memory, its
 * stats and sensitivity kept like any profile, so the gateway knows its personal data before it reads anything. No
 * joins are looked for (that's for learned tables). Built from the catalog alone, on the query's own session.
 */
export async function profileOnFirstUse(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T> },
  job: { orgId: string; connectionId: string },
  dialect: Dialect,
  session: DialectSession,
  tableId: string,
): Promise<void> {
  const rows = await deps.withTenant(job.orgId, (tx) =>
    tx.execute<{
      schema: string;
      name: string;
      kind: "table" | "view";
      comment: string | null;
      table_profile: { rows?: number };
      column: string | null;
      data_type: string | null;
      nullable: boolean | null;
      column_comment: string | null;
      column_profile: { textual?: boolean; temporal?: boolean; numeric?: boolean } | null;
      sensitivity: Sensitivity | null;
      set_by: string | null;
    }>(sql`
      select s.name as schema, t.name, t.kind, t.comment, t.profile as table_profile, c.name as column, c.data_type,
        c.nullable, c.comment as column_comment, c.profile as column_profile, c.sensitivity, c.sensitivity_set_by as set_by
      from app.catalog_object t
      join app.catalog_object s on s.org_id = t.org_id and s.id = t.parent_id
      left join app.catalog_object c on c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column'
        and c.removed_at is null
      where t.org_id = ${job.orgId} and t.connection_id = ${job.connectionId} and t.id = ${tableId}
        and t.removed_at is null
      order by c.id`),
  );
  const [first] = rows;
  if (!first) throw new Error("That table isn't in the catalog.");
  const columns: ColumnInfo[] = rows.flatMap((r, i) =>
    r.column
      ? [
          {
            name: r.column,
            ordinal: i + 1,
            type: r.data_type ?? "",
            textual: r.column_profile?.textual ?? false,
            temporal: r.column_profile?.temporal ?? false,
            numeric: r.column_profile?.numeric ?? false,
            nullable: r.nullable ?? true,
            comment: r.column_comment,
          },
        ]
      : [],
  );
  const relation: RelationInfo = {
    schema: first.schema,
    name: first.name,
    kind: first.kind,
    comment: first.comment,
    rowsEstimate: first.table_profile?.rows ?? null,
    analyzed: first.table_profile?.rows !== undefined,
    columns,
    primaryKey: [],
    uniques: [],
    foreignKeys: [],
  };
  const sensitivity = Object.fromEntries(
    rows.flatMap((r) => (r.column && r.set_by && r.sensitivity ? [[r.column, r.sensitivity]] : [])),
  ) as Record<string, Sensitivity>;
  const b = BUDGETS.catalogSync;
  const profile = await dialect.profile(
    session,
    relation,
    { schemas: [], relations: [relation], truncated: false },
    {
      sampleRows: sampleRowsFor(relation.columns.length),
      categoryMaxNdv: b.categoryMaxNdv,
      sensitivity,
      joins: newJoinChecks(0),
    },
  );
  await deps.withTenant(job.orgId, (tx) => writeProfile(tx, job, relation, tableId, profile));
}

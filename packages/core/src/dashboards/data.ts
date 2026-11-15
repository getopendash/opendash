/**
 * A dashboard's data, from the page to the warehouse and back. The frame names what it
 * wants (a named query or a number's drill, filter values, a page and a sort) under the revision it draws; the web app
 * checks that the viewer reads that revision, binds and compiles each request from the stored definition (bind.ts,
 * compile.ts), and answers from the shared cache or queues it. The worker, which alone opens a source's credentials,
 * binds and compiles it again from the same revision at the same time, runs it through the gateway and writes the
 * answer under its key, failure included. The page asks again until it's there.
 *
 * The cache key is the compiled query (SQL and parameters), the dataset's released version, and a fingerprint of the
 * source's personal and secret columns, removed ones included: a column marked personal after an answer was cached
 * makes a new key (and dropping it later doesn't bring the old key back), and the gateway refuses that query when it
 * runs. Who may ask, and whether the source is still on, is checked on every request before the cache is read.
 *
 * A request keeps its freshness bucket while its page asks again for it (`at`), so a queued answer that lands after the
 * bucket turns is still the one it waits for.
 */
import { createHash } from "node:crypto";
import {
  type BindContext,
  BindRefused,
  bindDrill,
  bindFacet,
  bindLookup,
  bindQuery,
  bindTotals,
  type Condition,
  type Definition,
  drillColumnsOf,
  grantsOf,
  isServiceDataset,
  metricProblems,
  type Periods,
  type ServiceDataset,
} from "@opendash/apps/dashboard";
import { type ColumnKind, MAX_BATCH, type QuerySpec, type WireResult } from "@opendash/apps/protocol";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { BUDGETS } from "../budgets";
import { cacheKeyFor, type GatewayDeps, runQuery } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { type DashboardQueryJob, dashboardQueryQueue } from "../jobs/queues";
import type { McpDeps } from "../mcp/shared";
import { orgTz } from "../routines/store";
import type { Viewer } from "../runs/ledger";
import { createDashboardLimiter } from "../semantic/limits";
import { dashboardCatalog, type LoadedCatalog, withOwn } from "./catalog";
import { type CompiledQuery, compileQuery, QueryRefused } from "./compile";
import {
  pinKey,
  runOnSnapshot,
  serviceCatalog,
  serviceGeneration,
  serviceNow,
  serviceSnapshot,
  snapshotKey,
} from "./service";
import { definitionAt } from "./store";

/** Who owns a dashboard: a service it reads is read as them. */
export async function ownerOf(tx: TenantTx, orgId: string, dashboardId: string): Promise<string> {
  const [row] = await tx.execute<{ owner_id: string }>(sql`
    select owner_id from app.dashboard where org_id = ${orgId} and id = ${dashboardId}`);
  return row?.owner_id ?? "";
}

/** What the frame asks: a named query (rows paged and sorted), or the rows behind one of a query's numbers. */
type Values = Record<string, string | string[]>;

export type DashboardRequest = { id: string; at?: string; record?: string | number } & (
  | {
      query: string;
      filters?: Values;
      page?: number;
      sort?: string;
      pageSize?: number;
      where?: Condition[];
      search?: string;
    }
  | {
      drill: string;
      filters?: Values;
      group?: Record<string, string | number | null>;
      page?: number;
      /** On a service dataset: the snapshot the number was made from (its rows are those, never a newer read). */
      pin?: string;
    }
  /** A select filter's values from the warehouse, searched. */
  | { lookup: string; filters?: Values; search?: string }
  /** A column's values with their counts, under the query's filters and its other conditions. */
  | { facet: { query: string; column: string }; filters?: Values; where?: Condition[]; search?: string }
  /** A query's totals row (its rows declare them). */
  | { totals: string; filters?: Values; where?: Condition[] }
);

/** The query a request reads (its source and dataset): named, or the one its filter, facet or totals read. */
function queryOf(d: Definition, ask: DashboardRequest): string | null {
  if ("query" in ask) return ask.query;
  if ("drill" in ask) return ask.drill;
  if ("facet" in ask) return ask.facet.query;
  if ("lookup" in ask) {
    const f = Object.hasOwn(d.filters, ask.lookup) ? d.filters[ask.lookup] : undefined;
    return f?.kind === "select" && f.values ? f.values.from : null;
  }
  // An App asks for a query's totals by the query.
  return Object.hasOwn(d.queries, ask.totals) && d.queries[ask.totals]?.rows?.totals ? ask.totals : null;
}

export type DashboardAnswer =
  /** `periods`: the days its period filter chose (and the days compared with), for a query a period narrows. */
  | { id: string; status: "ok"; result: WireResult; previous?: WireResult; periods?: Periods }
  /** Ask again, with `at`: the bucket it was queued in. */
  | { id: string; status: "queued"; at: string }
  | { id: string; status: "failed"; error: string }
  | { id: string; status: "busy" };

/** Requests one call answers, at most: a page's visible pieces. */
export const MAX_REQUESTS = MAX_BATCH;

/** New warehouse queries per person from dashboards, in this process. */
const limiter = createDashboardLimiter();

interface Prepared {
  which: "main" | "previous";
  connectionId: string;
  compiled: CompiledQuery;
  cacheKey: string;
  /** A query on a service dataset: its rows come from this snapshot, fetched as the owner. */
  service?: {
    dataset: string;
    snapshotKey: string;
    name: string;
    ds: ServiceDataset;
    scope: "personal" | "org";
    /** Read only while kept: a drill pinned to the snapshot its number came from. */
    pinned?: boolean;
  };
  /** The days the request's period filter chose, for a query a period narrows. */
  periods?: Periods;
}

const BUCKET_MS = BUDGETS.dashboards.resultSeconds * 1000;

/** The start of `now`'s freshness bucket: every request in it binds and keys the same way, here and in the worker. */
export const bucketOf = (now: Date) => new Date(Math.floor(now.getTime() / BUCKET_MS) * BUCKET_MS);

/** The bucket a page asks again under: the one its request was queued in, while that's recent; else this one. */
function bucketFor(at: string | undefined, now: Date): Date {
  const t = at ? new Date(at) : null;
  if (!t || Number.isNaN(t.getTime()) || t.getTime() % BUCKET_MS !== 0) return now;
  return t <= now && now.getTime() - t.getTime() <= 3 * BUCKET_MS ? t : now;
}

/**
 * The source as it is now: off (disabled or removed) or on, with its personal and secret columns as one hash,
 * removed ones included, so marking one changes every key on that source for good.
 */
async function sourceNow(tx: TenantTx, orgId: string, connectionId: string): Promise<{ on: boolean; marks: string }> {
  const [row] = await tx.execute<{ on: boolean; marks: string | null }>(sql`
    select c.status <> 'disabled' and c.deleted_at is null as on,
      (select string_agg(o.id::text || ':' || o.sensitivity, ',' order by o.id) from app.catalog_object o
       where o.org_id = c.org_id and o.connection_id = c.id and o.kind = 'column' and o.sensitivity <> 'none') as marks
    from app.connection c where c.org_id = ${orgId} and c.id = ${connectionId}`);
  return {
    on: Boolean(row?.on),
    marks: createHash("sha256")
      .update(row?.marks ?? "")
      .digest("hex")
      .slice(0, 16),
  };
}

/**
 * A request bound and compiled from the definition, with its key: the query, and for one that compares, the period
 * before it too. A refusal (a value the definition doesn't allow, a name the dataset doesn't have) says why.
 */
async function prepare(
  tx: TenantTx,
  orgId: string,
  definition: Definition,
  ask: DashboardRequest,
  asked: Date,
  loaded: Map<string, { catalog: LoadedCatalog | null; on: boolean; marks: string }>,
  /** A published version's pins: what it read unreleased, at the version it read then. */
  pins: Record<string, number> = {},
  /**
   * Who owns the dashboard and who's asking: a service dataset is read as its owner, for its owner alone (2a). For a
   * draft, `saver` is who last saved it.
   */
  people: { owner: string; asker: string | null; saver?: string | null } = { owner: "", asker: null },
): Promise<Prepared[] | { refused: string }> {
  // When the request is evaluated: its bucket, or a pinned drill's own (the dates its number meant).
  let now = asked;
  const queryId = queryOf(definition, ask);
  const q = queryId && Object.hasOwn(definition.queries, queryId) ? definition.queries[queryId] : undefined;
  if (!q) return { refused: queryId ? `There's no query ${queryId}.` : "That isn't something this dashboard asks." };
  // A draft someone else last saved reads only what both of them can: the viewer's
  // access is checked below as for any request; its saver's here. The workspace's sources are every member's alike,
  // and a service its saver couldn't read was refused when they saved it (saveDraft, as them; their own account is
  // theirs alone to look up), so what's left to check now is that they're still a member.
  if (people.saver && people.saver !== people.asker) {
    const [m] = await tx.execute<{ role: string | null }>(sql`select app.member_role(${people.saver}::uuid) as role`);
    if (!m?.role) {
      return {
        refused:
          "This draft was last saved by someone who has left the workspace: it reads nothing until it's saved again.",
      };
    }
  }
  const connectionId = q.source.connection;
  const own = Object.hasOwn(definition.datasets ?? {}, q.source.dataset)
    ? definition.datasets?.[q.source.dataset]
    : undefined;
  const svc = own && isServiceDataset(own) && own.connection === connectionId ? own : null;
  let catalog: LoadedCatalog;
  let marks: string;
  let service: Prepared["service"];
  if (svc) {
    // A service: checked again on every request (the owner asking, allowed, unchanged, still connected), and keyed
    // by all of it.
    const now_ = await serviceNow(tx, orgId, svc, people);
    if (!now_.ok) return { refused: now_.refused };
    catalog = serviceCatalog(connectionId, now_.serverName, q.source.dataset, svc);
    const pin = "drill" in ask && typeof ask.pin === "string" ? ask.pin : null;
    if (pin !== null) {
      // The snapshot the number was made from, under this reader's access now; its dates as they were then.
      if (!isUuid(pin)) return { refused: "That isn't a read of this dashboard's." };
      const [kept] = await tx.execute<{ bucket: string | null }>(sql`
        select result->>'bucket' as bucket from app.dashboard_result
        where org_id = ${orgId} and cache_key = ${pinKey(now_.identity, pin)} and status = 'ok' and expires_at > now()`);
      if (!kept?.bucket) {
        return {
          refused: "These rows were read a while ago and aren't kept any more: refresh the page to read them again.",
        };
      }
      now = new Date(kept.bucket);
    }
    marks = pin ? `svc:${now_.identity}:pin:${pin}` : `svc:${now_.identity}`;
    service = {
      dataset: q.source.dataset,
      snapshotKey: pin ? pinKey(now_.identity, pin) : snapshotKey(now_.identity, now),
      name: now_.serverName,
      ds: svc,
      scope: now_.scope,
      ...(pin ? { pinned: true } : {}),
    };
  } else {
    let source = loaded.get(connectionId);
    if (!source) {
      source = {
        catalog: await dashboardCatalog(tx, orgId, connectionId, pins),
        ...(await sourceNow(tx, orgId, connectionId)),
      };
      loaded.set(connectionId, source);
    }
    if (!source.catalog || !source.on) return { refused: "The dashboard's source is off or gone." };
    // The source's datasets with the dashboard's own beside them.
    catalog = withOwn(source.catalog, definition);
    marks = source.marks;
  }
  const ctx: BindContext = { now, tz: await orgTz(tx, orgId), datasets: catalog.catalog };
  // Its metrics still mean what they meant when it was saved (a metric's time or segments can change since): checked
  // against the catalog this request reads, here and in the worker alike.
  const described = catalog.catalog[q.source.dataset];
  const changed = described ? metricProblems(q, described, definition.filters, q.source.dataset) : [];
  if (changed.length) return { refused: `${changed[0]?.message} The dashboard needs a change for it.` };
  let specs: { which: Prepared["which"]; spec: QuerySpec }[];
  let periods: Periods | undefined;
  try {
    if ("drill" in ask) {
      specs = [{ which: "main", spec: bindDrill(definition, ask.drill, ask, ctx) }];
    } else if ("lookup" in ask) {
      specs = [{ which: "main", spec: bindLookup(definition, ask.lookup, ask, ctx) }];
    } else if ("facet" in ask) {
      specs = [{ which: "main", spec: bindFacet(definition, ask.facet.query, ask.facet.column, ask, ctx) }];
    } else if ("totals" in ask) {
      specs = [{ which: "main", spec: bindTotals(definition, ask.totals, ask, ctx) }];
    } else {
      const bound = bindQuery(definition, ask.query, ask, ctx);
      specs = [{ which: "main", spec: bound.spec }];
      periods = bound.periods;
      if (bound.previous) specs.push({ which: "previous", spec: bound.previous });
    }
  } catch (error) {
    if (error instanceof BindRefused) return { refused: error.message };
    throw error;
  }
  const grants = grantsOf(definition, connectionId);
  // The rows behind a number with no drill of its own: the columns it shows (columns the dashboard returns already).
  if ("drill" in ask && !q.drill && q.measures) {
    const ds = q.source.dataset;
    const columns = drillColumnsOf(definition, ask.drill, catalog.catalog[ds]);
    const had = grants.datasets[ds];
    grants.datasets[ds] = { ...(had ?? {}), columns: [...new Set([...(had?.columns ?? []), ...columns])] };
  }
  const out: Prepared[] = [];
  for (const { which, spec } of specs) {
    let compiled: CompiledQuery;
    try {
      compiled = compileQuery(spec, grants, catalog);
    } catch (error) {
      if (error instanceof QueryRefused) return { refused: error.message };
      throw error;
    }
    const entry = catalog.datasets.get(compiled.dataset);
    // An own dataset by its whole checked contract, a released one by its version, an unreleased one by its version
    // read as unverified; the source's personal and secret marks always.
    const version = entry?.contract ? `own:${entry.contract}` : `${entry?.version ?? 0}${entry?.released ? "" : "u"}`;
    const cacheKey = cacheKeyFor({
      connectionId,
      sql: compiled.sql,
      params: compiled.params,
      scope: `dashboard:${compiled.dataset}@${version}:${marks}`,
      refreshSeconds: BUDGETS.dashboards.resultSeconds,
      now,
    });
    out.push({
      which,
      connectionId,
      compiled,
      cacheKey,
      ...(periods ? { periods } : {}),
      ...(service ? { service } : {}),
    });
  }
  return out;
}

type Cached = { status: "ok"; result: WireResult } | { status: "failed"; error: string };

async function cached(tx: TenantTx, orgId: string, cacheKey: string): Promise<Cached | null> {
  const [row] = await tx.execute<{ status: "ok" | "failed"; result: WireResult | null; error: string | null }>(sql`
    select status, result, error from app.dashboard_result
    where org_id = ${orgId} and cache_key = ${cacheKey} and expires_at > now()`);
  if (!row) return null;
  return row.status === "ok" && row.result
    ? { status: "ok", result: row.result }
    : { status: "failed", error: row.error ?? "The query didn't run." };
}

/**
 * A page's requests, under the revision it draws: each answered from the cache, queued (ask again), refused with why,
 * or held back for the moment (busy). Null when the viewer doesn't read that revision (another dashboard's, a draft
 * not theirs, one gone): the page opens the dashboard again.
 */
export async function requestDashboardQueries(
  deps: { boss: PgBoss },
  tx: TenantTx,
  viewer: Viewer,
  input: { dashboardId: string; revision: string; requests: DashboardRequest[]; retry?: boolean; now?: Date },
): Promise<DashboardAnswer[] | null> {
  const at = await definitionAt(tx, viewer, input.dashboardId, input.revision);
  if (!at) return null;
  const now = bucketOf(input.now ?? new Date());
  const loaded = new Map<string, { catalog: LoadedCatalog | null; on: boolean; marks: string }>();
  const who = `${viewer.orgId}:${viewer.userId ?? "key"}`;
  const answers: DashboardAnswer[] = [];
  const people = {
    owner: await ownerOf(tx, viewer.orgId, input.dashboardId),
    asker: viewer.userId,
    saver: at.savedBy,
  };

  for (const ask of input.requests.slice(0, MAX_REQUESTS)) {
    const bucket = bucketFor(ask.at, now);
    const prepared = await prepare(tx, viewer.orgId, at.definition, ask, bucket, loaded, at.pins, people);
    if ("refused" in prepared) {
      answers.push({ id: ask.id, status: "failed", error: prepared.refused });
      continue;
    }
    const got = new Map<Prepared["which"], Cached>();
    let busy = false;
    for (const p of prepared) {
      // A retry replaces a failed answer: it's cleared now, so the page's next ask waits for the new one.
      if (input.retry) {
        await tx.execute(sql`
          delete from app.dashboard_result
          where org_id = ${viewer.orgId} and cache_key = ${p.cacheKey} and status = 'failed'`);
      }
      const hit = await cached(tx, viewer.orgId, p.cacheKey);
      if (hit) {
        got.set(p.which, hit);
        continue;
      }
      const admitted = limiter.admit({
        who,
        // One choice on one dashboard (its filters as chosen): its queries in the next 30 s are covered.
        choice: `${who}:dashboard:${input.dashboardId}:${JSON.stringify(ask.filters ?? {})}`,
        cacheKey: p.cacheKey,
        retry: input.retry ?? false,
      });
      if (admitted === "busy") {
        busy = true;
        continue;
      }
      if (admitted === "queue") {
        const job: DashboardQueryJob = {
          orgId: viewer.orgId,
          dashboardId: input.dashboardId,
          revision: input.revision,
          ask: JSON.stringify(ask),
          ...(p.which === "previous" ? { previous: true as const } : {}),
          cacheKey: p.cacheKey,
          now: bucket.toISOString(),
          askedBy: viewer.userId,
        };
        await enqueueOnce(deps.boss, tx, dashboardQueryQueue, job, { singletonKey: p.cacheKey });
      }
    }
    const main = got.get("main");
    const previous = got.get("previous");
    const failed = [main, previous].find((x) => x?.status === "failed") as { error: string } | undefined;
    if (failed) answers.push({ id: ask.id, status: "failed", error: failed.error });
    else if (busy) answers.push({ id: ask.id, status: "busy" });
    else if (main?.status === "ok" && (prepared.length === 1 || previous?.status === "ok")) {
      answers.push({
        id: ask.id,
        status: "ok",
        result: main.result,
        ...(previous?.status === "ok" ? { previous: previous.result } : {}),
        ...(prepared[0]?.periods ? { periods: prepared[0].periods } : {}),
      });
    } else answers.push({ id: ask.id, status: "queued", at: bucket.toISOString() });
  }
  return answers;
}

/** A cell as the frame reads its column: a number, an ISO date, or text. */
function cellOf(value: unknown, kind: ColumnKind): number | string | null {
  if (value === null || value === undefined) return null;
  if (kind === "number") {
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (kind === "date") {
    const text = value instanceof Date ? value.toISOString() : String(value);
    // ClickHouse writes "2026-09-01 00:00:00"; the frame reads ISO.
    const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text) ? `${text.replace(" ", "T")}Z` : text;
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? text : d.toISOString();
  }
  return String(value);
}

async function writeAnswer(
  deps: Pick<GatewayDeps, "withTenant">,
  orgId: string,
  cacheKey: string,
  answer: Cached,
  queryRunId: string | null,
  /** Never over a good answer still fresh (a dead letter's, after another attempt answered). */
  keepGood = false,
) {
  await deps.withTenant(orgId, (tx) => writeAnswerIn(tx, orgId, cacheKey, answer, queryRunId, keepGood));
}

async function writeAnswerIn(
  tx: TenantTx,
  orgId: string,
  cacheKey: string,
  answer: Cached,
  queryRunId: string | null,
  keepGood = false,
) {
  await tx.execute(sql`
      insert into app.dashboard_result (org_id, cache_key, status, result, error, query_run_id, expires_at)
      values (${orgId}, ${cacheKey}, ${answer.status},
        ${answer.status === "ok" ? JSON.stringify(answer.result) : null}::jsonb,
        ${answer.status === "failed" ? answer.error : null}, ${queryRunId},
        now() + make_interval(secs => ${BUDGETS.dashboards.resultSeconds}))
      on conflict (org_id, cache_key) do update set status = excluded.status, result = excluded.result,
        error = excluded.error, query_run_id = excluded.query_run_id, created_at = now(),
        expires_at = excluded.expires_at
      where not ${keepGood} or app.dashboard_result.status = 'failed' or app.dashboard_result.expires_at <= now()`);
  await tx.execute(
    sql`delete from app.dashboard_result where org_id = ${orgId} and expires_at < now() - interval '1 minute'`,
  );
}

/**
 * Runs one queued request (the worker): bound and compiled again from the same revision at the same time, run through
 * the gateway, and written as the answer under its key, failure included. Nothing runs when the revision is gone or
 * the key no longer matches (the definition, the dataset or the source's marks changed since).
 */
export async function executeDashboardQuery(
  deps: GatewayDeps & {
    mcp?: McpDeps;
    /** A transaction carrying the person asking: a service's account is theirs, shown to them alone. */
    withUser?: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
    /** Where each stage's milliseconds go (the worker keeps them with the job, to see where an answer's time went). */
    stages?: Record<string, number>;
  },
  job: DashboardQueryJob,
  signal?: AbortSignal,
): Promise<"answered" | "skipped"> {
  const now = new Date(job.now);
  let mark = performance.now();
  const stage = (name: string) => {
    const at = performance.now();
    if (deps.stages) deps.stages[name] = Math.round(at - mark);
    mark = at;
  };
  const txFor = <T>(fn: (tx: TenantTx) => Promise<T>) =>
    job.askedBy && deps.withUser ? deps.withUser(job.orgId, job.askedBy, fn) : deps.withTenant(job.orgId, fn);
  const prepared = await txFor(async (tx): Promise<Prepared | { refused: string } | null> => {
    if (!isUuid(job.dashboardId)) return null;
    // The revision as the page drew it, checked again for the person who asked, as the page's own read is (a share
    // removed, or the dashboard made private, since they asked means nothing runs): a saved version they read, or the
    // draft when they change it (its owner, an editor), with who last saved it.
    const row = await definitionAt(tx, { orgId: job.orgId, userId: job.askedBy }, job.dashboardId, job.revision);
    if (!row) return null;
    const all = await prepare(
      tx,
      job.orgId,
      row.definition,
      JSON.parse(job.ask) as DashboardRequest,
      now,
      new Map(),
      row.pins,
      { owner: await ownerOf(tx, job.orgId, job.dashboardId), asker: job.askedBy, saver: row.savedBy },
    );
    if ("refused" in all) return all;
    const mine = all.find((p) => p.which === (job.previous ? "previous" : "main"));
    return mine && mine.cacheKey === job.cacheKey ? mine : null;
  });
  stage("prepare");
  if (!prepared) return "skipped";
  if ("refused" in prepared) {
    await writeAnswer(deps, job.orgId, job.cacheKey, { status: "failed", error: prepared.refused }, null);
    return "answered";
  }
  const { compiled, connectionId } = prepared;
  if (prepared.service) {
    await answerFromService(deps, job, prepared as Prepared & { service: NonNullable<Prepared["service"]> }, signal);
    stage("service");
    return "answered";
  }
  const outcome = await runQuery(deps, {
    orgId: job.orgId,
    connectionId,
    sql: compiled.sql,
    params: compiled.params,
    mode: "execute",
    title: `Dashboard · ${compiled.dataset}`,
    requester: { type: "dashboard", id: job.dashboardId },
    cacheKey: job.cacheKey,
    fullRows: true,
    ...(signal ? { signal } : {}),
    // Time spent waiting for one of the source's places, kept beside the stages (it's inside "query").
    waited: (ms) => {
      if (deps.stages) deps.stages.slot = ms;
    },
  });
  stage("query");
  let answer: Cached;
  if (outcome.status !== "succeeded") {
    answer = { status: "failed", error: outcome.error?.message ?? "The warehouse didn't answer." };
  } else {
    const index = new Map(outcome.columns.map((c, i) => [c.name.toLowerCase(), i]));
    const totalAt = index.get("__total");
    const rows = outcome.rows;
    const total = rows.length && totalAt !== undefined ? Number(rows[0]?.[totalAt] ?? rows.length) : 0;
    answer = {
      status: "ok",
      result: {
        requestId: outcome.queryRunId,
        dataset: compiled.dataset,
        columns: compiled.columns.map((c) => {
          const i = index.get(c.name.toLowerCase());
          return {
            name: c.name,
            kind: c.kind,
            values: rows.map((r) => (i === undefined ? null : cellOf(r[i], c.kind))),
          };
        }),
        ...(compiled.key ? { key: compiled.key } : {}),
        rowCount: rows.length,
        total: Number.isFinite(total) ? total : rows.length,
        // A page past the last has no rows to carry the total: the frame goes back to the first page.
        ...(rows.length === 0 && compiled.offset > 0 ? { pastEnd: true as const } : {}),
        truncated: outcome.truncated,
        hidden: [],
        asOf: new Date().toISOString(),
        // The warehouse's own time for it: what the render check tells the analyst when a query is slow.
        ...(outcome.durationMs !== null ? { ms: Math.round(outcome.durationMs) } : {}),
      },
    };
  }
  await writeAnswer(deps, job.orgId, job.cacheKey, answer, outcome.queryRunId);
  stage("write");
  return "answered";
}

/**
 * A query on a service dataset (2a): its snapshot (kept for the bucket, or fetched now as the owner, who is the one
 * asking), then the compiled query run over it in this database, written as the answer like any other.
 */
async function answerFromService(
  deps: GatewayDeps & { mcp?: McpDeps },
  job: DashboardQueryJob,
  prepared: Prepared & { service: NonNullable<Prepared["service"]> },
  signal?: AbortSignal,
) {
  // An answer worked out from a read a change overtook (a row's action ran meanwhile) is worked out again. It's kept
  // in the transaction that holds the generation, so a change either waits for it (and drops it) or comes first.
  for (let attempt = 0; attempt < 3; attempt++) {
    const began = await deps.withTenant(job.orgId, (tx) => serviceGeneration(tx, job.orgId));
    let made: [Cached, string | null] | null = null;
    await answerFromServiceWith(deps, job, prepared, signal, async (answer, run) => {
      made = [answer, run];
    });
    const answer = made as [Cached, string | null] | null;
    if (!answer) return;
    const kept = await deps.withTenant(job.orgId, async (tx) => {
      if ((await serviceGeneration(tx, job.orgId, true)) !== began) return false;
      await writeAnswerIn(tx, job.orgId, job.cacheKey, answer[0], answer[1]);
      return true;
    });
    if (kept) return;
  }
  await writeAnswer(
    deps,
    job.orgId,
    job.cacheKey,
    { status: "failed", error: "It changed while it was read: try again." },
    null,
  );
}

/** One try of answerFromService: the answer it would write. */
async function answerFromServiceWith(
  deps: GatewayDeps & { mcp?: McpDeps },
  job: DashboardQueryJob,
  prepared: Prepared & { service: NonNullable<Prepared["service"]> },
  signal: AbortSignal | undefined,
  write: (answer: Cached, queryRunId: string | null) => Promise<void>,
) {
  // Read as the person asking (their own account, or the workspace's): prepare checked it may run as them.
  if (!job.askedBy) {
    await write({ status: "failed", error: "Sign in to see this." }, null);
    return;
  }
  const { ds } = prepared.service;
  const snapshot = await serviceSnapshot(
    { withTenant: deps.withTenant, ...(deps.mcp ? { mcp: deps.mcp } : {}) },
    {
      orgId: job.orgId,
      owner: job.askedBy,
      ds,
      key: prepared.service.snapshotKey,
      scope: prepared.service.scope,
      ...(prepared.service.pinned ? { pinned: true } : {}),
      dashboardId: job.dashboardId,
      bucket: new Date(job.now),
      ...(signal ? { signal } : {}),
    },
  );
  if ("error" in snapshot) {
    await write({ status: "failed", error: snapshot.error }, snapshot.queryRunId ?? null);
    return;
  }
  const { compiled } = prepared;
  let rows: Record<string, unknown>[];
  try {
    rows = await deps.withTenant(job.orgId, (tx) => runOnSnapshot(tx, compiled, snapshot));
  } catch {
    await write({ status: "failed", error: "Its rows couldn't be read." }, null);
    return;
  }
  const total = rows.length ? Number(rows[0]?.__total ?? rows.length) : 0;
  const answer: Cached = {
    status: "ok",
    result: {
      // Each answer its own id (a chart redraws by it), never the snapshot's, which many answers share.
      requestId: `svc:${job.cacheKey}`,
      dataset: compiled.dataset,
      columns: compiled.columns.map((c) => ({
        name: c.name,
        kind: c.kind,
        values: rows.map((r) => cellOf(r[c.name], c.kind)),
      })),
      ...(compiled.key ? { key: compiled.key } : {}),
      rowCount: rows.length,
      total: Number.isFinite(total) ? total : rows.length,
      ...(rows.length === 0 && compiled.offset > 0 ? { pastEnd: true as const } : {}),
      truncated: snapshot.incomplete,
      hidden: [],
      asOf: snapshot.fetchedAt,
      service: {
        name: prepared.service.name,
        fetchedAt: snapshot.fetchedAt,
        incomplete: snapshot.incomplete,
        cut: snapshot.cut,
        unread: Object.values(snapshot.unread).reduce((a, b) => a + b, 0),
        scope: prepared.service.scope,
        // Its own read: a number's drill names it (snapshots kept from before ids have none).
        ...(snapshot.id ? { snapshot: snapshot.id } : {}),
      },
    },
  };
  await write(answer, snapshot.id && isUuid(snapshot.id) ? snapshot.id : null);
}

/** Its dead letter (the worker stopped on it twice): a failed answer under its key, so the page asking stops waiting. */
export async function dashboardQueryFailed(deps: Pick<GatewayDeps, "withTenant">, job: DashboardQueryJob) {
  await writeAnswer(
    deps,
    job.orgId,
    job.cacheKey,
    { status: "failed", error: "The query stopped the worker twice. Try again in a moment." },
    null,
    true,
  );
}

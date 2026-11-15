// The records behind a number: click a figure on a dashboard or in an answer and see the rows it counts. The web asks;
// a worker reads (only workers reach a customer's database); the reads are recorded query runs under keys the web
// reads back by until their freshness bucket ends, like a dashboard's own queries. What the person may see is what
// they could already see: the query run they clicked must be one of their conversations' or a dashboard they can read
// (a saved report's frozen runs are not: records of a snapshot would be today's data under yesterday's numbers).
import { type DialectId, dialectFor } from "@opendash/connectors";
import { sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { cacheKeyFor, type GatewayDeps, runQuery } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { type RecordsReadJob, recordsReadQueue } from "../jobs/queues";
import { dashboardReadableBy } from "../projects/access";
import { type Viewer, visibleTo } from "../runs/ledger";
import {
  type CompiledRecordsQuery,
  compileMetricQuery,
  compileRecordsQuery,
  RECORDS_PAGE_MAX,
  RECORDS_ROW_CAP,
  type RecordColumn,
  type RecordsGroup,
  type RecordsKind,
  SemanticError,
} from "./compile";
import { loadSemanticModel } from "./definitions";
import { createDashboardLimiter } from "./limits";
import type { SemanticModel } from "./model";
import { MetricQuery, type MetricQueryInput } from "./spec";

/** Records are read again at most every 15 minutes, like a dashboard's own queries. */
export const RECORDS_REFRESH_SECONDS = 900;
/** The default page: what the side sheet shows at once. */
export const RECORDS_PAGE_DEFAULT = 25;

const BUSY = "Too many new queries at once. Wait a minute, then try again.";
const limiter = createDashboardLimiter();

export interface RecordsRequestInput {
  /** The query run of the number that was clicked: a dashboard tile's or an answer's metric query. */
  queryRunId: string;
  /** Where in that number's chart it was clicked: a period and/or the dimensions' values. */
  group?: RecordsGroup;
  /**
   * Or the row of the run's result that was clicked (an answer's chart point, a table's row): its period and
   * dimension values are the group, and its number is the one the records should add up to.
   */
  row?: number;
  /** The page, from 0. */
  page?: number;
  pageSize?: number;
  /** The number clicked, so the list can say whether it adds up to it. */
  expected?: number | null;
  now?: Date;
}

export interface RecordsView {
  metric: { name: string; label: string; format: "number" | "usd" | "percent" };
  /** What a record is called, plural. */
  noun: string;
  kind: RecordsKind;
  /** For a sum: the column it adds up. */
  valueColumn: string | null;
  columns: RecordColumn[];
  /** Fields left out because they hold personal or secret data. */
  hidden: string[];
  rows: unknown[][];
  /** How many records there are (every one of them, though only the first RECORDS_ROW_CAP can be listed). */
  total: number;
  /** The metric's own number over exactly these records. */
  value: number | null;
  /** The number that was clicked, when the caller said, and whether the records add up to it. */
  expected: number | null;
  matches: boolean | null;
  page: number;
  pageSize: number;
  /** Rows past this offset can't be listed. */
  cap: number;
  /** Fewer rows came back than the page holds (the result was trimmed to keep it small). */
  trimmed: boolean;
  /** The period the records are of, and what narrows them. */
  range: { from: string; to: string } | null;
  grain: string | null;
  groups: { field: string; value: string | number | boolean | null }[];
  filters: { field: string; op: string; value: unknown }[];
  segments: { name: string; description: string | null }[];
  /** A snapshot dataset: its rows are the state at the end of the period, never the sum of the period. */
  snapshot: boolean;
  ranAt: string;
}

export type RecordsAnswer =
  | { status: "queued" }
  /** `busy`: refused for the moment (too many new queries at once), not for anything about the number. */
  | { status: "failed"; message: string; busy?: boolean }
  | ({ status: "succeeded" } & RecordsView);

type Plan = {
  connectionId: string;
  dialect: DialectId;
  compiled: CompiledRecordsQuery;
  asOf: Date;
  metric: RecordsView["metric"];
  segments: RecordsView["segments"];
  query: MetricQueryInput;
  /** What the click narrowed the number to, and the number clicked, when it was a row of the result. */
  group: RecordsGroup | undefined;
  expected: number | null;
  keys: { page: string; summary: string };
  sourceTitle: string;
};

/** The names (lower case) of a source's personal and secret columns: their values are never listed. */
async function sensitiveColumns(tx: TenantTx, orgId: string, connectionId: string): Promise<Set<string>> {
  const rows = await tx.execute<{ fq_name: string }>(sql`
    select fq_name from app.catalog_object
    where org_id = ${orgId} and connection_id = ${connectionId} and kind = 'column' and removed_at is null
      and sensitivity <> 'none'`);
  return new Set(rows.map((r) => (r.fq_name.split(".").pop() ?? "").toLowerCase()).filter(Boolean));
}

/**
 * Resolves what a click asks for: the run's metric query (only runs the person may see through a conversation or a
 * dashboard), the source's definitions as they stand, and the two statements and their cache keys. A problem in words
 * when it can't be done.
 */
async function plan(
  tx: TenantTx,
  viewer: Viewer,
  input: RecordsRequestInput,
  now: Date,
): Promise<Plan | { problem: string }> {
  const [run] = await tx.execute<{
    connection_id: string;
    semantic: { query?: MetricQueryInput } | null;
    result_schema: { name: string }[] | null;
    preview: unknown[][] | null;
    path: string;
    created_at: string;
    title: string | null;
    dialect: DialectId | null;
    usable: boolean | null;
  }>(sql`
    select q.connection_id, q.semantic, q.result_schema, q.preview, q.path, q.created_at, q.title, c.dialect,
      (c.deleted_at is null and c.status <> 'disabled') as usable
    from app.query_run q left join app.connection c on c.org_id = q.org_id and c.id = q.connection_id
    where q.org_id = ${viewer.orgId} and q.id = ${input.queryRunId} and (
      -- An answer's query: visible with its conversation.
      (q.requester_type = 'run' and exists (
        select 1 from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
        where r.org_id = q.org_id and r.id = q.requester_id and ${visibleTo(viewer.userId)}))
      -- A dashboard's query: visible with its dashboard.
      or (q.requester_type = 'dashboard' and exists (
        select 1 from app.dashboard d where d.org_id = q.org_id and d.id = q.requester_id and d.deleted_at is null
          and ${dashboardReadableBy(viewer.userId)})
        and (q.path <> 'mcp' or q.semantic->'mcp'->>'reader' in ('org', ${viewer.userId ?? ""}))))`);
  if (!run) return { problem: "That number isn't available any more." };
  const query = run.semantic?.query;
  if (run.path === "mcp")
    return { problem: "Its rows come from a service: open them from the number on its dashboard." };
  if (run.path !== "metric" || !query) {
    return { problem: "Records are listed for numbers that come from a metric. This one was written as SQL." };
  }
  if (!run.usable || !run.dialect) return { problem: "Its source was removed or disabled." };
  const loaded = await loadSemanticModel(tx, viewer.orgId, run.connection_id);
  if (!loaded) return { problem: "This source has no verified metrics any more." };
  // The number is read as of when it was computed: "last month" means the month it meant then.
  const asOf = new Date(run.created_at);
  let group = input.group;
  let expected = input.expected ?? null;
  let compiled: CompiledRecordsQuery;
  try {
    if (input.row !== undefined) {
      const clicked = rowGroup(
        loaded.model,
        query,
        run.result_schema ?? [],
        run.preview?.[input.row],
        asOf,
        run.dialect,
      );
      if (!clicked) return { problem: "That row isn't in the result any more." };
      group = clicked.group;
      expected = clicked.value ?? expected;
    }
    compiled = compileRecordsQuery(
      loaded.model,
      {
        query,
        ...(group ? { group } : {}),
        limit: Math.min(input.pageSize ?? RECORDS_PAGE_DEFAULT, RECORDS_PAGE_MAX),
        offset: Math.max(input.page ?? 0, 0) * Math.min(input.pageSize ?? RECORDS_PAGE_DEFAULT, RECORDS_PAGE_MAX),
        hide: await sensitiveColumns(tx, viewer.orgId, run.connection_id),
      },
      { now: asOf, sql: dialectFor(run.dialect).sql },
    );
  } catch (error) {
    if (error instanceof SemanticError) return { problem: error.message };
    throw error;
  }
  const metric = loaded.model.metrics.get(compiled.records.metric);
  const dataset = metric ? loaded.model.datasets.get(metric.dataset) : undefined;
  if (!metric || !dataset) return { problem: "That metric isn't defined any more." };
  const measure = dataset.measures.find((m) => m.name === metric.measure);
  const q = query as { segments?: string[]; exclude_segments?: string[] };
  const names = new Set([
    ...dataset.segments.filter((s) => s.default && !(q.exclude_segments ?? []).includes(s.name)).map((s) => s.name),
    ...metric.segments,
    ...(q.segments ?? []),
  ]);
  const keyOf = (statement: { sql: string; params: typeof compiled.params }) =>
    cacheKeyFor({
      connectionId: run.connection_id,
      sql: statement.sql,
      params: statement.params,
      scope: "records",
      refreshSeconds: RECORDS_REFRESH_SECONDS,
      now,
    });
  return {
    connectionId: run.connection_id,
    dialect: run.dialect,
    compiled,
    asOf,
    metric: { name: metric.name, label: metric.label, format: metric.format ?? measure?.format ?? "number" },
    segments: dataset.segments
      .filter((s) => names.has(s.name))
      .map((s) => ({ name: s.name, description: s.description ?? null })),
    query,
    group,
    expected,
    keys: { page: keyOf(compiled), summary: keyOf(compiled.records.summary) },
    sourceTitle: run.title ?? metric.label,
  };
}

/**
 * The group a clicked row of a metric query's result stands for: its period (the time column's value) and the value of
 * each dimension it was grouped by, keyed as the query names the dimension; and its number. Null when the row isn't
 * in the stored result.
 */
function rowGroup(
  model: SemanticModel,
  query: MetricQueryInput,
  schema: { name: string }[],
  row: unknown[] | undefined,
  now: Date,
  dialect: DialectId,
): { group: RecordsGroup; value: number | null } | null {
  if (!row) return null;
  const parsed = MetricQuery.safeParse(query);
  if (!parsed.success) return null;
  const roles = compileMetricQuery(model, query, { now, sql: dialectFor(dialect).sql }).columns;
  const at = (i: number) => schema.findIndex((c) => c.name === roles[i]?.name);
  const group: RecordsGroup = {};
  const values: Record<string, string | number | boolean | null> = {};
  let dimension = 0;
  let value: number | null = null;
  roles.forEach((c, i) => {
    const cell = row[at(i)];
    if (c.role === "time") {
      if (cell !== null && cell !== undefined) group.time = String(cell).slice(0, 10);
    } else if (c.role === "dimension") {
      const field = parsed.data.dimensions[dimension++];
      if (field !== undefined) values[field] = (cell ?? null) as string | number | boolean | null;
    } else if (c.role === "measure" && !c.previous && value === null) {
      value = num(cell);
    }
  });
  if (Object.keys(values).length) group.values = values;
  return { group, value };
}

type CachedRun = {
  status: string;
  error: { message?: string } | null;
  result_schema: { name: string }[] | null;
  preview: unknown[][] | null;
  created_at: string;
};

const cachedRun = async (tx: TenantTx, orgId: string, cacheKey: string, now: Date) =>
  (
    await tx.execute<CachedRun>(sql`
      select status, error, result_schema, preview, created_at from app.query_run
      where org_id = ${orgId} and cache_key = ${cacheKey}
        and id >= app.uuidv7_floor(${now.toISOString()}::timestamptz - interval '1 day')
      order by id desc limit 1`)
  )[0];

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Whether two figures are the same number, as a displayed total is (a rounded sum matches a longer one). */
const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.005, Math.abs(b) * 1e-9);

/**
 * The records behind a number for the viewer: read in this freshness bucket, or queued for a worker (one read per
 * statement per bucket, however many ask). Throws nothing for anything about the number: a problem is a failed answer.
 */
export async function requestRecords(
  deps: { withTenant: GatewayDeps["withTenant"]; boss: PgBoss | null },
  viewer: Viewer,
  input: RecordsRequestInput,
): Promise<RecordsAnswer> {
  const now = input.now ?? new Date();
  return deps.withTenant(viewer.orgId, async (tx) => {
    const p = await plan(tx, viewer, input, now);
    if ("problem" in p) return { status: "failed", message: p.problem };
    const [pageRun, summaryRun] = await Promise.all([
      cachedRun(tx, viewer.orgId, p.keys.page, now),
      cachedRun(tx, viewer.orgId, p.keys.summary, now),
    ]);
    const failed = [pageRun, summaryRun].find((r) => r && r.status !== "succeeded");
    if (failed) return { status: "failed", message: failed.error?.message ?? "The records didn't finish." };
    if (pageRun && summaryRun) return { status: "succeeded", ...view(p, input, pageRun, summaryRun) };
    if (!deps.boss) return { status: "failed", message: "Records can't be read right now." };
    const who = `${viewer.orgId}:${viewer.userId ?? "key"}`;
    const admitted = limiter.admit({ who, choice: `records:${input.queryRunId}`, cacheKey: p.keys.page });
    if (admitted === "busy") return { status: "failed", message: BUSY, busy: true };
    if (admitted === "queue") {
      const job: RecordsReadJob = {
        orgId: viewer.orgId,
        userId: viewer.userId,
        queryRunId: input.queryRunId,
        ...(input.group ? { group: input.group } : {}),
        ...(input.row !== undefined ? { row: input.row } : {}),
        page: Math.max(input.page ?? 0, 0),
        pageSize: Math.min(input.pageSize ?? RECORDS_PAGE_DEFAULT, RECORDS_PAGE_MAX),
        now: now.toISOString(),
        cacheKey: p.keys.page,
        summaryKey: p.keys.summary,
      };
      await enqueueOnce(deps.boss, tx, recordsReadQueue, job, { singletonKey: p.keys.page });
    }
    return { status: "queued" };
  });
}

function view(p: Plan, input: RecordsRequestInput, pageRun: CachedRun, summaryRun: CachedRun): RecordsView {
  const r = p.compiled.records;
  const summarySchema = summaryRun.result_schema ?? [];
  const at = (name: string) => summarySchema.findIndex((c) => c.name === name);
  const first = summaryRun.preview?.[0] ?? [];
  const total = num(first[at("__records")]) ?? 0;
  const value = num(first[at("__value")]);
  const pageSize = Math.min(input.pageSize ?? RECORDS_PAGE_DEFAULT, RECORDS_PAGE_MAX);
  const page = Math.max(input.page ?? 0, 0);
  const rows = pageRun.preview ?? [];
  const expected = p.expected;
  const comparable = r.kind === "count" || r.kind === "distinct" ? total : value;
  const wanted = Math.min(pageSize, Math.max(0, Math.min(total, RECORDS_ROW_CAP) - page * pageSize));
  const group = p.group?.values ?? {};
  const q = p.query as { filters?: { field: string; op: string; value?: unknown }[]; time?: { grain?: string } };
  return {
    metric: p.metric,
    noun: r.noun,
    kind: r.kind,
    valueColumn: r.valueColumn,
    columns: r.columns,
    hidden: r.hidden,
    rows,
    total,
    value,
    expected,
    matches: expected === null || comparable === null ? null : same(comparable, expected),
    page,
    pageSize,
    cap: RECORDS_ROW_CAP,
    trimmed: rows.length < wanted,
    range: p.compiled.range
      ? { from: p.compiled.range.from.toISOString(), to: p.compiled.range.to.toISOString() }
      : null,
    grain: p.group?.time ? (q.time?.grain ?? null) : null,
    groups: Object.entries(group).map(([field, v]) => ({ field, value: v })),
    filters: (q.filters ?? []).map((f) => ({ field: f.field, op: f.op, value: f.value ?? null })),
    segments: p.segments,
    snapshot: r.snapshot !== null,
    ranAt: new Date(pageRun.created_at).toISOString(),
  };
}

/**
 * records.read, in the worker: resolves the click as the web did (same person, same definitions) and reads the page and
 * its totals under the keys the web asked with. Nothing runs when a key no longer matches (the definitions changed in
 * between); the web asks again and queues what it now compiles.
 */
export async function executeRecords(
  deps: GatewayDeps,
  job: RecordsReadJob,
  signal?: AbortSignal,
): Promise<"read" | "skipped"> {
  const now = new Date(job.now);
  const p = await deps.withTenant(job.orgId, (tx) =>
    plan(
      tx,
      { orgId: job.orgId, userId: job.userId },
      {
        queryRunId: job.queryRunId,
        ...(job.group ? { group: job.group } : {}),
        ...(job.row !== undefined ? { row: job.row } : {}),
        page: job.page,
        pageSize: job.pageSize,
      },
      now,
    ),
  );
  if ("problem" in p) return "skipped";
  if (p.keys.page !== job.cacheKey || p.keys.summary !== job.summaryKey) return "skipped";
  const base = {
    orgId: job.orgId,
    connectionId: p.connectionId,
    mode: "execute" as const,
    requester: { type: "api" as const, id: job.userId },
    ...(signal ? { signal } : {}),
  };
  await runQuery(deps, {
    ...base,
    sql: p.compiled.sql,
    ...(p.compiled.params.length ? { params: p.compiled.params } : {}),
    title: `${p.sourceTitle} · records`,
    cacheKey: job.cacheKey,
  });
  const summary = p.compiled.records.summary;
  await runQuery(deps, {
    ...base,
    sql: summary.sql,
    ...(summary.params.length ? { params: summary.params } : {}),
    title: `${p.sourceTitle} · records total`,
    cacheKey: job.summaryKey,
  });
  return "read";
}

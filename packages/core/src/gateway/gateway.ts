/**
 * The query gateway: the only way OpenDash reads a customer's data. Every request is recorded as a
 * query_run, whatever happens to it:
 *
 *   validate (the dialect's statement check) → ground (tables against the catalog, literals against the value index)
 *   → run or explain, read-only, with timeouts and caps, at most N at a time per source → sanity checks → query_run
 *
 * It runs in the worker (the agent's tools call it). The web app never calls it.
 */

import { createHash } from "node:crypto";
import {
  type Cell,
  type Dialect,
  type DialectSession,
  dialectFor,
  type Edition,
  MAX_CELL_CHARS,
  NetworkRefused,
  QueryError,
  type QueryErrorInfo,
  type QueryParam,
  type ResultColumn,
  type SourceConfig,
  type StatementInfo,
} from "@opendash/connectors";
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { BUDGETS } from "../budgets";
import type { SecretStore } from "../secrets/store";
import { FIRST_USE_MAX, profileOnFirstUse } from "../sources/catalog";
import { effectiveLimits, type SourceLimits } from "../sources/limits";
import { storable } from "../storable";
import { type CatalogIndex, closest, type IndexedTable, loadCatalogIndex, resolveTable } from "./catalog-index";
import { columnValuesSql } from "./column-values";
import { type SanityCheck, sanityChecks, tableOf } from "./sanity";

const tracer = trace.getTracer("opendash.gateway");

export interface GatewayDeps {
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  secrets: SecretStore;
  edition: Edition;
}

export type { QueryParam };

export interface QueryRequest {
  orgId: string;
  connectionId: string;
  sql: string;
  /** Filter values go here rather than into the SQL, so the query can run again with other values. */
  params?: QueryParam[];
  /** execute runs it; explain checks it (statement, grounding, the server's plan) without running it. */
  mode: "execute" | "explain";
  title?: string;
  alias?: string;
  requester: { type: "run" | "eval" | "api" | "definition" | "dashboard" | "check" | "task"; id: string | null };
  /** Set when the result may be reused until its freshness bucket ends: dashboards. */
  cacheKey?: string;
  /**
   * Return every row read (up to the source's row limit) instead of the preview: a dashboard's query, whose answer goes
   * to the page that asked for it. What query_run keeps is the preview either way.
   */
  fullRows?: boolean;
  toolCallId?: string | null;
  signal?: AbortSignal;
  /** Hears how long the query waited for one of its source's places (its limit on queries at once), in milliseconds. */
  waited?: (ms: number) => void;
  /** Set for SQL the semantic compiler wrote: recorded as the metric path, with what it was compiled from. */
  semantic?: SemanticOrigin;
  /**
   * The model wrote this SQL (sql_query, sql_check): it's held to the database's advice before it runs.
   * Nothing else is: a dashboard's saved tiles, OpenDash's own value reads and a verified definition's SQL run as
   * they always have.
   */
  advise?: boolean;
}

/** A request as query_run records it: the SQL that ran, and the text as written when the dialect rewrote it. */
type RecordedRequest = QueryRequest & { writtenSql?: string; reads?: QueryReads };

/**
 * What a statement read, from the dialect's parse: its tables as the catalog names them (schema.table,
 * lowercase), and the values it compared columns with, by the table each column is of when the parse says. A
 * learning's test grades an answer's queries on it; the context graph's "used" edges come from it.
 */
export interface QueryReads {
  tables: string[];
  compared: { table: string | null; column: string; values: string[] }[];
}

export function readsOf(info: StatementInfo, index: CatalogIndex): QueryReads {
  const named = (schema: string | null, name: string) => {
    const t = resolveTable(index, schema, name);
    return (t ? `${t.schema}.${t.name}` : schema ? `${schema}.${name}` : name).toLowerCase();
  };
  const by = new Map<string, string>();
  const tables: string[] = [];
  for (const t of info.tables) {
    const name = named(t.schema, t.name);
    if (!tables.includes(name)) tables.push(name);
    by.set(t.name.toLowerCase(), name);
    if (t.alias) by.set(t.alias.toLowerCase(), name);
  }
  const compared = info.literals.slice(0, 50).map((l) => ({
    table: l.qualifier ? (by.get(l.qualifier.toLowerCase()) ?? null) : tables.length === 1 ? (tables[0] ?? null) : null,
    column: l.column.toLowerCase(),
    values: l.values.slice(0, 20).map((v) => v.slice(0, 120)),
  }));
  return { tables, compared };
}

/** A metric query's origin: its spec and the definitions it compiled from, each at the version that was live. */
export interface SemanticOrigin {
  query: unknown;
  definitions: { id: string; kind: "dataset" | "metric"; slug: string; version: number }[];
}

export type GatewayErrorKind =
  | QueryErrorInfo["kind"]
  | "refused"
  | "unknown_table"
  | "personal_data"
  /** A metric query the definitions can't express (semantic/compile.ts). */
  | "semantic";

export interface QueryOutcome {
  queryRunId: string;
  status: "succeeded" | "failed" | "timeout" | "cancelled";
  columns: ResultColumn[];
  /** Up to BUDGETS.gateway.previewRows rows: what the trace keeps and the answer gate can cite. */
  rows: Cell[][];
  rowCount: number;
  truncated: boolean;
  durationMs: number | null;
  /** Literal-grounding notes and failed sanity checks, for the agent to act on. */
  warnings: string[];
  checks: SanityCheck[];
  /** The catalog tables it read (`schema.table`, as the catalog names them), when it ran. */
  tables?: string[];
  error?: {
    kind: GatewayErrorKind;
    message: string;
    position?: number;
    hint?: string;
    suggestions?: string[];
    /** What this database needs instead, for an error it's known for (its dialect's advice). */
    fix?: string;
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A small in-process cap per source, so one question can't open a dozen connections to a customer's database.

const active = new Map<string, number>();
const waiting = new Map<string, (() => void)[]>();

/** A query whose run was cancelled before it reached the source: it never connects. */
const cancelled = () => new QueryError({ kind: "cancelled", message: "The query was cancelled." });

/** A slot on the source, waiting for one while it's full; a cancel while waiting gives up its place. */
async function acquire(key: string, limit: number, signal?: AbortSignal): Promise<() => void> {
  if (signal?.aborted) throw cancelled();
  while ((active.get(key) ?? 0) >= limit) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        waiting.set(
          key,
          (waiting.get(key) ?? []).filter((w) => w !== wake),
        );
        reject(cancelled());
      };
      const wake = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      waiting.set(key, [...(waiting.get(key) ?? []), wake]);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  active.set(key, (active.get(key) ?? 0) + 1);
  return () => {
    active.set(key, (active.get(key) ?? 1) - 1);
    const next = waiting.get(key)?.shift();
    next?.();
  };
}

// ---------------------------------------------------------------------------------------------------------------

interface Loaded {
  dialect: Dialect;
  config: SourceConfig;
  password: string;
  index: CatalogIndex;
  /** The source's own limits, never above the gateway's budget (sources/limits.ts). */
  limits: SourceLimits;
}

async function load(deps: GatewayDeps, req: QueryRequest): Promise<Loaded> {
  return deps.withTenant(req.orgId, async (tx) => {
    const [c] = await tx.execute<{
      dialect: string;
      config: SourceConfig;
      secret_id: string | null;
      status: "ok" | "error" | "disabled";
      last_error: string | null;
      limits: unknown;
    }>(sql`
      select dialect, config, secret_id, status, last_error, limits from app.connection
      where org_id = ${req.orgId} and id = ${req.connectionId} and deleted_at is null`);
    if (!c?.secret_id) throw new Error("That source doesn't exist or was removed.");
    // A disabled source isn't queried, nor one whose latest check failed (for instance its user can now reach
    // beyond the data, which has no override) until a check passes again.
    if (c.status === "disabled") throw new Error("This source is disabled.");
    if (c.status === "error") {
      throw new Error(
        `This source failed its last check: ${c.last_error ?? "it couldn't be reached"} Test it again on its page.`,
      );
    }
    return {
      dialect: dialectFor(c.dialect),
      config: c.config,
      password: await deps.secrets.reveal(tx, req.orgId, c.secret_id, "connection"),
      index: await loadCatalogIndex(tx, req.orgId, req.connectionId),
      limits: effectiveLimits(c.limits),
    };
  });
}

const MAX_PARAMS = 20;
const MAX_PARAM_TEXT = 1_000;
const MAX_PARAM_LIST = 200;
const PARAM_NAME = /^[a-z][a-z0-9_]{0,39}$/;

const ordinal = (n: number) =>
  `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th")}`;

/**
 * What's wrong with the parameters for this statement, if anything: their shape, and that every placeholder is used.
 * Positions are said the way the dialect writes them: $2 on Postgres, the 2nd ? on MySQL.
 */
export function paramProblem(
  params: QueryParam[],
  used: (number | string)[],
  style: Dialect["paramStyle"] = "positional",
  placeholder: "$" | "?" = "$",
): string | null {
  if (params.length > MAX_PARAMS) return `At most ${MAX_PARAMS} parameters per query.`;
  const position = (n: number) => (placeholder === "$" ? `$${n}` : `the ${ordinal(n)} ?`);
  const names = new Set<string>();
  for (const [i, p] of params.entries()) {
    const at = `${position(i + 1)}${p?.name ? ` (${p.name})` : ""}`;
    if (!PARAM_NAME.test(p?.name ?? "")) return `${at}: a parameter name is lowercase letters, digits and _.`;
    if (names.has(p.name)) return `${at}: two parameters are named ${p.name}.`;
    names.add(p.name);
    const scalar = (v: unknown) =>
      v === null ||
      typeof v === "boolean" ||
      (typeof v === "number" && Number.isFinite(v)) ||
      (typeof v === "string" && v.length <= MAX_PARAM_TEXT && !v.includes("\u0000"));
    const list = Array.isArray(p.value);
    if (list && (p.value as unknown[]).length > MAX_PARAM_LIST) return `${at}: at most ${MAX_PARAM_LIST} values.`;
    const ok = list
      ? (p.value as unknown[]).every((v) => typeof v === "string" || typeof v === "number") &&
        (p.value as unknown[]).every(scalar)
      : scalar(p.value);
    if (!ok) {
      return `${at}: a value is text (up to ${MAX_PARAM_TEXT.toLocaleString("en-US")} characters), a number, true or false, null, or a list of texts or numbers.`;
    }
  }
  if (style === "named") {
    const missing = used.filter((n): n is string => typeof n === "string" && !names.has(n));
    if (missing.length) {
      return `The SQL uses ${missing.map((n) => `{${n}}`).join(", ")} but no parameter has ${missing.length === 1 ? "that name" : "those names"}.`;
    }
    const unusedNamed = params.filter((p) => !used.includes(p.name));
    if (unusedNamed.length) {
      return `${unusedNamed.map((p) => p.name).join(", ")} ${unusedNamed.length === 1 ? "isn't" : "aren't"} used in the SQL.`;
    }
    return null;
  }
  const positions = used.filter((n): n is number => typeof n === "number");
  const highest = positions.at(-1) ?? 0;
  if (highest > params.length) {
    return `The SQL uses ${position(highest)} but ${params.length === 0 ? "no parameters were" : `only ${params.length} ${params.length === 1 ? "parameter was" : "parameters were"}`} given.`;
  }
  const unused = params.map((p, i) => ({ p, n: i + 1 })).filter(({ n }) => !positions.includes(n));
  if (unused.length) {
    return `${unused.map(({ p, n }) => `${position(n)} (${p.name})`).join(", ")} ${unused.length === 1 ? "isn't" : "aren't"} used in the SQL.`;
  }
  return null;
}

/** Tables the statement reads that the catalog doesn't have, with the closest names it does have. */
function unknownTables(info: StatementInfo, index: CatalogIndex) {
  const known = [...index.tables.values()].map((t) => `${t.schema}.${t.name}`);
  return info.tables
    .filter((t) => !resolveTable(index, t.schema, t.name))
    .map((t) => {
      const written = t.schema ? `${t.schema}.${t.name}` : t.name;
      return {
        written,
        suggestions: closest(written, t.schema ? known : known.map((k) => k.split(".")[1] as string).concat(known)),
      };
    });
}

/**
 * Personal and secret data (detected when the source was learned, or marked by an admin): a query may count or filter
 * on personal-data columns, but never return their values, so they reach neither the trace nor the model. Secret
 * columns may not be referenced at all.
 */
function sensitiveExposure(info: StatementInfo, index: CatalogIndex): { personal: string[]; secret: string[] } {
  // Every table a name or alias is bound to, in any scope: `u` in a subquery can be another table than the outer `u`,
  // and a table's name can be another's alias. Checking only the last binding let the other table's columns through.
  const byName = new Map<string, Set<IndexedTable>>();
  const bind = (name: string, table: IndexedTable) => {
    const key = name.toLowerCase();
    byName.set(key, (byName.get(key) ?? new Set()).add(table));
  };
  for (const t of info.tables) {
    const table = resolveTable(index, t.schema, t.name);
    if (!table) continue;
    bind(t.name, table);
    if (t.alias) bind(t.alias, table);
  }
  const all = [...new Set([...byName.values()].flatMap((set) => [...set]))];
  const personal = new Set<string>();
  const secret = new Set<string>();
  const label = (t: IndexedTable, c: string) => `${t.schema}.${t.name}.${c}`;
  const flag = (t: IndexedTable, columnName: string, returns: boolean) => {
    const c = t.columns.get(columnName.toLowerCase());
    if (!c || c.sensitivity === "none") return;
    if (c.sensitivity === "secret") secret.add(label(t, c.name));
    else if (returns) personal.add(label(t, c.name));
  };
  const flagTable = (t: IndexedTable) => {
    for (const c of t.columns.values()) flag(t, c.name, true);
  };
  // Unqualified names are checked against every table that has the column: conservative when ambiguous.
  const candidates = (ref: { qualifier: string | null; column: string }) =>
    ref.qualifier
      ? [...(byName.get(ref.qualifier.toLowerCase()) ?? [])]
      : all.filter((t) => t.columns.has(ref.column.toLowerCase()));

  for (const ref of info.references) for (const t of candidates(ref)) flag(t, ref.column, false);
  for (const ref of info.returned) {
    const matches = candidates(ref);
    const whole = !ref.qualifier && !matches.length ? byName.get(ref.column.toLowerCase()) : undefined;
    for (const t of whole ?? []) flagTable(t); // to_jsonb(u): the whole row
    for (const t of matches) flag(t, ref.column, true);
  }
  for (const star of info.stars) {
    const tables = star.from
      .filter(
        (f) => !star.qualifier || [f.alias, f.name].some((n) => n?.toLowerCase() === star.qualifier?.toLowerCase()),
      )
      .map((f) => resolveTable(index, f.schema, f.name))
      .filter((t): t is IndexedTable => Boolean(t));
    for (const t of tables) flagTable(t);
  }
  return { personal: [...personal], secret: [...secret] };
}

/**
 * The second, independent check on what a query returns: result columns the server reports as plain copies of a
 * personal-data or secret column. It doesn't depend on reading the SQL right, so a statement shape the first check
 * misses still can't return those values.
 */
/**
 * Result columns from a table the catalog has, but which it doesn't have itself: added since the last sync, so their
 * sensitivity was never decided, or a computed column whose origin the server reports as a CTE named like the table
 * (`confirmedOnServer` tells them apart). Fail closed: the result is discarded until a sync has seen a real one.
 */
export function unknownSourceColumns(
  columns: ResultColumn[],
  index: CatalogIndex,
): { table: IndexedTable; column: string }[] {
  return columns.flatMap((c) => {
    if (!c.source) return [];
    const table = resolveTable(index, c.source.schema, c.source.table);
    return table && !table.columns.has(c.source.column.toLowerCase()) ? [{ table, column: c.source.column }] : [];
  });
}

/** Of `candidates`, the ones that are the table's real columns on the server now, as schema.table.column. */
async function confirmedOnServer(
  dialect: Dialect,
  session: DialectSession,
  candidates: { table: IndexedTable; column: string }[],
): Promise<string[]> {
  if (!candidates.length || !dialect.columnsOf) return [];
  const real = new Map<string, Set<string>>();
  for (const { table } of candidates) {
    if (!real.has(table.id)) {
      real.set(
        table.id,
        new Set((await dialect.columnsOf(session, table.schema, table.name)).map((c) => c.toLowerCase())),
      );
    }
  }
  return [
    ...new Set(
      candidates
        .filter(({ table, column }) => real.get(table.id)?.has(column.toLowerCase()))
        .map(({ table, column }) => `${table.schema}.${table.name}.${column}`),
    ),
  ];
}

/**
 * Columns a statement names on a table the catalog has which the catalog doesn't have: added since the last sync, or a
 * name the statement computes (a CTE's `__d0`, an alias). By a qualifier, the tables it resolves to; unqualified, every
 * catalog table the statement reads when none of them has it (`lower(contact_note)` on a column added since the sync
 * reads it as surely as `a.contact_note`). The server says which are real: those are refused until a sync checks them.
 */
export function unknownColumns(info: StatementInfo, index: CatalogIndex): { table: IndexedTable; column: string }[] {
  const byName = new Map<string, Set<IndexedTable>>();
  const all = new Set<IndexedTable>();
  for (const t of info.tables) {
    const table = resolveTable(index, t.schema, t.name);
    if (!table) continue;
    all.add(table);
    for (const n of [t.name, t.alias, t.schema ? `${t.schema}.${t.name}` : null]) {
      if (n) byName.set(n.toLowerCase(), (byName.get(n.toLowerCase()) ?? new Set()).add(table));
    }
  }
  const unknown = new Map<string, { table: IndexedTable; column: string }>();
  for (const ref of [...info.references, ...info.returned]) {
    const tables = ref.qualifier ? [...(byName.get(ref.qualifier.toLowerCase()) ?? [])] : [...all];
    if (tables.length && !tables.some((t) => t.columns.has(ref.column.toLowerCase()))) {
      for (const table of tables) unknown.set(`${table.id}\u0000${ref.column}`, { table, column: ref.column });
    }
  }
  return [...unknown.values()];
}

const notSyncedYet = (names: string[]) =>
  `${names.join(", ")} ${names.length === 1 ? "isn't" : "aren't"} in the catalog yet: OpenDash checks a column for personal data before it reads it. Sync the source, then ask again.`;

export function sourceExposure(columns: ResultColumn[], index: CatalogIndex): string[] {
  const exposed: string[] = [];
  for (const c of columns) {
    if (!c.source) continue;
    const table = resolveTable(index, c.source.schema, c.source.table);
    const column = table?.columns.get(c.source.column.toLowerCase());
    if (column && column.sensitivity !== "none")
      exposed.push(`${c.source.schema}.${c.source.table}.${c.source.column}`);
  }
  return exposed;
}

/**
 * A result that found nothing: no rows, or one row whose numbers are all zero or empty (a count or a sum over
 * nothing). That's when a value it compared with is worth looking up.
 */
export function emptyResult(result: { columns: ResultColumn[]; rows: Cell[][] }): boolean {
  if (!result.rows.length) return true;
  if (result.rows.length > 1) return false;
  const row = result.rows[0] as Cell[];
  const numbers = result.columns.flatMap((c, i) => (c.type === "number" ? [row[i]] : []));
  return numbers.length > 0 && numbers.every((v) => v === null || Number(v) === 0);
}

/** At most this many values of an empty result are looked up live, each reading this many of the column's values. */
const LITERAL_CHECKS = 3;
const LITERAL_VALUES = 5;
const LITERAL_CHECK_MS = 5_000;

/**
 * When a result found nothing, the values it compared text columns with are looked up live: a value the
 * column doesn't hold, or holds only in another case, is the likely reason, and what the column does hold is
 * suggested. Each look is a bounded query OpenDash writes, on the same session; nothing is kept. A value the column has
 * says nothing (something else emptied the result), and so does one too many of its values contain.
 */
async function liveLiteralWarnings(
  dialect: Dialect,
  live: DialectSession,
  info: StatementInfo,
  index: CatalogIndex,
  params: QueryParam[],
  signal?: AbortSignal,
): Promise<string[]> {
  const warnings: string[] = [];
  let checked = 0;
  const quoted = (vs: string[]) => vs.map((v) => `'${v}'`).join(", ");
  for (const literal of info.literals) {
    const table = tableOf(literal, info, index);
    const column = table?.columns.get(literal.column.toLowerCase());
    if (!table || !column || column.sensitivity !== "none" || !column.textual || column.roles.includes("free_text")) {
      continue;
    }
    // A parameter compared with the column is checked like a literal: its text values the same way.
    const fromParams = literal.params.flatMap((ref) => {
      const param = typeof ref === "number" ? params[ref - 1] : params.find((p) => p.name === ref);
      const v = param?.value;
      const at = typeof ref === "number" ? `$${ref} ${param?.name}` : `{${ref}}`;
      const texts = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === "string");
      return texts.map((value) => ({ value, label: `'${value}' (${at})` }));
    });
    const compared = [...literal.values.map((value) => ({ value, label: `'${value}'` })), ...fromParams];
    const where = `${table.schema}.${table.name}.${column.name}`;
    const read = async (search?: string): Promise<string[] | null> => {
      try {
        const q = columnValuesSql(dialect.id, where, search, LITERAL_VALUES + 1);
        const r = await dialect.execute(live, q.sql, {
          params: q.params,
          maxRows: LITERAL_VALUES + 1,
          maxBytes: 64_000,
          timeoutMs: LITERAL_CHECK_MS,
          ...(signal ? { signal } : {}),
        });
        return r.rows.map((row) => String(row[0] ?? ""));
      } catch {
        return null;
      }
    };
    for (const { value, label } of compared) {
      if (!value.trim()) continue;
      if (checked >= LITERAL_CHECKS) return warnings;
      checked += 1;
      const like = await read(value);
      if (!like || like.includes(value)) continue;
      const other = like.find((v) => v.toLowerCase() === value.toLowerCase());
      if (other) {
        warnings.push(`${label} matches ${where} only as '${other}' (different case); use '${other}'.`);
        continue;
      }
      if (like.length > LITERAL_VALUES) continue;
      if (like.length) {
        warnings.push(`${label} isn't a value of ${where}. Values that contain it: ${quoted(like)}.`);
        continue;
      }
      const common = await read();
      warnings.push(
        `${label} isn't a value of ${where}.${common?.length ? ` Its most common values: ${quoted(common.slice(0, LITERAL_VALUES))}${common.length > LITERAL_VALUES ? " and more" : ""}.` : ""}`,
      );
    }
  }
  return warnings;
}

/**
 * The rows a run keeps and the model reads: the first ones, within the byte budget, each cell as Postgres can keep it
 * (storable: a source's string may hold a NUL), so what's kept, shown and cited is one and the same.
 */
function preview(rows: Cell[][]): Cell[][] {
  const out: Cell[][] = [];
  let bytes = 0;
  for (const row of rows.slice(0, BUDGETS.gateway.previewRows)) {
    const kept = storable(row);
    bytes += JSON.stringify(kept).length;
    if (bytes > BUDGETS.gateway.previewBytes) break;
    out.push(kept);
  }
  return out;
}

async function record(
  deps: GatewayDeps,
  req: RecordedRequest,
  outcome: Omit<QueryOutcome, "queryRunId" | "warnings"> & { bytes?: number },
): Promise<string> {
  const id = uuidv7();
  const kept = preview(outcome.rows);
  await deps.withTenant(req.orgId, (tx) =>
    tx.execute(sql`
      insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, tool_call_id, alias, mode,
        path, engine, semantic, title, compiled_sql, written_sql, sql_hash, params, status, error, rows, truncated, bytes,
        duration_ms, result_schema, preview, result_hash, sanity, cache_key, reads)
      values (${id}, ${req.orgId}, ${req.connectionId}, ${req.requester.type}, ${req.requester.id},
        ${req.toolCallId ?? null}, ${req.alias ?? null}, ${req.mode}, ${req.semantic ? "metric" : "raw_sql"},
        ${req.semantic ? "compiler" : "agent_sql"}, ${req.semantic ? JSON.stringify(req.semantic) : null}::jsonb,
        ${req.title ?? null}, ${req.sql}, ${req.writtenSql ?? null},
        ${createHash("sha256").update(req.sql).digest("hex")},
        ${req.params?.length ? JSON.stringify(req.params) : null}::jsonb, ${outcome.status},
        ${outcome.error ? JSON.stringify(outcome.error) : null}::jsonb,
        ${outcome.status === "succeeded" && req.mode === "execute" ? outcome.rowCount : null}, ${outcome.truncated},
        ${outcome.bytes ?? null}, ${outcome.durationMs},
        ${outcome.columns.length ? JSON.stringify(outcome.columns) : null}::jsonb,
        ${req.mode === "execute" && outcome.status === "succeeded" ? JSON.stringify(kept) : null}::jsonb,
        ${req.mode === "execute" && outcome.status === "succeeded" ? createHash("sha256").update(JSON.stringify(outcome.rows)).digest("hex") : null},
        ${JSON.stringify(outcome.checks)}::jsonb, ${req.cacheKey ?? null},
        ${req.reads ? JSON.stringify(req.reads) : null}::jsonb)`),
  );
  return id;
}

/**
 * The result cache's key: the same SQL with the same params on the same source, for the same requester
 * scope, within one freshness bucket. `policy_fp` and `principal_scope` are constants until ee/ data policies; `scope`
 * is the requesting artifact in dashboards v0, so a cached run always belongs to the dashboard that asks.
 */
export function cacheKeyFor(input: {
  connectionId: string;
  sql: string;
  params?: QueryParam[];
  scope: string;
  refreshSeconds: number;
  now: Date;
}): string {
  const bucket = Math.floor(input.now.getTime() / 1000 / input.refreshSeconds);
  const sqlHash = createHash("sha256").update(input.sql).digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.connectionId,
        sqlHash,
        input.params ?? [],
        "policy:none",
        "scope:org",
        input.scope,
        bucket,
      ]),
    )
    .digest("hex");
}

/**
 * Records a query that never reached the source (a metric query the definitions can't express), so that, like every
 * request, it leaves a query_run behind.
 */
export async function recordUnrun(
  deps: GatewayDeps,
  req: QueryRequest,
  error: NonNullable<QueryOutcome["error"]>,
): Promise<QueryOutcome> {
  const empty = { columns: [], rows: [], rowCount: 0, truncated: false, durationMs: null, checks: [] };
  const queryRunId = await record(deps, req, { ...empty, status: "failed", error });
  return { ...empty, queryRunId, status: "failed", warnings: [], error };
}

/** Runs (or checks) one query on a source. Never throws for anything about the query; it's all in the outcome. */
/**
 * Every query through the gateway is one `gateway.query` span (opt-in with an exporter): its
 * source, dialect, status, rows and time, and its query run's id. Never its SQL or parameters.
 */
export function runQuery(deps: GatewayDeps, req: QueryRequest): Promise<QueryOutcome> {
  return tracer.startActiveSpan(
    "gateway.query",
    {
      attributes: {
        "opendash.org_id": req.orgId,
        "opendash.connection_id": req.connectionId,
        "opendash.mode": req.mode,
      },
    },
    async (span) => {
      try {
        const outcome = await execute(deps, req);
        span.setAttributes({
          "opendash.query_run_id": outcome.queryRunId,
          "opendash.status": outcome.status,
          "opendash.rows": outcome.rowCount,
          "opendash.truncated": outcome.truncated,
          ...(outcome.durationMs !== null ? { "opendash.duration_ms": outcome.durationMs } : {}),
          ...(outcome.error ? { "opendash.error_kind": outcome.error.kind } : {}),
        });
        if (outcome.status !== "succeeded") span.setStatus({ code: SpanStatusCode.ERROR });
        return outcome;
      } catch (error) {
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

async function execute(deps: GatewayDeps, req: QueryRequest): Promise<QueryOutcome> {
  const empty = {
    columns: [] as ResultColumn[],
    rows: [] as Cell[][],
    rowCount: 0,
    truncated: false,
    durationMs: null,
    checks: [] as SanityCheck[],
  };
  const fail = async (
    error: NonNullable<QueryOutcome["error"]>,
    status: QueryOutcome["status"] = "failed",
    warnings: string[] = [],
  ) => {
    const queryRunId = await record(deps, recorded, { ...empty, status, error });
    return { ...empty, queryRunId, status, warnings, error } satisfies QueryOutcome;
  };

  // What query_run records as the SQL: the request's, until the dialect hands back the text that will run.
  let recorded: RecordedRequest = req;
  const loaded = await load(deps, req);
  trace.getActiveSpan()?.setAttribute("db.system", loaded.dialect.id);
  const b = BUDGETS.gateway;
  const params = req.params ?? [];
  // The session opens on first use: Postgres checks statements locally and never needs it for a refusal; a dialect
  // whose server does the checking opens it during validate, and the same session runs the query.
  let session: DialectSession | null = null;
  let release: (() => void) | null = null;
  const open = async () => {
    if (session) return session;
    const asked = performance.now();
    try {
      release = await acquire(req.connectionId, loaded.limits.parallel, req.signal);
    } finally {
      // Said whether it got a place or was cancelled while waiting for one.
      req.waited?.(Math.round(performance.now() - asked));
    }
    if (req.signal?.aborted) throw cancelled();
    session = await loaded.dialect.open(loaded.config, loaded.password, {
      edition: deps.edition,
      connectTimeoutMs: b.connectMs,
      statementTimeoutMs: loaded.limits.statementMs,
      applicationName: "opendash-gateway",
      signal: req.signal,
    });
    // Cancelled while it connected (a handshake no step heard it in): the session is closed, nothing runs on it.
    if (req.signal?.aborted) throw cancelled();
    return session;
  };
  // Stopped while it connected (the slot's wait, the host's lookup, the dial) is a cancel, however the step reports it.
  const connectionFailure = (error: unknown) =>
    req.signal?.aborted || (error instanceof QueryError && error.info.kind === "cancelled")
      ? fail(cancelled().info, "cancelled")
      : fail({
          kind: "connection",
          message:
            error instanceof NetworkRefused
              ? error.message
              : loaded.dialect.friendlyError(error, loaded.config, b.connectMs),
        });

  try {
    let check: Awaited<ReturnType<Dialect["validate"]>>;
    try {
      check = await loaded.dialect.validate(req.sql, {
        session: open,
        params,
        timeoutMs: b.explainMs,
        signal: req.signal,
      });
    } catch (error) {
      return await connectionFailure(error);
    }
    /** An error as the model is told it: redacted, with the catalog's closest names and the database's fix. */
    const told = (info: QueryErrorInfo, statement: StatementInfo | null, identifiers: string[]) => {
      const out = withSuggestions(info, statement, loaded.index, identifiers);
      // Compiled metric SQL isn't the model's to restructure: its fix is the definition's, elsewhere.
      const fix = req.semantic ? null : loaded.dialect.advice.hint(info, req.sql);
      return fix ? { ...out, fix } : out;
    };
    if (!check.ok) {
      if (check.kind === "server") return await fail(told(check.error, null, check.identifiers ?? []));
      const kind = check.kind === "syntax" ? "syntax" : "refused";
      const fix =
        kind === "syntax" && !req.semantic
          ? loaded.dialect.advice.hint({ kind, message: check.message }, req.sql)
          : null;
      return await fail({
        kind,
        message: check.message,
        ...(check.position ? { position: check.position } : {}),
        ...(fix ? { fix } : {}),
      });
    }
    // Kept from here on, refused or run: what the statement reads.
    recorded = { ...recorded, reads: readsOf(check.info, loaded.index) };
    const badParams = paramProblem(
      params,
      check.info.params,
      loaded.dialect.paramStyle,
      loaded.dialect.id === "mysql" ? "?" : "$",
    );
    if (badParams) return await fail({ kind: "refused", message: badParams });
    // Functions the database defines run outside every check here, called or not (an operator, a cast, a column's
    // type): the server says which the statement would run. Asked of every statement; the dialect knows what to ask.
    if (loaded.dialect.refuseCalls) {
      let refused: string | null;
      try {
        refused = await loaded.dialect.refuseCalls(await open(), check.info);
      } catch (error) {
        return await connectionFailure(error);
      }
      if (refused) return await fail({ kind: "refused", message: refused });
    }
    // Only learned tables can be read: the personal-data rules below can only protect tables the catalog knows.
    const unknown = unknownTables(check.info, loaded.index);
    if (unknown.length) {
      const first = unknown[0] as (typeof unknown)[number];
      return await fail({
        kind: "unknown_table",
        message: `${unknown.map((u) => u.written).join(", ")} ${unknown.length === 1 ? "isn't a table" : "aren't tables"} in this source's catalog${loaded.index.truncated ? " (only the first tables were learned; syncing again or narrowing the user's grants helps)" : ""}.`,
        suggestions: first.suggestions,
      });
    }
    // A table that isn't learned is profiled before it's read, so its personal data is known first; the
    // index is read again with what that found. More than a few at once, or one that can't be profiled, is refused.
    const unprofiled = [
      ...new Map(
        check.info.tables
          .map((t) => resolveTable(loaded.index, t.schema, t.name))
          .filter((t): t is IndexedTable => !!t && !t.profiled)
          .map((t) => [t.id, t]),
      ).values(),
    ];
    // A check (explain) reads no data, so it never profiles anything: only a query that runs does.
    if (unprofiled.length && req.mode === "execute") {
      const names = unprofiled.map((t) => `${t.schema}.${t.name}`).join(", ");
      const one = unprofiled.length === 1;
      if (unprofiled.length > FIRST_USE_MAX) {
        return await fail({
          kind: "refused",
          message: `${names} aren't learned yet. OpenDash checks a table for personal data before it reads it, ${FIRST_USE_MAX} at a time: ask about fewer at once, or learn them on the source's Overview.`,
        });
      }
      try {
        const live = await open();
        for (const t of unprofiled) await profileOnFirstUse(deps, req, loaded.dialect, live, t.id);
        loaded.index = await deps.withTenant(req.orgId, (tx) => loadCatalogIndex(tx, req.orgId, req.connectionId));
      } catch {
        return await fail({
          kind: "refused",
          message: `OpenDash couldn't check ${names} for personal data, so it doesn't read ${one ? "it" : "them"}. Learn ${one ? "it" : "them"} on the source's Overview first.`,
        });
      }
    }
    // A column the catalog hasn't seen: the server is asked which of the names the statement gives a known table are
    // its real columns. Those are new since the last sync; the rest are names it computes, or typos the server will
    // name. Postgres and MySQL are checked again after the run, from where each result column came from.
    const maybeNew = unknownColumns(check.info, loaded.index);
    if (maybeNew.length && loaded.dialect.columnsOf) {
      let fresh: string[];
      try {
        fresh = await confirmedOnServer(loaded.dialect, await open(), maybeNew);
      } catch (error) {
        return await connectionFailure(error);
      }
      if (fresh.length) return await fail({ kind: "refused", message: notSyncedYet(fresh) });
    }
    const exposure = sensitiveExposure(check.info, loaded.index);
    if (exposure.secret.length) {
      return await fail({
        kind: "personal_data",
        message: `${exposure.secret.join(", ")} ${exposure.secret.length === 1 ? "is a secret" : "are secrets"}: OpenDash doesn't read ${exposure.secret.length === 1 ? "it" : "them"}.`,
      });
    }
    if (exposure.personal.length) {
      return await fail({
        kind: "personal_data",
        message: `${exposure.personal.join(", ")} ${exposure.personal.length === 1 ? "is" : "are"} personal data. OpenDash can count or filter on ${exposure.personal.length === 1 ? "it" : "them"} (count(distinct …), where …) but doesn't return ${exposure.personal.length === 1 ? "its" : "their"} values; select other columns.`,
      });
    }
    // The database's own correctness rules, on SQL the model wrote: a ReplacingMergeTree read without
    // FINAL, a Collapsing one without its sign, integers divided. Only that SQL: a saved tile, a value read or a
    // verified definition's compiled SQL is someone's to fix elsewhere, and a table the catalog hasn't learned has no
    // engine to go by.
    const advice = !req.advise
      ? { warnings: [] }
      : loaded.dialect.advice.check(
          check.info,
          check.info.tables.map((t) => resolveTable(loaded.index, t.schema, t.name) ?? null),
        );
    if (advice.refuse) return await fail({ kind: "refused", message: advice.refuse });
    // The database's warnings come first; the values an empty result compared with are looked up after it runs
    // (below), never from a stored copy.
    const warnings: string[] = [...advice.warnings];
    try {
      await open();
    } catch (error) {
      const failed = await connectionFailure(error);
      return { ...failed, warnings };
    }
    const live = session as unknown as DialectSession;
    // A dialect that rewrites the statement while checking it (ClickHouse's canonical form) runs that text, and the
    // text as written is kept beside it for reading.
    const runs = check.info.sql ?? req.sql;
    recorded = { ...recorded, sql: runs, ...(runs !== req.sql ? { writtenSql: req.sql } : {}) };
    const statement = recorded.sql;

    if (req.mode === "explain") {
      if (req.signal?.aborted) return await fail(cancelled().info, "cancelled", warnings);
      const plan = await loaded.dialect.explain(live, statement, {
        params,
        timeoutMs: b.explainMs,
        signal: req.signal,
      });
      if (!plan.ok) return await fail(told(plan.error, check.info, check.info.identifiers), "failed", warnings);
      const queryRunId = await record(deps, recorded, { ...empty, status: "succeeded" });
      return { ...empty, queryRunId, status: "succeeded", warnings };
    }

    let result: Awaited<ReturnType<Dialect["execute"]>>;
    // Cancelled while it was checked: the statement never starts.
    if (req.signal?.aborted) return await fail(cancelled().info, "cancelled", warnings);
    try {
      result = await loaded.dialect.execute(live, statement, {
        params,
        maxRows: loaded.limits.maxRows,
        maxBytes: b.maxBytes,
        timeoutMs: loaded.limits.statementMs,
        signal: req.signal,
      });
    } catch (error) {
      const info = error instanceof QueryError ? error.info : loaded.dialect.parseError(error);
      const status = info.kind === "timeout" ? "timeout" : info.kind === "cancelled" ? "cancelled" : "failed";
      return await fail(told(info, check.info, check.info.identifiers), status, warnings);
    }
    const unseen = await confirmedOnServer(loaded.dialect, live, unknownSourceColumns(result.columns, loaded.index));
    if (unseen.length) return await fail({ kind: "refused", message: notSyncedYet(unseen) });
    const leaked = sourceExposure(result.columns, loaded.index);
    if (leaked.length) {
      return await fail({
        kind: "personal_data",
        message: `${leaked.join(", ")} ${leaked.length === 1 ? "is" : "are"} personal or secret data; the result was discarded. Select other columns.`,
      });
    }
    if (emptyResult(result)) {
      warnings.push(...(await liveLiteralWarnings(loaded.dialect, live, check.info, loaded.index, params, req.signal)));
    }
    // The database's warnings and the values that aren't among their column's go with the result's own checks, so
    // the query card shows them too.
    const fromAdvice = new Set(advice.warnings);
    const checks: SanityCheck[] = [
      ...warnings.map((message) => ({
        check: fromAdvice.has(message) ? ("advice" as const) : ("value" as const),
        status: "warn" as const,
        message,
      })),
      ...sanityChecks(result, check.info, loaded.index),
    ];
    const outcome = {
      status: "succeeded" as const,
      columns: result.columns,
      rows: result.rows,
      rowCount: result.rows.length,
      truncated: result.truncated,
      durationMs: result.durationMs,
      checks,
      bytes: result.bytes,
    };
    const queryRunId = await record(deps, recorded, outcome);
    return {
      ...outcome,
      queryRunId,
      rows: req.fullRows ? result.rows.map(storable) : preview(result.rows),
      tables: [
        ...new Set(
          check.info.tables.flatMap((t) => {
            const table = resolveTable(loaded.index, t.schema, t.name);
            return table ? [`${table.schema}.${table.name}`] : [];
          }),
        ),
      ],
      warnings: [
        ...checks.filter((c) => c.status === "warn").map((c) => c.message as string),
        ...(result.clippedCells
          ? [
              `${result.clippedCells} long text values were shortened to ${MAX_CELL_CHARS.toLocaleString("en-US")} characters.`,
            ]
          : []),
      ],
    };
  } finally {
    await (session as DialectSession | null)?.close();
    (release as (() => void) | null)?.();
  }
}

/**
 * Whether every part of a name (public.acounts → public, acounts) is among the identifiers the dialect's own
 * parser found in the statement. No lexing of our own: a value can't pass as a name the statement wrote.
 */
export function nameWritten(name: string, identifiers: string[]): boolean {
  const known = new Set(identifiers.map((i) => i.toLowerCase()));
  const parts = name
    .split(".")
    .map((p) => p.replace(/^[`"]|[`"]$/g, "").toLowerCase())
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => known.has(p));
}

/**
 * Server errors go to the model and the trace, and they can quote the data that caused them, in many shapes:
 * "invalid input syntax for type integer: "…"", a cast that reads a value as a query (`::tsquery` → "syntax error
 * in tsquery: "Omar Chen""), as a table name (`::regclass` → "relation "omar" does not exist"), or a function that
 * takes a database name from a value and gets refused on privileges. So:
 *   - an unknown column, table or function keeps its name only if every part of it is an identifier the dialect's
 *     parser found in the statement, and the message is rebuilt around it; otherwise it says only what kind of
 *     error it was;
 *   - a syntax error from the server is rebuilt: statements are parsed before they reach the server (Postgres
 *     locally, ClickHouse by its own parser first), so one at run time comes from a value;
 *   - a permission error is rebuilt without its target;
 *   - everything else loses all quoted text, its detail and its hint.
 */
export function redactError(info: QueryErrorInfo, identifiers: string[] = []): QueryErrorInfo {
  const { detail: _detail, hint: _hint, name, ...rest } = info;
  if (info.kind === "undefined_column" || info.kind === "undefined_table" || info.kind === "undefined_function") {
    if (name && nameWritten(name, identifiers)) {
      const what = info.kind === "undefined_column" ? "column" : info.kind === "undefined_table" ? "table" : "function";
      return {
        ...rest,
        name,
        message: `There's no ${what} ${name}${info.kind === "undefined_function" ? "() with these argument types" : ""}.`,
      };
    }
    return {
      kind: "other",
      message: "Something the query computes named a table, column or function that doesn't exist.",
    };
  }
  if (info.kind === "syntax") {
    return { kind: "other", message: "Something the query computes failed to parse; the statement itself is fine." };
  }
  if (info.kind === "permission") {
    return { kind: "permission", message: "The database user isn't allowed to do part of this query." };
  }
  // A value quoted in a message can hold quotes itself (Postgres and MySQL don't escape them: `""a@b.co""`), so
  // everything from the first quote to the last of each kind goes, never just up to the next one.
  return {
    ...rest,
    message: info.message.replace(/"[\s\S]*"/, '"…"').replace(/'[\s\S]*'/, "'…'"),
  };
}

/** Adds the catalog's closest names to an unknown-column error from the server, after redacting any data in it. */
function withSuggestions(
  raw: QueryErrorInfo,
  statement: StatementInfo | null,
  index: CatalogIndex,
  identifiers: string[],
): NonNullable<QueryOutcome["error"]> {
  const info = redactError(raw, identifiers);
  const { name: unknownName, ...rest } = info;
  const out: NonNullable<QueryOutcome["error"]> = { ...rest };
  const name = info.kind === "undefined_column" ? unknownName : undefined;
  if (info.kind === "undefined_table" && unknownName) {
    const known = [...index.tables.values()].map((t) => `${t.schema}.${t.name}`);
    out.suggestions = closest(unknownName, known);
  }
  if (name) {
    // The statement's tables when it was analysed; otherwise (the server refused it first) every learned table.
    const tables = statement
      ? statement.tables.map((t) => resolveTable(index, t.schema, t.name)).filter((t): t is IndexedTable => Boolean(t))
      : [...index.tables.values()];
    const columns = tables.flatMap((table) =>
      [...table.columns.values()].map((c) => ({ label: `${table.schema}.${table.name}.${c.name}`, name: c.name })),
    );
    const best = closest(name.split(".").at(-1) as string, [...new Set(columns.map((c) => c.name))]);
    out.suggestions = best.flatMap((n) => columns.filter((c) => c.name === n).map((c) => c.label)).slice(0, 3);
  }
  return out;
}

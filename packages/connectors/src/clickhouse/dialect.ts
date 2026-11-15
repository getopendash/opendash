/**
 * The ClickHouse adapter. Every query runs with the session's limits (session.ts): read-only, a server-side time
 * limit, a row cap with `break`, UTC. Rows stream in and stop at the caps, so a huge result is never pulled; aborting
 * the signal cancels the request, and the server cancels the query when the client goes away.
 *
 * ClickHouse doesn't report which table column a result column copies, so the gateway's second personal-data check
 * (server-reported sources) has nothing to read here. The first check covers it instead: on ClickHouse it reads the
 * server's resolved query tree, which already traces every output through CTEs and subqueries to its base columns.
 */
import {
  type Cell,
  type ColumnType,
  type Dialect,
  type ExecuteResult,
  MAX_CELL_CHARS,
  QueryError,
  type QueryErrorInfo,
  type QueryErrorKind,
} from "../dialect";
import { clickHouseAdvice } from "./advice";

import { readCatalog } from "./catalog";
import { queryHistoryClickHouse } from "./history";
import { probeClickHouse } from "./probe";
import { profileRelation } from "./profile";
import {
  type ClickHouseSession,
  fixedSettingsProblem,
  friendlyError,
  openClickHouse,
  queryRows,
  querySettings,
  queryText,
} from "./session";
import { clickhouseSql } from "./sql";
import { paramValues, validateClickHouse } from "./validate";

const ch = (session: unknown) => session as ClickHouseSession;

/** Error codes (ErrorCodes.cpp) to the kinds the repair loop understands. */
const KINDS: Record<string, QueryErrorKind> = {
  "62": "syntax",
  "47": "undefined_column",
  "16": "undefined_column",
  "60": "undefined_table",
  "81": "undefined_table",
  "46": "undefined_function",
  "53": "type",
  "43": "type",
  "6": "type",
  "27": "type",
  "38": "type",
  "41": "type",
  "70": "type",
  "153": "division_by_zero",
  "159": "timeout",
  "394": "cancelled",
  "164": "read_only",
  "497": "permission",
};

/**
 * Where an error came from, which decides what of its text can be shown:
 *   - parse: ClickHouse parsing the statement (canonicalizing it, EXPLAIN AST). It can only quote the SQL.
 *   - analyse / run: the analyzer (which folds constants and runs scalar subqueries) or execution. By then the
 *     statement has parsed, so a "syntax error" or an unknown name may come from a value: formatQuery(email) parses
 *     the email as SQL, hasColumnInTable(e, …) takes it as a database name. These are rebuilt from scratch: an
 *     unknown name is named only if it's in the statement itself; everything else is reduced to the error's type.
 */
export type ErrorStage = { stage: "parse" } | { stage: "analyse" | "run"; sql: string };

type ServerError = { code?: string; message?: string; type?: string; name?: string; cause?: unknown };

/** The server's error itself: the client can wrap ClickHouse's error (with its code) as the cause of another. */
function serverError(error: unknown): ServerError {
  const outer = error as ServerError;
  const cause = outer.cause as { code?: string } | undefined;
  return (cause && typeof cause === "object" && cause.code ? cause : outer) as ServerError;
}

/**
 * The error's name, as ClickHouse gives it (ILLEGAL_AGGREGATION): a kind, never data. From the client's type, or from
 * the message's end, where the server writes it before its version: "… (ILLEGAL_AGGREGATION) (version 26.8.1.1)".
 */
const errorType = (e: ServerError) =>
  e.type ?? /\(([A-Z][A-Z_]+)\)(?:\s*\(version [^)]*\))?\.?\s*$/.exec(e.message ?? "")?.[1];

/** ClickHouse's error, as the gateway reads it, with its name as the code a database's hints key on. */
export function parseClickHouseError(error: unknown, where: ErrorStage = { stage: "run", sql: "" }): QueryErrorInfo {
  if (error instanceof QueryError) return error.info;
  const info = errorInfo(serverError(error), where);
  const code = errorType(serverError(error));
  return code ? { ...info, code } : info;
}

function errorInfo(e: ServerError, where: ErrorStage): QueryErrorInfo {
  if (e.name === "AbortError" || /aborted/i.test(e.message ?? ""))
    return { kind: "cancelled", message: "The query was cancelled." };
  const kind: QueryErrorKind =
    (e.code ? KINDS[e.code] : undefined) ??
    (/ECONN|ENOTFOUND|socket|ETIMEDOUT/i.test(`${e.code} ${e.message}`) ? "connection" : "other");
  const raw = (e.message ?? "The query failed.")
    .replace(/\s*\(version [^)]*\)\s*$/, "")
    .replace(/^Code: \d+\. DB::Exception: /, "");
  const type = errorType(e);
  const unknown =
    /identifier [`']([^`']+)[`']/.exec(raw)?.[1] ??
    /[Tt]able (?:expression identifier )?['`]?([\w.]+)['`]? (?:does not exist|doesn't exist)/.exec(raw)?.[1] ??
    /[Ff]unction with name [`']([^`']+)[`'] does not exist/.exec(raw)?.[1];
  const named = kind === "undefined_column" || kind === "undefined_table" || kind === "undefined_function";

  if (e.code === "456") {
    const name = /Substitution `([^`]+)`/.exec(raw)?.[1];
    return { kind, message: `The SQL uses {${name ?? "…"}} but no parameter has that name.` };
  }
  // Grant messages can name a database or table taken from a value (hasColumnInTable(e, …)); the statement check
  // reads them (to name a refused table function), and the gateway rebuilds them before anyone else sees them.
  if (kind === "permission") return { kind, message: raw };

  if (where.stage === "parse" && (kind === "syntax" || named)) {
    const info: QueryErrorInfo = { kind, message: raw };
    const position = /position (\d+)/.exec(raw)?.[1];
    if (kind === "syntax" && position) info.position = Number(position) + 1;
    if (named && unknown) info.name = unknown;
    return info;
  }
  // An unknown name may have come from a value; the gateway names it only if the statement's parsed identifiers
  // include it. Here it gets a message that says nothing about it.
  if (named && unknown) return { kind, message: "A name in the query doesn't exist.", name: unknown };
  const message =
    kind === "type"
      ? `A value couldn't be converted or compared (${type ?? "type error"}). Check the types and casts.`
      : kind === "division_by_zero"
        ? "The query divided by zero."
        : kind === "syntax"
          ? `Something the query computes failed to parse (${type ?? "SYNTAX_ERROR"}); the statement itself is fine.`
          : `ClickHouse refused the query (${type ?? `code ${e.code ?? "unknown"}`}).`;
  // An unknown name that isn't in the statement came from a value: say what kind of error, nothing more.
  return { kind: named ? "other" : kind, message };
}

/** Result types to the gateway's column types (Nullable and LowCardinality unwrapped). */
function columnType(type: string): ColumnType {
  const t = type.replace(/^LowCardinality\((.*)\)$/, "$1").replace(/^Nullable\((.*)\)$/, "$1");
  if (/^(U?Int\d+|Float\d+|Decimal(\d+)?\(|BFloat16)/.test(t)) return "number";
  if (/^Bool$/.test(t)) return "boolean";
  if (/^Date(32)?$/.test(t)) return "date";
  if (/^DateTime(64)?(\(|$)/.test(t)) return "timestamp";
  if (/^(String|FixedString|Enum|UUID|IPv[46])/.test(t)) return "text";
  if (/^(JSON|Object|Map|Tuple|Array)/.test(t)) return "json";
  return "other";
}

/** The result types the quoting settings send as strings: 64-bit and wider integers, and decimals. */
const EXACT = /^(U?Int(64|128|256)|Decimal)/;

/**
 * A row without the quoting settings (a readonly = 1 user can't set them): a number a double can't hold keeps its
 * digits, from the JSON's own text, and a column of an exact type is a string either way, as with the settings.
 */
export function exactRow(text: string, types: string[]): unknown[] {
  const row = JSON.parse(text, (_key, value, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined && String(value) !== context.source
      ? context.source
      : value,
  ) as unknown[];
  return row.map((value, i) => {
    const type = (types[i] ?? "").replace(/^LowCardinality\((.*)\)$/, "$1").replace(/^Nullable\((.*)\)$/, "$1");
    if (EXACT.test(type)) return typeof value === "number" ? String(value) : value;
    // A float written with an exponent the parser would write differently ("1e21") came back as its text.
    return typeof value === "string" && /^(U?Int|Float|BFloat)/.test(type) ? Number(value) : value;
  });
}

/** JSON-safe cells: exact numbers stay strings, times become ISO strings in UTC. */
function cell(value: unknown, type: ColumnType): Cell {
  if (value === null || value === undefined) return null;
  if (type === "timestamp" && typeof value === "string") {
    const iso = `${value.replace(" ", "T")}${value.includes("T") ? "" : "Z"}`;
    return Number.isNaN(Date.parse(iso)) ? value : new Date(iso).toISOString();
  }
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

export const clickhouseDialect: Dialect = {
  advice: clickHouseAdvice,
  id: "clickhouse",
  name: "ClickHouse",
  defaultPort: 8443,
  paramStyle: "named",
  sql: clickhouseSql,
  probe: probeClickHouse,
  friendlyError,

  notes: (serverVersion) =>
    [
      `ClickHouse${serverVersion ? ` ${serverVersion.split(".").slice(0, 2).join(".")}` : ""}. Write one read-only SELECT (WITH and UNION ALL are fine). No FORMAT, SETTINGS or table functions.`,
      "Qualify tables with their database (billing.invoices). Quote identifiers with backticks only if they need it.",
      "Parameters go in the SQL by name with their type, and in params with the same name: country = {country:String}, created_at >= {from:DateTime64(3, 'UTC')}, plan_id IN {plans:Array(String)}. Use Date for dates.",
      "Months: toStartOfMonth(ts). Ranges: ts >= toDateTime64('2026-09-01', 3, 'UTC') and ts < toDateTime64('2026-10-01', 3, 'UTC'). Times are UTC.",
      "count() counts rows; countIf(cond) and sumIf(x, cond) filter inside; uniqExact(x) counts distinct values exactly. / always returns a float; intDiv(a, b) for integers.",
      "Joins return NULL for missing rows (as in standard SQL). String comparison is case-sensitive; use ilike or lower() when unsure.",
    ].join("\n"),

  async open(config, password, options) {
    const session = await openClickHouse(config, password, options);
    // Checked when it was connected; a server's settings can change since.
    const problem = session.readonly === 1 ? fixedSettingsProblem(session.fixed) : null;
    if (problem) {
      await session.close();
      throw new QueryError({ kind: "read_only", message: problem });
    }
    return session;
  },
  readCatalog: (session, limits) => readCatalog(ch(session), limits),
  queryHistory: (session, options) => queryHistoryClickHouse(ch(session), options.limit),
  profile: (session, relation, catalog, options) => profileRelation(ch(session), relation, catalog, options),

  validate: (sql, context) => validateClickHouse(sql, { ...context, parseError: parseClickHouseError }),
  // Errors the gateway parses itself come from a run.
  parseError: (error) => parseClickHouseError(error, { stage: "run", sql: "" }),
  // Results don't say which table column each one copies, so the gateway asks for a table's columns (system.columns).
  async columnsOf(session, schema, table) {
    const rows = await queryRows<{ name: string }>(
      ch(session),
      "select name from system.columns where database = {d:String} and table = {t:String}",
      { params: { d: schema, t: table } },
    );
    return rows.map((r) => r.name);
  },

  async explain(session, sql, options) {
    try {
      await queryText(ch(session), `EXPLAIN PLAN ${sql}`, {
        params: paramValues(options.params ?? []),
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      return { ok: true, estimatedRows: null };
    } catch (error) {
      return { ok: false, error: parseClickHouseError(error, { stage: "analyse", sql }) };
    }
  },

  async execute(session, sql, options) {
    const s = ch(session);
    const started = performance.now();
    const result: ExecuteResult = { columns: [], rows: [], truncated: false, clippedCells: 0, bytes: 0, durationMs: 0 };
    const clip = (value: Cell): Cell => {
      if (typeof value !== "string" || value.length <= MAX_CELL_CHARS) return value;
      result.clippedCells += 1;
      return `${value.slice(0, MAX_CELL_CHARS)}…`;
    };
    try {
      const rs = await s.client.query({
        query: sql,
        format: "JSONCompactEachRowWithNamesAndTypes",
        query_params: paramValues(options.params ?? []),
        // The server stops at a block boundary past max_result_rows; the loop below keeps exactly maxRows. A
        // readonly = 1 user can't set it: its loop stops reading instead, and the server's time limit ends the query.
        clickhouse_settings:
          s.readonly === 1
            ? {}
            : {
                ...querySettings(s, options.timeoutMs),
                max_result_rows: String(options.maxRows + 1),
                result_overflow_mode: "break",
              },
        ...(options.signal ? { abort_signal: options.signal } : {}),
      });
      let names: string[] | null = null;
      let serverTypes: string[] = [];
      let types: ColumnType[] = [];
      try {
        outer: for await (const batch of rs.stream()) {
          for (const row of batch as { text: string; json: <T>() => T }[]) {
            const values = s.readonly === 1 && types.length ? exactRow(row.text, serverTypes) : row.json<unknown[]>();
            if (!names) {
              names = values as string[];
              continue;
            }
            if (!types.length) {
              serverTypes = values as string[];
              types = serverTypes.map(columnType);
              result.columns = names.map((name, i) => ({ name, type: types[i] ?? "other" }));
              continue;
            }
            if (result.rows.length >= options.maxRows) {
              result.truncated = true;
              break outer;
            }
            const cells = values.map((v, i) => clip(cell(v, types[i] ?? "other")));
            const size = JSON.stringify(cells).length;
            if (result.bytes + size > options.maxBytes) {
              result.truncated = true;
              break outer;
            }
            result.bytes += size;
            result.rows.push(cells);
          }
        }
      } finally {
        rs.close();
      }
    } catch (error) {
      if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
      const info = parseClickHouseError(error, { stage: "run", sql });
      if (info.kind === "timeout") {
        info.message = `The query took longer than ${Math.round(options.timeoutMs / 1000)} s and was stopped.`;
      }
      throw new QueryError(info);
    }
    if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
    result.durationMs = Math.round(performance.now() - started);
    return result;
  },
};

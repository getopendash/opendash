/**
 * The MySQL adapter. Every query runs in a READ ONLY transaction on a read-only session, with max_execution_time as
 * its time limit; rows are streamed and the query is stopped (KILL QUERY, from a second connection) once the caps are
 * reached, so a huge result is never pulled, and its ORDER BY is kept (a wrapping LIMIT could lose it). Cancelling the
 * signal stops the query on the server the same way.
 */
import {
  type Cell,
  type ColumnType,
  type Dialect,
  type DialectSession,
  type ExecuteResult,
  MAX_CELL_CHARS,
  QueryError,
  type QueryErrorInfo,
  type QueryErrorKind,
  type QueryParam,
} from "../dialect";
import { mySqlAdvice } from "./advice";

import { readCatalog } from "./catalog";
import { queryHistoryMySql } from "./history";
import { probeMySql } from "./probe";
import { profileRelation } from "./profile";
import { friendlyError, type MySqlSession, openSession, reach } from "./session";
import { mysqlSql } from "./sql";
import { validateMySql } from "./validate";

const my = (session: DialectSession) => session as MySqlSession;

/** mysql2's column type codes. */
const TYPES: Record<number, ColumnType> = {
  0: "number",
  1: "number",
  2: "number",
  3: "number",
  4: "number",
  5: "number",
  8: "number",
  9: "number",
  13: "number",
  246: "number",
  7: "timestamp",
  12: "timestamp",
  10: "date",
  14: "date",
  11: "interval",
  245: "json",
  15: "text",
  247: "text",
  248: "text",
  253: "text",
  254: "text",
};
const BLOBS = new Set([249, 250, 251, 252]);
const BINARY_CHARSET = 63;

interface Field {
  name: string;
  columnType: number;
  columnLength: number;
  characterSet: number;
  schema?: string;
  orgTable?: string;
  orgName?: string;
}

function columnType(f: Field): ColumnType {
  if (f.columnType === 1 && f.columnLength === 1) return "boolean";
  if (BLOBS.has(f.columnType)) return f.characterSet === BINARY_CHARSET ? "other" : "text";
  return TYPES[f.columnType] ?? "other";
}

/**
 * Parameters in order (?). A list stays a list: in `x in (?)` the driver writes it as escaped values ('a', 'b'). The
 * session pins sql_mode (no NO_BACKSLASH_ESCAPES), so the driver's escaping is the server's.
 */
const bind = (params: QueryParam[] | undefined) => (params ?? []).map((p) => p.value);

function clip(value: string, result: ExecuteResult): string {
  if (value.length <= MAX_CELL_CHARS) return value;
  result.clippedCells += 1;
  return `${value.slice(0, MAX_CELL_CHARS)}…`;
}

function cell(value: unknown, type: ColumnType): Cell {
  if (value === null || value === undefined) return null;
  // Times come as 'YYYY-MM-DD HH:MM:SS[.fff]' in UTC (the session's zone): ISO, like the other dialects.
  if (type === "timestamp" && typeof value === "string") return `${value.replace(" ", "T")}Z`;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `\\x${value.subarray(0, 32).toString("hex")}${value.length > 32 ? "…" : ""}`;
  return JSON.stringify(value);
}

const KINDS: Record<string, QueryErrorKind> = {
  ER_PARSE_ERROR: "syntax",
  ER_BAD_FIELD_ERROR: "undefined_column",
  ER_NO_SUCH_TABLE: "undefined_table",
  ER_BAD_TABLE_ERROR: "undefined_table",
  ER_BAD_DB_ERROR: "undefined_table",
  ER_SP_DOES_NOT_EXIST: "undefined_function",
  ER_FUNC_INEXISTENT_NAME_COLLISION: "undefined_function",
  ER_TRUNCATED_WRONG_VALUE: "type",
  ER_WRONG_VALUE: "type",
  ER_INVALID_JSON_TEXT_IN_PARAM: "type",
  ER_DIVISION_BY_ZERO: "division_by_zero",
  ER_QUERY_TIMEOUT: "timeout",
  ER_QUERY_INTERRUPTED: "cancelled",
  ER_TABLEACCESS_DENIED_ERROR: "permission",
  ER_COLUMNACCESS_DENIED_ERROR: "permission",
  ER_DBACCESS_DENIED_ERROR: "permission",
  ER_SPECIFIC_ACCESS_DENIED_ERROR: "permission",
  ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION: "read_only",
  ER_OPTION_PREVENTS_STATEMENT: "read_only",
};

function parseError(error: unknown): QueryErrorInfo {
  if (error instanceof QueryError) return error.info;
  const e = error as { code?: string; message?: string; sqlMessage?: string; fatal?: boolean };
  const message = e.sqlMessage ?? e.message ?? "The query failed.";
  const known = e.code ? KINDS[e.code] : undefined;
  const kind: QueryErrorKind =
    known ??
    (e.fatal || /PROTOCOL_|ECONN|EPIPE|closed state/i.test(String(e.code ?? message)) ? "connection" : "other");
  const info: QueryErrorInfo = { kind, message };
  // "Unknown column 'a.plan' in 'field list'", "Table 'db.x' doesn't exist", "FUNCTION db.f does not exist".
  const named =
    /Unknown column '([^']+)'/.exec(message)?.[1] ??
    /Table '([^']+)' doesn't exist/.exec(message)?.[1] ??
    /FUNCTION (\S+) does not exist/.exec(message)?.[1];
  if (named && (kind === "undefined_column" || kind === "undefined_table" || kind === "undefined_function")) {
    info.name = named.split(".").at(-1) as string;
  }
  return info;
}

export const mysqlDialect: Dialect = {
  advice: mySqlAdvice,
  id: "mysql",
  name: "MySQL",
  defaultPort: 3306,
  paramStyle: "positional",
  sql: mysqlSql,
  probe: probeMySql,
  friendlyError,

  notes: (serverVersion) =>
    [
      `MySQL${serverVersion ? ` ${serverVersion.split("-")[0]}` : ""}. Write one read-only SELECT (WITH is fine; window functions work).`,
      "Qualify tables with their database (billing.invoices). Quote identifiers with backticks only if they need it.",
      "Parameters are ? in the order of params: country = ?; a list parameter is one ?, as plan_id in (?).",
      "Months: date_format(ts, '%Y-%m-01') or date_sub(date(ts), interval dayofmonth(ts) - 1 day). Ranges: ts >= '2026-09-01' and ts < '2026-10-01'. Times are UTC.",
      "Division with / gives decimals (DIV truncates); dividing by zero gives NULL. Booleans are TINYINT(1): use is_test = false or 0.",
      "Text comparison follows the column's collation, usually case-insensitive. There's no FULL OUTER JOIN and no FILTER clause: use sum(case when … then 1 else 0 end).",
      "Strings in single quotes. No comments, no # and no backslashes: queries with them are refused (use [0-9] in REGEXP).",
    ].join("\n"),

  async open(config, password, options) {
    const { address } = await reach(config, options.edition, options.connectTimeoutMs, options.signal);
    return openSession(config, address, password, options);
  },

  readCatalog: (session, limits) => readCatalog(my(session).conn, limits),
  profile: (session, relation, catalog, options) => profileRelation(my(session).conn, relation, catalog, options),
  queryHistory: (session, options) => queryHistoryMySql(my(session), options.limit),
  validate: async (sql) => validateMySql(sql),
  // A second check: a name on the list that isn't a built-in on this server's version would reach a stored function
  // of that name. One the reader can see is refused (a loadable one can't take a built-in's name).
  async refuseCalls(session, info) {
    if (!info.functions?.length) return null;
    const [rows] = (await my(session).conn.query(
      `select distinct lower(routine_name) as name from information_schema.routines
       where routine_type = 'FUNCTION' and lower(routine_name) in (?) order by 1`,
      [info.functions.map((f) => f.toLowerCase())],
    )) as unknown as [{ name: string }[]];
    const defined = rows.map((r) => `${r.name}()`);
    return defined.length
      ? `${defined.join(", ")} ${defined.length === 1 ? "is" : "are"} defined in the database, not built in: OpenDash runs MySQL's own functions only.`
      : null;
  },
  async columnsOf(session, schema, table) {
    const [rows] = (await my(session).conn.query(
      "select column_name as name from information_schema.columns where table_schema = ? and table_name = ?",
      [schema, table],
    )) as unknown as [{ name: string }[]];
    return rows.map((r) => r.name);
  },
  parseError,

  async explain(session, sql, options) {
    const { conn } = my(session);
    try {
      await conn.query(`set session max_execution_time = ${Math.max(1, Math.floor(options.timeoutMs))}`);
      const [rows] = await conn.query(`explain format=json ${sql}`, bind(options.params));
      const plan = JSON.parse(String((rows as { EXPLAIN: string }[])[0]?.EXPLAIN ?? "{}")) as {
        query_block?: {
          table?: { rows_produced_per_join?: number };
          nested_loop?: { table?: { rows_produced_per_join?: number } }[];
        };
      };
      const block = plan.query_block;
      const last = block?.nested_loop?.at(-1)?.table ?? block?.table;
      return {
        ok: true,
        estimatedRows: typeof last?.rows_produced_per_join === "number" ? last.rows_produced_per_join : null,
      };
    } catch (error) {
      return { ok: false, error: parseError(error) };
    }
  },

  async execute(session, sql, options) {
    const s = my(session);
    const started = performance.now();
    const result: ExecuteResult = { columns: [], rows: [], truncated: false, clippedCells: 0, bytes: 0, durationMs: 0 };
    try {
      await s.conn.query(`set session max_execution_time = ${Math.max(1, Math.floor(options.timeoutMs))}`);
      await s.conn.query("start transaction read only");
      // Cancelled before it starts: its listener below would never hear it, and the statement would run in full.
      if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
      let stopped = false;
      try {
        await new Promise<void>((resolve, reject) => {
          const raw = (s.conn as unknown as { connection: { query: (o: unknown, v: unknown[]) => QueryStream } })
            .connection;
          const query = raw.query({ sql, rowsAsArray: true }, bind(options.params));
          let types: ColumnType[] = [];
          let settled = false;
          const settle = (error?: unknown) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", onAbort);
            if (error) reject(error);
            else resolve();
          };
          // The caps or a cancel: stop it on the server; the stream then ends with "interrupted", which is expected.
          const stop = () => {
            if (stopped) return;
            stopped = true;
            void s.kill();
          };
          const onAbort = () => {
            stop();
            settle(new QueryError({ kind: "cancelled", message: "The query was cancelled." }));
          };
          options.signal?.addEventListener("abort", onAbort, { once: true });
          query.on("fields", (fields: Field[]) => {
            types = fields.map(columnType);
            result.columns = fields.map((f, i) => ({
              name: f.name,
              type: types[i] ?? "other",
              ...(f.orgName && f.orgTable && f.schema
                ? { source: { schema: f.schema, table: f.orgTable, column: f.orgName } }
                : {}),
            }));
          });
          query.on("result", (raw: unknown) => {
            if (stopped || !Array.isArray(raw)) return;
            if (result.rows.length >= options.maxRows) {
              result.truncated = true;
              return stop();
            }
            const row = raw.map((v, i) => {
              const c = cell(v, types[i] ?? "other");
              return typeof c === "string" ? clip(c, result) : c;
            });
            const size = JSON.stringify(row).length;
            if (result.bytes + size > options.maxBytes) {
              result.truncated = true;
              return stop();
            }
            result.bytes += size;
            result.rows.push(row);
          });
          query.on("error", (error: { code?: string }) => {
            // What the caps stopped ends this way; anything else is the query's own error.
            if (stopped && error.code === "ER_QUERY_INTERRUPTED") return settle();
            settle(error);
          });
          query.on("end", () => settle());
        });
      } finally {
        await s.conn.query("commit").catch(() => {});
      }
      if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
      result.durationMs = Math.round(performance.now() - started);
      return result;
    } catch (error) {
      if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
      const info = parseError(error);
      if (info.kind === "timeout") {
        info.message = `The query took longer than ${Math.round(options.timeoutMs / 1000)} s and was stopped.`;
      }
      throw new QueryError(info);
    }
  },
};

interface QueryStream {
  on(event: "fields", fn: (fields: Field[]) => void): QueryStream;
  on(event: "result", fn: (row: unknown) => void): QueryStream;
  on(event: "error", fn: (error: { code?: string }) => void): QueryStream;
  on(event: "end", fn: () => void): QueryStream;
}

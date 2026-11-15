/**
 * What every database adapter provides (the Dialect interface). Safety is server-side first: a read-only
 * user (checked at connect time), a read-only mode the server enforces per query, then `validate` as the third layer.
 * Postgres validates with its own parser; a dialect with no parser in JavaScript can validate with EXPLAIN.
 *
 * Everything above this (the gateway, the tools, the agent) talks only to this interface.
 */
import type { BuildInfo, CatalogSnapshot, RelationInfo } from "./catalog-types";
import type { Edition } from "./network";
import type { PostgresConfig } from "./postgres/session";
import type { ProbeOptions, ProbeResult } from "./probe-types";
import type { ProfileOptions, TableProfile } from "./profiling";
import type { SqlBuilder } from "./sql-builder";

export type DialectId = "postgres" | "clickhouse" | "mysql";

/**
 * Where a source is and how to sign in, the same fields for every dialect: host, port, database, user and SSL mode
 * (on ClickHouse, SSL mode picks HTTP or HTTPS, and whether the certificate is verified).
 */
export type SourceConfig = PostgresConfig;

export interface StatementInfo {
  /**
   * Base tables and views the statement reads (CTE names excluded). ClickHouse: `final` when every read of it says
   * FINAL.
   */
  tables: { schema: string | null; name: string; alias: string | null; final?: boolean }[];
  /**
   * Values compared with a column: `country = 'DE'`, `status in ('active', 'paused')`, and parameters in the same
   * places (`country = $1` by its 1-based number on Postgres; `country = {country:String}` by name on ClickHouse).
   * A dialect whose server substitutes parameters before analysing reports their values as literals instead.
   */
  literals: { qualifier: string | null; column: string; values: string[]; params: (number | string)[] }[];
  /** The parameters the statement uses, each once: numbers ($1, $2…, ascending) or names ({country:String}). */
  params: (number | string)[];
  /**
   * Every name written in the statement (tables, schemas, columns, aliases, functions, types), as the dialect's own
   * parser saw them, never literals. An error naming something outside this list got the name from a value.
   */
  identifiers: string[];
  /** Aggregated columns: `sum(s.amount_cents)`. */
  aggregates: { fn: string; qualifier: string | null; column: string }[];
  /** ClickHouse: every column read inside an aggregate's arguments (`sum(x * sign)`, `sumIf(x, …)`), for its advice. */
  aggregated?: { qualifier: string | null; column: string }[];
  joins: number;
  /** Every column reference anywhere in the statement. */
  references: { qualifier: string | null; column: string }[];
  /** Column references whose values the statement returns (select lists, outside count()). A single name may be a
   * whole-row reference to a table alias, e.g. to_jsonb(u). */
  returned: { qualifier: string | null; column: string }[];
  /**
   * The statement as it should run, when the dialect rewrote it while checking (ClickHouse runs its server's
   * canonical form, so what runs is exactly what was checked). Absent: run the SQL as given.
   */
  sql?: string;
  /** The functions the statement calls, by name as the parser read it (checked against the server before it runs). */
  functions?: string[];
  /** Postgres: the operators and types it uses, which run functions of their own (checked the same way). */
  operators?: string[];
  types?: string[];
  /**
   * Postgres: divisions whose sides are a count() or a column (`count(x) / count(y)`, `a.paid / a.total`), where
   * integer division would round the result down (DialectAdvice.check).
   */
  divisions?: { left: DivisionSide; right: DivisionSide }[];
  /** `*` and `t.*` in select lists, with the base tables directly in that SELECT's FROM. */
  stars: { qualifier: string | null; from: { schema: string | null; name: string; alias: string | null }[] }[];
}

export type StatementCheck =
  | { ok: true; info: StatementInfo }
  | {
      ok: false;
      kind:
        | "syntax"
        | "empty"
        | "multiple_statements"
        | "not_a_query"
        | "writes_data"
        | "creates_table"
        | "locks_rows"
        | "denied_function"
        | "denied_clause";
      message: string;
      /** 1-based character offset in the SQL. */
      position?: number;
    };

export type ColumnType = "number" | "text" | "boolean" | "date" | "timestamp" | "interval" | "json" | "other";

export interface ResultColumn {
  name: string;
  type: ColumnType;
  /** The table column this result column is a plain copy of, when the server reports one (no expression). */
  source?: { schema: string; table: string; column: string };
}

/** Longest text value kept in a result cell; longer ones are cut and counted (ExecuteResult.clippedCells). */
export const MAX_CELL_CHARS = 2_000;

/** Cells are JSON-safe: exact decimals stay strings, times are ISO strings. */
export type Cell = string | number | boolean | null;

export interface ExecuteResult {
  columns: ResultColumn[];
  rows: Cell[][];
  /** More rows (or bytes) existed than the caps allowed. */
  truncated: boolean;
  /** Text values cut to MAX_CELL_CHARS. */
  clippedCells: number;
  bytes: number;
  durationMs: number;
}

/**
 * A parameter value, bound by the database itself (never pasted into the SQL). The server infers its type from where
 * it's used: '2026-09-01' compared with a timestamp is a timestamp. Lists go with `= any($1)`.
 */
export type ParamValue = string | number | boolean | null | (string | number)[];

/** A parameter with a name that says what it is: country, from, to. Postgres binds them in order ($1, $2…). */
export interface QueryParam {
  name: string;
  value: ParamValue;
}

export interface ExecuteOptions {
  params?: QueryParam[];
  maxRows: number;
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
}

export type QueryErrorKind =
  | "syntax"
  | "undefined_column"
  | "undefined_table"
  | "undefined_function"
  | "type"
  | "division_by_zero"
  | "timeout"
  | "cancelled"
  | "permission"
  | "read_only"
  | "connection"
  | "other";

/** One side of a division: a column as written, or a count(). */
export type DivisionSide = { qualifier: string | null; column: string } | { count: true };

export interface QueryErrorInfo {
  kind: QueryErrorKind;
  message: string;
  /** The server's own name for the error (ClickHouse's ILLEGAL_AGGREGATION): it says what kind, never what data. */
  code?: string;
  /** For undefined_column, undefined_table and undefined_function: the name the server didn't know. */
  name?: string;
  position?: number;
  hint?: string;
  detail?: string;
}

export class QueryError extends Error {
  override name = "QueryError";
  constructor(readonly info: QueryErrorInfo) {
    super(info.message);
  }
}

/** An open, read-only connection. Opaque outside its dialect. */
/**
 * One statement from the database's own query history, in its normalized form (literals replaced by placeholders),
 * so no value anyone filtered by is kept.
 */
export interface HistoryStatement {
  /** The database's id for the normalized statement (pg_stat_statements' queryid, ClickHouse's hash). */
  fingerprint: string;
  sql: string;
  calls: number;
  totalMs: number;
  /** The tables it read (`schema.table`), when the history records them; otherwise they're parsed from `sql`. */
  tables?: string[];
  /** The columns it read (`schema.table.column`), when the history records them. */
  columns?: string[];
}

export type QueryHistory =
  | { available: true; statements: HistoryStatement[] }
  /** Why there's none, and what would turn it on. */
  | { available: false; reason: string };

export interface DialectSession {
  close(): Promise<void>;
}

export interface OpenOptions {
  edition: Edition;
  connectTimeoutMs: number;
  statementTimeoutMs: number;
  applicationName: string;
  signal?: AbortSignal;
}

export interface Dialect {
  id: DialectId;
  name: string;
  defaultPort: number;
  /** How SQL refers to parameters: $1, $2… by position, or {country:String} by name. */
  paramStyle: "positional" | "named";
  /** The pieces of SQL the semantic compiler writes differently here (quoting, time, windows, parameters). */
  sql: SqlBuilder;
  /** Short instructions for the model: functions, quoting, dates, parameters, pitfalls of this database. */
  notes(serverVersion?: string): string;
  /** The connection check: reach, sign in, can't change data, catalog. Never writes. */
  probe(config: SourceConfig, password: string, options: ProbeOptions): Promise<ProbeResult>;
  /** What to tell a person when connecting fails: wrong password, unknown host, a firewall… */
  friendlyError(error: unknown, config: SourceConfig, timeoutMs: number): string;
  open(config: SourceConfig, password: string, options: OpenOptions): Promise<DialectSession>;
  readCatalog(session: DialectSession, limits: { maxRelations: number }): Promise<CatalogSnapshot>;
  /**
   * The team's most-run reads, from the history the database keeps, never OpenDash's own (its role's). Absent for a
   * dialect whose history OpenDash doesn't read yet.
   */
  queryHistory?(session: DialectSession, options: { limit: number }): Promise<QueryHistory>;
  profile(
    session: DialectSession,
    relation: RelationInfo,
    catalog: CatalogSnapshot,
    options: ProfileOptions,
  ): Promise<TableProfile>;
  /**
   * The statement check: one read-only SELECT, and what grounding needs (tables, columns, literals). Postgres parses
   * locally and never opens the session; a dialect without a parser in JavaScript asks its server, so the session
   * (opened on first use) and the parameters come along. A server-side error (an unknown column) is `kind: "server"`.
   */
  validate(
    sql: string,
    context: { session: () => Promise<DialectSession>; params: QueryParam[]; timeoutMs: number; signal?: AbortSignal },
  ): Promise<StatementCheck | { ok: false; kind: "server"; error: QueryErrorInfo; identifiers?: string[] }>;
  /** The plan without running the query; a failure comes back as the server's error. */
  explain(
    session: DialectSession,
    sql: string,
    options: { params?: QueryParam[]; timeoutMs: number; signal?: AbortSignal },
  ): Promise<{ ok: true; estimatedRows: number | null } | { ok: false; error: QueryErrorInfo }>;
  /** Runs one read-only query with caps. Throws QueryError. */
  execute(session: DialectSession, sql: string, options: ExecuteOptions): Promise<ExecuteResult>;
  parseError(error: unknown): QueryErrorInfo;
  /**
   * Why the functions a checked statement calls can't run, or null: one the database defines (Postgres, MySQL) can
   * read any table past every check, or reach the network. Asked of the server before the query runs; `validate`
   * stays a parse, so reading the team's past statements never needs it.
   */
  refuseCalls?(session: DialectSession, info: StatementInfo): Promise<string | null>;
  /**
   * A table's columns as the server has them now, so the gateway can tell a column added since the last sync from a
   * name a statement computes (a CTE's `__d0`, which ClickHouse's analysis and MySQL's result metadata both report as
   * a table's).
   */
  columnsOf?(session: DialectSession, schema: string, table: string): Promise<string[]>;
  /** What this database needs that its notes can't enforce: checks, hints, the Modeler's example. */
  advice: DialectAdvice;
}

/** A table a checked statement reads, as the catalog knows it: how it's built, and its columns' types by name. */
export interface AdvisedTable {
  schema: string;
  name: string;
  build: BuildInfo | null;
  columns: Map<string, { type: string | null }>;
}

/**
 * A database's own advice: the correctness rules its notes state in words, held in code where code can
 * see them, and said at the moment they matter, so they cost nothing until then.
 */
export interface DialectAdvice {
  /**
   * Checks a statement the model wrote before it runs, against what the catalog knows of its tables (`tables[i]` is
   * `info.tables[i]`'s, null when it isn't learned): a refusal says what to write instead, and a warning goes with
   * the result. Never asked of compiled metric SQL: a verified definition is its admin's to fix.
   */
  check(info: StatementInfo, tables: (AdvisedTable | null)[]): { refuse?: string; warnings: string[] };
  /** A one-line fix for an error this database is known for, from its code and the model's SQL; null if none. */
  hint(error: QueryErrorInfo, sql: string): string | null;
  /** A distinct count of a column where a condition holds, in this database's SQL (the Modeler's example). */
  countDistinctWhere(column: string, condition: string): string;
}

/**
 * The Postgres adapter. Every query runs in a READ ONLY transaction with a server-side statement timeout, on a
 * session that is itself read-only by default; rows are read with a cursor and stop at the caps, so a huge result is
 * never pulled. Cancelling the signal cancels the statement on the server.
 */
import type postgres from "postgres";
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
import { postgresAdvice } from "./advice";
import { readCatalog } from "./catalog";
import { queryHistoryPostgres } from "./history";
import { probePostgres } from "./probe";
import { profileRelation } from "./profile";
import { friendlyError, openSession, reach } from "./session";
import { postgresSql } from "./sql";
import { validatePostgres } from "./validate";

interface PgSession extends DialectSession {
  sql: postgres.Sql;
}

const pg = (session: DialectSession) => (session as PgSession).sql;

/**
 * Extensions whose types, operators, casts and comparisons only compute, though some of their functions don't: those
 * functions are refused when called by name. PostGIS raster's can read files on the server (out-db rasters, GDAL).
 */
const IMPLEMENTING_EXTENSIONS = ["postgis_raster"];

/** Extensions whose functions only compute (geometry, text matching, types): their functions may run. */
const COMPUTE_EXTENSIONS = [
  "postgis",
  "postgis_sfcgal",
  "vector",
  "pg_trgm",
  "fuzzystrmatch",
  "unaccent",
  "citext",
  "hstore",
  "cube",
  "earthdistance",
  "intarray",
  "ltree",
  "uuid-ossp",
  "pgcrypto",
  "isn",
  "seg",
  "btree_gin",
  "btree_gist",
];

export const definedInDatabase = (names: string[]) =>
  `${names.join(", ")} ${names.length === 1 ? "is" : "are"} defined in the database, not built in: OpenDash runs built-in functions, operators and types only.`;

/**
 * What a statement uses that this database defines outside pg_catalog, other than a computing extension's: functions
 * it calls, operators (their code is a function), types whose input, output or cast runs a function defined outside
 * it, and, for the columns of the tables it reads (whose types it never names), the implicit casts to or from their
 * types such a function makes: `lower(mood)` runs one. Names are matched exactly, as the parser read them.
 * As `name()`, `operator name`, `type name`, `the cast from a to b`.
 */
export async function outsideCatalog(
  sql: postgres.Sql,
  info: {
    functions?: string[];
    operators?: string[];
    types?: string[];
    tables?: { schema: string | null; name: string }[];
  },
): Promise<string[]> {
  const functions = info.functions ?? [];
  const operators = info.operators ?? [];
  const types = info.types ?? [];
  const tables = info.tables ?? [];
  if (!functions.length && !operators.length && !types.length && !tables.length) return [];
  const rows = await sql.unsafe<{ what: string }[]>(
    `with recursive owned(objid, ext) as (
       select d.objid, e.extname from pg_depend d join pg_extension e on e.oid = d.refobjid
       where d.classid = 'pg_proc'::regclass and d.deptype = 'e'),
     -- Built in means made by initdb (an OID below 16384, FirstNormalObjectId), not living in pg_catalog: an
     -- extension or a superuser can put functions there too (adminpack's file writers are).
     foreign_fn(oid) as (
       select p.oid from pg_proc p
       where p.oid >= 16384 and p.oid not in (select objid from owned where ext = any($4::text[]))),
     -- What runs a type, an operator, a cast or a comparison: an extension's whose functions don't all only compute
     -- may still implement these with ones that do (PostGIS raster's = and its input).
     foreign_impl(oid) as (
       select p.oid from pg_proc p
       where p.oid >= 16384 and p.oid not in (select objid from owned where ext = any($4::text[]) or ext = any($7::text[]))),
     read_rels(oid) as (
       select to_regclass(case when r.s is null then quote_ident(r.n) else quote_ident(r.s) || '.' || quote_ident(r.n) end)
       from unnest($5::text[], $6::text[]) as r(s, n)),
     -- A type is named as one (x::t) or as a function-style cast (t(x)).
     named_types(oid) as (select oid from pg_type where typname = any($3::text[]) or typname = any($1::text[])),
     -- Every type a value in the statement has: those it names, its read columns' and rows' (a whole-row
     -- reference), and what they're made of, all the way down (a domain's base type, an array's elements, a
     -- composite's fields, a range's values).
     seen_types(oid) as (
       select oid from named_types
       union
       select a.atttypid from pg_attribute a
       where a.attrelid in (select oid from read_rels) and a.attnum > 0 and not a.attisdropped
       union
       select c.reltype from pg_class c where c.oid in (select oid from read_rels)
       union
       select x.oid from seen_types st join pg_type t on t.oid = st.oid
       cross join lateral (
         select t.typbasetype union all select t.typelem
         union all select a.atttypid from pg_attribute a where a.attrelid = t.typrelid and a.attnum > 0
         union all select r.rngsubtype from pg_range r where r.rngtypid = t.oid) as x(oid)
       where x.oid <> 0),
     -- The types a value can have: seen, built in (what built-in functions return), or an extension's (what a
     -- computing extension's functions return: PostGIS's geometry).
     in_play(oid) as (
       select oid from seen_types
       union select oid from pg_type where oid < 16384
       union select d.objid from pg_depend d where d.classid = 'pg_type'::regclass and d.deptype = 'e'),
     runs(oid) as (
       select t.oid from pg_type t
       -- Any function the type runs: reading and writing values (text and binary), its modifiers, a range's
       -- canonical form and differences, and what a domain's check constraints call.
       where t.typinput::oid in (select oid from foreign_impl) or t.typoutput::oid in (select oid from foreign_impl)
         or t.typreceive::oid in (select oid from foreign_impl) or t.typsend::oid in (select oid from foreign_impl)
         or t.typmodin::oid in (select oid from foreign_impl) or t.typmodout::oid in (select oid from foreign_impl)
         or exists (select 1 from pg_range r where r.rngtypid = t.oid
           and (r.rngcanonical::oid in (select oid from foreign_impl) or r.rngsubdiff::oid in (select oid from foreign_impl)))
         or exists (select 1 from pg_constraint k
           join pg_depend d on d.classid = 'pg_constraint'::regclass and d.objid = k.oid
             and d.refclassid = 'pg_proc'::regclass
           where k.contypid = t.oid and d.refobjid in (select oid from foreign_impl)))
     select p.proname::text || '()' as what from pg_proc p
       where p.proname = any($1::text[]) and p.oid in (select oid from foreign_fn)
     union
     select 'operator ' || o.oprname from pg_operator o
       where o.oprname = any($2::text[])
         -- Its code runs on each row; its selectivity estimators when the query is planned.
         and (o.oprcode::oid in (select oid from foreign_impl) or o.oprrest::oid in (select oid from foreign_impl)
           or o.oprjoin::oid in (select oid from foreign_impl))
     union
     -- A type's own functions run whenever a value of it is read, written out or cast (and a domain's checks).
     select 'type ' || t.typname from pg_type t
       where t.oid in (select oid from seen_types) and t.oid in (select oid from runs)
     union
     -- Operators on a seen type run unnamed too: order by, group by, distinct, in and joins compare its values
     -- with its operator classes' operators and support functions.
     select 'operator ' || o.oprname from pg_amop m join pg_operator o on o.oid = m.amopopr
       where (m.amoplefttype in (select oid from seen_types) or m.amoprighttype in (select oid from seen_types))
         and (o.oprcode::oid in (select oid from foreign_impl) or o.oprrest::oid in (select oid from foreign_impl)
           or o.oprjoin::oid in (select oid from foreign_impl))
     union
     select 'the comparison of ' || format_type(p.amproclefttype, null) from pg_amproc p
       where (p.amproclefttype in (select oid from seen_types) or p.amprocrighttype in (select oid from seen_types))
         and p.amproc::oid in (select oid from foreign_impl)

     union
     -- A cast through such a function can run when both its types are in play; one only written (x::t) when its
     -- target is named, while an implicit one, or one on assignment, runs by itself.
     select 'the cast from ' || format_type(c.castsource, null) || ' to ' || format_type(c.casttarget, null)
       from pg_cast c
       where c.castfunc in (select oid from foreign_impl)
         and c.castsource in (select oid from in_play) and c.casttarget in (select oid from in_play)
         and (c.castcontext in ('i', 'a') or c.casttarget in (select oid from named_types))
     order by 1`,
    [
      functions,
      operators,
      types,
      COMPUTE_EXTENSIONS,
      tables.map((t) => t.schema),
      tables.map((t) => t.name),
      IMPLEMENTING_EXTENSIONS,
    ],
  );
  return rows.map((r) => r.what);
}
const EXPLAIN = "explain (format json) ";

const TYPES: Record<number, ColumnType> = {
  16: "boolean",
  20: "number",
  21: "number",
  23: "number",
  26: "number",
  700: "number",
  701: "number",
  790: "number",
  1700: "number",
  1082: "date",
  1114: "timestamp",
  1184: "timestamp",
  1083: "other",
  1266: "other",
  1186: "interval",
  114: "json",
  3802: "json",
  25: "text",
  18: "text",
  19: "text",
  1042: "text",
  1043: "text",
  2950: "text",
};

/** Parameters go to the server in order ($1, $2…) with no declared type; it infers each from where it's used. */
const bind = (params: QueryParam[] | undefined) =>
  (params ?? []).map((p) => p.value) as postgres.ParameterOrJSON<never>[];

/** Rows fetched per round trip: small, so the byte cap is checked before much is held in memory. */
const BATCH_ROWS = 50;

function clip(value: string, result: ExecuteResult): string {
  if (value.length <= MAX_CELL_CHARS) return value;
  result.clippedCells += 1;
  return `${value.slice(0, MAX_CELL_CHARS)}…`;
}

function cell(value: unknown): Cell {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (Buffer.isBuffer(value)) return `\\x${value.subarray(0, 32).toString("hex")}${value.length > 32 ? "…" : ""}`;
  return JSON.stringify(value);
}

const KINDS: Record<string, QueryErrorKind> = {
  "42601": "syntax",
  "42703": "undefined_column",
  "42P01": "undefined_table",
  "3F000": "undefined_table",
  "42883": "undefined_function",
  "42804": "type",
  "42846": "type",
  "22P02": "type",
  "22007": "type",
  "22008": "type",
  "22012": "division_by_zero",
  "57014": "timeout",
  "42501": "permission",
  "25006": "read_only",
};

function parseError(error: unknown): QueryErrorInfo {
  if (error instanceof QueryError) return error.info;
  const e = error as { code?: string; message?: string; position?: string | number; hint?: string; detail?: string };
  const known = e.code ? KINDS[e.code] : undefined;
  const kind: QueryErrorKind =
    known ?? (/connect|ECONN|terminat/i.test(String(e.code ?? e.message)) ? "connection" : "other");
  const info: QueryErrorInfo = { kind, message: e.message ?? "The query failed." };
  const unknown = /(?:column|relation|function) "?([^"\s(]+)"?(?:\(.*\))? does not exist/.exec(info.message)?.[1];
  if (unknown && (kind === "undefined_column" || kind === "undefined_table" || kind === "undefined_function")) {
    info.name = unknown;
  }
  if (e.position !== undefined && e.position !== "") info.position = Number(e.position);
  if (e.hint) info.hint = e.hint;
  if (e.detail) info.detail = e.detail;
  return info;
}

export const postgresDialect: Dialect = {
  advice: postgresAdvice,
  id: "postgres",
  name: "PostgreSQL",
  defaultPort: 5432,
  paramStyle: "positional",
  sql: postgresSql,
  probe: probePostgres,
  friendlyError,

  notes: (serverVersion) =>
    [
      `PostgreSQL${serverVersion ? ` ${serverVersion.split(" ")[0]}` : ""}. Write one read-only SELECT (WITH is fine).`,
      "Qualify tables with their schema (billing.invoices). Quote identifiers with double quotes only if they need it.",
      "Parameters are $1, $2… in the order of params: country = $1; lists with plan_id = any($2).",
      "Months: date_trunc('month', ts). Ranges: ts >= date '2026-09-01' and ts < date '2026-10-01'. Timestamps are UTC.",
      "Integer division truncates: cast to numeric before dividing. Text comparison is case-sensitive; use ilike when unsure.",
    ].join("\n"),

  async open(config, password, options) {
    const { address } = await reach(config, options.edition, options.connectTimeoutMs, options.signal);
    const { sql, close } = openSession(config, address, password, options);
    const session: PgSession = { sql, close };
    return session;
  },

  readCatalog: (session, limits) => readCatalog(pg(session), limits),
  queryHistory: (session, options) => queryHistoryPostgres(pg(session), options.limit),
  profile: (session, relation, catalog, options) => profileRelation(pg(session), relation, catalog, options),
  validate: (sql) => validatePostgres(sql),
  async columnsOf(session, schema, table) {
    const rows = await pg(session).unsafe<{ name: string }[]>(
      "select column_name::text as name from information_schema.columns where table_schema = $1 and table_name = $2",
      [schema, table],
    );
    return rows.map((r) => r.name);
  },
  // A function defined in the database (an extension's, or a team's own) can read any table, past every check, or
  // reach the network: only built-in ones run, and those of extensions that only compute.
  async refuseCalls(session, info) {
    const outside = await outsideCatalog(pg(session), info);
    return outside.length ? definedInDatabase(outside) : null;
  },
  parseError,

  async explain(session, sql, options) {
    try {
      const rows = await pg(session).begin("read only", async (tx) => {
        await tx.unsafe(`set local statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`);
        return tx.unsafe<{ "QUERY PLAN": { Plan?: { "Plan Rows"?: number } }[] }[]>(
          `${EXPLAIN}${sql}`,
          bind(options.params),
        );
      });
      const plan = rows[0]?.["QUERY PLAN"]?.[0]?.Plan;
      return { ok: true, estimatedRows: typeof plan?.["Plan Rows"] === "number" ? plan["Plan Rows"] : null };
    } catch (error) {
      const info = parseError(error);
      // Positions count from the start of what we sent; report them against the caller's SQL.
      if (info.position !== undefined) info.position = Math.max(1, info.position - EXPLAIN.length);
      return { ok: false, error: info };
    }
  },

  async execute(session, sql, options) {
    const started = performance.now();
    try {
      return await pg(session).begin("read only", async (tx) => {
        await tx.unsafe(`set local statement_timeout = ${Math.max(1, Math.floor(options.timeoutMs))}`);
        // Cancelled before it starts: its listener below would never hear it, and the statement would run in full.
        if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
        const pending = tx.unsafe(sql, bind(options.params)).values();
        const cancel = () => void pending.cancel();
        options.signal?.addEventListener("abort", cancel, { once: true });
        let origins: ({ table: number; number: number } | null)[] = [];
        const result: ExecuteResult = {
          columns: [],
          rows: [],
          truncated: false,
          clippedCells: 0,
          bytes: 0,
          durationMs: 0,
        };
        try {
          for await (const batch of pending.cursor(Math.min(options.maxRows + 1, BATCH_ROWS))) {
            if (!result.columns.length) {
              const cols =
                (batch as unknown as { columns?: { name: string; type: number; table?: number; number?: number }[] })
                  .columns ?? [];
              result.columns = cols.map((c) => ({ name: c.name, type: TYPES[c.type] ?? "other" }));
              origins = cols.map((c) => (c.table && c.number ? { table: c.table, number: c.number } : null));
            }
            for (const raw of batch as unknown as unknown[][]) {
              if (result.rows.length >= options.maxRows) {
                result.truncated = true;
                break;
              }
              const row = raw.map((v) => {
                const c = cell(v);
                return typeof c === "string" ? clip(c, result) : c;
              });
              const size = JSON.stringify(row).length;
              if (result.bytes + size > options.maxBytes) {
                result.truncated = true;
                break;
              }
              result.bytes += size;
              result.rows.push(row);
            }
            if (result.truncated) break;
          }
        } finally {
          options.signal?.removeEventListener("abort", cancel);
        }
        if (options.signal?.aborted) throw new QueryError({ kind: "cancelled", message: "The query was cancelled." });
        // Where each result column comes from, as the server reports it (a second, independent check on what a
        // query returns: the gateway refuses values from personal-data columns whatever the SQL looked like).
        const pairs = origins.filter((o): o is { table: number; number: number } => o !== null);
        if (pairs.length) {
          const named = await tx.unsafe<{ oid: number; num: number; schema: string; tbl: string; col: string }[]>(
            `select c.oid::int as oid, a.attnum::int as num, n.nspname as schema, c.relname as tbl, a.attname as col
             from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
             where (a.attrelid::int, a.attnum::int) in (select * from unnest($1::int[], $2::int[]))`,
            [pairs.map((p) => p.table), pairs.map((p) => p.number)],
          );
          origins.forEach((o, i) => {
            const hit = o && named.find((r) => r.oid === o.table && r.num === o.number);
            const column = result.columns[i];
            if (hit && column) column.source = { schema: hit.schema, table: hit.tbl, column: hit.col };
          });
        }
        result.durationMs = Math.round(performance.now() - started);
        return result;
      });
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

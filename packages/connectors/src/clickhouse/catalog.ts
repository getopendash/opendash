/**
 * What a ClickHouse user can see, from system.tables and system.columns (no table scans). Databases play the part
 * of Postgres schemas. ClickHouse declares no foreign keys and its primary keys aren't unique, so joins and keys are
 * left to the profiler.
 *
 * Streaming engines are left out: reading a Kafka, RabbitMQ, NATS, FileLog or S3Queue table consumes its messages,
 * which is a write in disguise. So are tables reading from outside (URL, S3, MySQL…): their data isn't the
 * database's, and reading them makes the server call out.
 */
import {
  type BuildInfo,
  type CatalogSnapshot,
  COMMENT_READ_CHARS,
  type ColumnInfo,
  type RelationInfo,
} from "../catalog-types";
import { type ClickHouseSession, queryRows } from "./session";

const SYSTEM_DATABASES = ["system", "INFORMATION_SCHEMA", "information_schema"];
const EXCLUDED_ENGINES = [
  "Kafka",
  "RabbitMQ",
  "NATS",
  "FileLog",
  "S3Queue",
  "AzureQueue",
  "URL",
  "S3",
  "AzureBlobStorage",
  "HDFS",
  "File",
  "MySQL",
  "PostgreSQL",
  "MongoDB",
  "Redis",
  "ODBC",
  "JDBC",
  "SQLite",
  "ExternalDistributed",
  "Hive",
  "Iceberg",
  "DeltaLake",
  "Hudi",
  "Executable",
  "ExecutablePool",
];
const VIEW_ENGINES = ["View"];
const DEFINED_ENGINES = ["View", "MaterializedView"];
const NAME = "(?:`(?:[^`\\\\]|\\\\.)+`|[A-Za-z_][\\w$]*)";
const READ = new RegExp(`\\b(?:FROM|JOIN)\\s+(${NAME}(?:\\.${NAME})?)`, "gi");
const unquote = (name: string) => name.replace(/^`(.*)`$/, "$1").replace(/\\(.)/g, "$1");

/**
 * The tables a view reads, from the names after FROM and JOIN in its cleaned definition, kept only when they're
 * tables this catalog knows (a CTE's or a subquery's name isn't). Text only: nothing is asked of the server, so a
 * view's query never runs, not even to be analysed (a scalar subquery or a table function in it would).
 */
export function viewReads(
  definition: string,
  view: { schema: string; name: string },
  known: { schema: string; name: string }[],
): { schema: string; name: string }[] {
  const has = new Set(known.map((k) => `${k.schema}\u0000${k.name}`));
  const found = new Map<string, { schema: string; name: string }>();
  for (const m of definition.matchAll(READ)) {
    const parts = (m[1] ?? "").match(new RegExp(NAME, "g")) ?? [];
    const schema = parts.length === 2 ? unquote(parts[0] as string) : view.schema;
    const name = unquote(parts.at(-1) ?? "");
    const id = `${schema}\u0000${name}`;
    if (has.has(id) && !(schema === view.schema && name === view.name)) found.set(id, { schema, name });
  }
  return [...found.values()];
}

/** A key expression without its string literals: `if(kind = 'x', …)` keeps its shape, never its values. */
const withoutStrings = (expr: string) => expr.replace(/'(?:[^'\\]|\\.)*'/g, "?").trim();

/** The bare column names among an engine's arguments: ReplacingMergeTree(updated_at), never a replica's path. */
export function engineColumns(engineFull: string): string[] {
  const args = /^\w+\(([^)]*)\)/.exec(engineFull)?.[1];
  if (!args) return [];
  return args
    .split(",")
    .map((a) => a.trim().replace(/^`(.*)`$/, "$1"))
    .filter((a) => /^[A-Za-z_]\w*$/.test(a));
}

const inner = (type: string) => type.replace(/^LowCardinality\((.*)\)$/, "$1").replace(/^Nullable\((.*)\)$/, "$1");

export function classifyType(type: string) {
  const t = inner(inner(type));
  return {
    textual: /^(String|FixedString\(\d+\)|Enum(8|16)?\()/.test(t),
    temporal: /^(Date|Date32|DateTime|DateTime64)(\(|$)/.test(t),
    numeric: /^(U?Int\d+|Float\d+|Decimal(\d+)?\(|BFloat16)/.test(t),
    nullable: /Nullable\(/.test(type),
  };
}

export const quoteIdent = (name: string) => `\`${name.replaceAll("\\", "\\\\").replaceAll("`", "\\`")}\``;
export const qualified = (r: { schema: string; name: string }) => `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`;

const list = (values: string[]) =>
  values.map((v) => `'${v.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`).join(", ");

export async function readCatalog(
  session: ClickHouseSession,
  limits: { maxRelations: number },
): Promise<CatalogSnapshot> {
  // A view's definition comes back cleaned on the server (literals as ?, comments gone): its raw text never leaves it.
  const tables = await queryRows<{
    database: string;
    name: string;
    engine: string;
    engine_full: string;
    comment: string;
    total_rows: string | null;
    sorting_key: string;
    primary_key: string;
    partition_key: string;
    cleaned: string | null;
  }>(
    session,
    `select database, name, engine, engine_full, substringUTF8(comment, 1, ${COMMENT_READ_CHARS}) as comment,
       total_rows, sorting_key, primary_key, partition_key,
       if(engine in (${list(DEFINED_ENGINES)}), normalizeQueryKeepNames(formatQuerySingleLineOrNull(as_select)), null) as cleaned
     from system.tables
     where database not in (${list(SYSTEM_DATABASES)}) and not is_temporary and engine not in (${list(EXCLUDED_ENGINES)})
     order by database, name limit {limit:UInt32}`,
    { params: { limit: limits.maxRelations + 1 } },
  );
  const truncated = tables.length > limits.maxRelations;
  const kept = tables.slice(0, limits.maxRelations);
  const databases = [...new Set(kept.map((t) => t.database))];
  const columns = databases.length
    ? await queryRows<{
        database: string;
        table: string;
        name: string;
        type: string;
        position: string;
        comment: string;
        is_in_primary_key: number;
      }>(
        session,
        `select database, table, name, type, position, substringUTF8(comment, 1, ${COMMENT_READ_CHARS}) as comment,
           is_in_primary_key from system.columns
         where database in (${list(databases)}) order by database, table, position`,
      )
    : [];
  const dbRows = databases.length
    ? await queryRows<{ name: string; comment: string }>(
        session,
        `select name, substringUTF8(comment, 1, ${COMMENT_READ_CHARS}) as comment from system.databases
         where name in (${list(databases)}) order by name`,
      )
    : [];

  // Names with control characters could forge lines in ClickHouse's explain output (validate.ts): a table whose
  // database, table or column names have any is left out, so the gateway refuses it as an unknown table.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this looks for
  const control = /[\u0000-\u001f\u007f]/;
  const clean = kept.filter(
    (t) =>
      !control.test(t.database) &&
      !control.test(t.name) &&
      !columns.some((c) => c.database === t.database && c.table === t.name && control.test(c.name)),
  );
  const relations: RelationInfo[] = clean.map((t) => {
    const own = columns.filter((c) => c.database === t.database && c.table === t.name);
    const cols: ColumnInfo[] = own.map((c) => {
      const k = classifyType(c.type);
      return {
        name: c.name,
        ordinal: Number(c.position),
        type: c.type,
        textual: k.textual,
        temporal: k.temporal,
        numeric: k.numeric,
        nullable: k.nullable,
        comment: c.comment || null,
      };
    });
    const key = own.filter((c) => Number(c.is_in_primary_key) === 1).map((c) => c.name);
    const view = VIEW_ENGINES.includes(t.engine);
    const rows = t.total_rows === null ? null : Number(t.total_rows);
    const columnsOfEngine = engineColumns(t.engine_full ?? "");
    const build: BuildInfo = {
      engine: t.engine,
      ...(columnsOfEngine.length ? { engineColumns: columnsOfEngine } : {}),
      ...(t.sorting_key ? { sortingKey: withoutStrings(t.sorting_key) } : {}),
      ...(t.primary_key ? { primaryKey: withoutStrings(t.primary_key) } : {}),
      ...(t.partition_key ? { partitionKey: withoutStrings(t.partition_key) } : {}),
      ...(t.cleaned && !control.test(t.cleaned) ? { definition: t.cleaned.slice(0, 8_000) } : {}),
    };
    return {
      schema: t.database,
      name: t.name,
      kind: view ? "view" : "table",
      comment: t.comment || null,
      rowsEstimate: view ? null : rows,
      analyzed: rows !== null,
      columns: cols,
      // A single-column primary key is the likely row key; the profiler checks it's actually unique.
      primaryKey: key.length === 1 ? key : [],
      uniques: [],
      foreignKeys: [],
      build,
    };
  });
  for (const relation of relations) {
    const definition = relation.build?.definition;
    if (!definition || !relation.build) continue;
    const reads = viewReads(definition, relation, relations);
    if (reads.length) relation.build.reads = reads;
  }
  return {
    schemas: dbRows.map((d) => ({ name: d.name, comment: d.comment || null })),
    relations,
    truncated,
  };
}

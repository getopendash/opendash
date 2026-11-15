/**
 * The data API's compiler: a dashboard's JSON request, checked against its grants, becomes one parameterised SQL
 * statement over a verified dataset, in the source's dialect. A dashboard never sends SQL: every name it uses must be a
 * granted column of a granted dataset, every value becomes a parameter, and the dataset's own SQL (verified by an
 * admin) is the only SQL from outside this file. The statement then goes through the query gateway like any other
 * (read-only, the catalog's tables only, personal columns refused, time and row limits).
 *
 * Shape: `with __d as (<dataset SQL>) select … from __d where <default segments> and <filters> [group by] order by …
 * limit … offset …`, with `count(*) over ()` as `__total`: how many rows (or groups) matched before the page.
 */
import {
  AGGREGATES,
  type Aggregate,
  type ColumnKind,
  GRAINS,
  type Grain,
  type Grants,
  OPS,
  type Op,
  PAGE_CAP,
  ROW_CAP,
} from "@opendash/apps/protocol";
import { type DialectId, dialectFor, type ParamKind, type ParamValue, type QueryParam } from "@opendash/connectors";
import { type LoadedCatalog, PLAIN_NAME } from "./catalog";

export class QueryRefused extends Error {
  override name = "QueryRefused";
}

export interface CompiledQuery {
  sql: string;
  params: QueryParam[];
  dataset: string;
  mode: "rows" | "aggregate";
  /** The output columns, in order, with how the frame reads each. */
  columns: { name: string; kind: ColumnKind }[];
  /** The key column of a rows request, when the dataset has one and it's granted. */
  key?: string;
  limit: number;
  offset: number;
}

const TOTAL = "__total";
const MAX_FILTERS = 20;
const MAX_LIST = 500;
const MAX_TEXT = 200;
const MAX_OFFSET = 1_000_000;
const GRAIN_ORDER: Record<Grain, number> = { day: 0, week: 1, month: 2, quarter: 3, year: 4 };

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Compiles a dashboard's request against its grants and the source's verified datasets. Throws QueryRefused. */
export function compileQuery(request: unknown, grants: Grants, loaded: LoadedCatalog): CompiledQuery {
  if (!isRecord(request)) throw new QueryRefused("The request isn't a query.");
  const from = request.from;
  if (typeof from !== "string" || !PLAIN_NAME.test(from)) throw new QueryRefused("Say which dataset: `from`.");
  const grant = Object.hasOwn(grants.datasets, from) ? grants.datasets[from] : undefined;
  const entry = loaded.datasets.get(from);
  const described = Object.hasOwn(loaded.catalog, from) ? loaded.catalog[from] : undefined;
  if (!grant || !entry || !described) throw new QueryRefused(`This dashboard isn't granted the dataset "${from}".`);
  const spec = entry.spec;
  const columnSpecs = new Map(spec.columns.map((c) => [c.name, c]));
  const granted = new Set(grant.columns.filter((c) => PLAIN_NAME.test(c) && Object.hasOwn(described.columns, c)));
  const dialect: DialectId = loaded.dialect;
  const b = dialectFor(dialect).sql;
  const id = (name: string) => b.ident(name);

  const column = (name: unknown, what: string): string => {
    if (typeof name !== "string" || !granted.has(name)) {
      throw new QueryRefused(`${what} "${String(name)}" isn't granted on ${from}.`);
    }
    return name;
  };

  const params: QueryParam[] = [];
  // A new parameter for every place one is read: MySQL binds ? by position.
  const param = (value: ParamValue, kind: ParamKind): string => {
    params.push({ name: `p${params.length + 1}`, value });
    return b.param(params.length, `p${params.length}`, kind);
  };
  const like = (text: string) => `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const contains = (expr: string, text: string): string =>
    dialect === "clickhouse"
      ? `positionCaseInsensitiveUTF8(toString(${expr}), ${param(text, "string")}) > 0`
      : dialect === "postgres"
        ? `${expr}::text ilike ${param(like(text), "string")}`
        : `${expr} like ${param(like(text), "string")}`;
  const ordered = (expr: string, desc: boolean) =>
    dialect === "mysql"
      ? `${expr} is null, ${expr} ${desc ? "desc" : "asc"}`
      : `${expr} ${desc ? "desc" : "asc"} nulls last`;

  /** A filter value as its column's type: a number, a time, a boolean or text. */
  const typed = (name: string, value: unknown): { value: ParamValue; kind: ParamKind } => {
    const type = columnSpecs.get(name)?.type ?? "string";
    if (type === "number") {
      const n =
        typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
      if (!Number.isFinite(n)) throw new QueryRefused(`${name} takes a number.`);
      // Whole-number text a number can't hold exactly would match another value (another record's key): refused,
      // never rounded.
      if (typeof value === "string" && /^-?\d+$/.test(value.trim()) && BigInt(value.trim()) !== BigInt(n)) {
        throw new QueryRefused(`${name} is too large to match exactly.`);
      }
      return { value: n, kind: "number" };
    }
    if (type === "time") {
      const t =
        typeof value === "string" ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value) : null;
      if (!t || Number.isNaN(t.getTime())) throw new QueryRefused(`${name} takes a date, like 2026-09-01.`);
      return { value: b.timeValue(t), kind: "time" };
    }
    if (type === "boolean") {
      if (value === true || value === "true") return { value: true, kind: "boolean" };
      if (value === false || value === "false") return { value: false, kind: "boolean" };
      throw new QueryRefused(`${name} takes true or false.`);
    }
    if (typeof value !== "string" && typeof value !== "number") throw new QueryRefused(`${name} takes text.`);
    const text = String(value);
    if (text.length > MAX_TEXT) throw new QueryRefused(`A value for ${name} is at most ${MAX_TEXT} characters.`);
    return { value: text, kind: "string" };
  };

  // Where: the dataset's default segments (part of what its numbers mean), then the App's filters, then a search.
  const where: string[] = spec.segments.filter((s) => s.default).map((s) => `(${s.where})`);
  const filters = request.where ?? [];
  if (!Array.isArray(filters) || filters.length > MAX_FILTERS) {
    throw new QueryRefused(`\`where\` is a list of at most ${MAX_FILTERS} filters.`);
  }
  for (const f of filters) {
    if (!Array.isArray(f) || f.length < 2) throw new QueryRefused("A filter is [column, operator, value].");
    const [name, op, value] = f as [unknown, unknown, unknown];
    const col = column(name, "The filter column");
    if (typeof op !== "string" || !OPS.includes(op as Op))
      throw new QueryRefused(`There's no operator "${String(op)}".`);
    const expr = id(col);
    if (op === "is null" || op === "is not null") {
      where.push(`${expr} ${op}`);
    } else if (op === "in" || op === "not in") {
      if (!Array.isArray(value) || value.length > MAX_LIST) {
        throw new QueryRefused(`"${op}" takes a list of at most ${MAX_LIST} values.`);
      }
      const type = columnSpecs.get(col)?.type;
      if (type === "time") throw new QueryRefused(`${col} can't be filtered with a list.`);
      if (type === "boolean") {
        // true, false or both: one predicate (a list of booleans has no list type to bind).
        const values = [...new Set(value.map((v) => typed(col, v).value as boolean))];
        const one = values.length === 1 ? `${expr} = ${param(values[0] as boolean, "boolean")}` : null;
        const listed = !values.length ? "(1 = 0)" : values.length > 1 ? `(${expr} is not null)` : (one as string);
        where.push(op === "in" ? listed : `not (${listed})`);
        continue;
      }
      if (!value.length) {
        where.push(op === "in" ? "(1 = 0)" : "(1 = 1)");
      } else {
        const values = value.map((v) => typed(col, v).value) as (string | number)[];
        const list = b.inList(expr, param(values, type === "number" ? "numbers" : "strings"));
        where.push(op === "in" ? list : `not (${list})`);
      }
    } else if (op === "contains") {
      if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
        throw new QueryRefused(`"contains" takes text of at most ${MAX_TEXT} characters.`);
      }
      where.push(contains(expr, value.trim()));
    } else {
      if (value === undefined || value === null || typeof value === "object") {
        throw new QueryRefused(`"${op}" takes one value.`);
      }
      const v = typed(col, value);
      where.push(`${expr} ${op === "!=" ? "<>" : op} ${param(v.value, v.kind)}`);
    }
  }
  if (request.search !== undefined && request.search !== "") {
    const text = request.search;
    if (typeof text !== "string" || text.length > 100)
      throw new QueryRefused("A search is text of at most 100 characters.");
    // The asked query's own columns when it says (a list's search), and only searchable ones the dashboard reads.
    const scope = Array.isArray(request.searchIn) ? request.searchIn : [...granted];
    const searchable = scope.filter((c) => granted.has(c) && described.columns[c]?.search);
    if (!grant.search || !searchable.length) throw new QueryRefused(`This dashboard can't search ${from}.`);
    if (text.trim()) where.push(`(${searchable.map((c) => contains(id(c), text.trim())).join(" or ")})`);
  }
  // A metric's segments narrow the query's rows (the check keeps them from changing another measure's): its own
  // segments on top of the dataset's defaults, never a table of snapshots added up across them.
  const asked = isRecord(request.measures) ? Object.values(request.measures) : [];
  const metricSegments = new Set<string>();
  for (const def of asked) {
    if (!Array.isArray(def) || def[0] !== "metric") continue;
    const metric = loaded.metrics.get(String(def[1]));
    if (!metric || metric.spec.dataset !== from) throw new QueryRefused(`${from} has no metric "${String(def[1])}".`);
    if (spec.snapshot)
      throw new QueryRefused(`${String(def[1])} is a state taken each period: it can't be added up here.`);
    for (const seg of metric.spec.segments) metricSegments.add(seg);
  }
  // Segments named by the request: a metric's, on the rows behind its number.
  if (request.segments !== undefined) {
    // Names only: each must be a segment of the dataset (below), as many as a metric may have.
    if (!Array.isArray(request.segments)) throw new QueryRefused("`segments` is a list of names.");
    for (const seg of request.segments) metricSegments.add(String(seg));
  }
  for (const name of metricSegments) {
    const seg = spec.segments.find((x) => x.name === name);
    if (!seg) throw new QueryRefused(`${from} has no segment "${name}".`);
    if (!seg.default) where.push(`(${seg.where})`);
  }
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";
  const datasetSql = spec.sql.trim().replace(/;\s*$/, "");

  // ---- an aggregate: measures grouped by columns ------------------------------------------------------------------
  if (request.measures !== undefined) {
    if (!isRecord(request.measures) || !Object.keys(request.measures).length) {
      throw new QueryRefused('`measures` names what to compute: { mrr: ["sum", "mrr"] }.');
    }
    const by = request.by ?? [];
    if (!Array.isArray(by) || by.length > 4) throw new QueryRefused("`by` is a list of at most 4 columns.");
    const keys = by.map((raw) => {
      if (typeof raw !== "string") throw new QueryRefused("`by` takes column names.");
      const [name, grain] = raw.split(":") as [string, string | undefined];
      const col = column(name, "The group-by column");
      if (grain === undefined) return { alias: col, expr: id(col), kind: described.columns[col]?.kind ?? "text" };
      const colSpec = columnSpecs.get(col);
      if (!GRAINS.includes(grain as Grain) || colSpec?.type !== "time") {
        throw new QueryRefused(`"${raw}" isn't a date grouping: a date column and day, week, month, quarter or year.`);
      }
      if (colSpec.grain && GRAIN_ORDER[grain as Grain] < GRAIN_ORDER[colSpec.grain]) {
        throw new QueryRefused(`${col} is by ${colSpec.grain} at the finest; group it by ${colSpec.grain} or longer.`);
      }
      return { alias: `${col}_${grain}`, expr: b.truncTime(id(col), grain as Grain), kind: "date" as ColumnKind };
    });
    const measures = Object.entries(request.measures).map(([alias, def]) => {
      if (!PLAIN_NAME.test(alias) || alias === TOTAL) throw new QueryRefused(`A measure can't be called "${alias}".`);
      if (!Array.isArray(def) || def.length < 1) throw new QueryRefused(`Measure ${alias} is ["sum", "column"].`);
      const [agg, target] = def as [unknown, unknown];
      if (agg === "metric") {
        const metric = loaded.metrics.get(String(target));
        const m = metric ? spec.measures.find((x) => x.name === metric.spec.measure) : undefined;
        if (!m) throw new QueryRefused(`${from} has no metric "${String(target)}".`);
        return { alias, expr: m.expr, kind: "number" as ColumnKind };
      }
      if (agg === "measure") {
        const m = spec.measures.find((x) => x.name === target);
        if (!m) throw new QueryRefused(`${from} has no measure "${String(target)}".`);
        return { alias, expr: m.expr, kind: "number" as ColumnKind };
      }
      if (typeof agg !== "string" || !AGGREGATES.includes(agg as Aggregate)) {
        throw new QueryRefused(`There's no aggregate "${String(agg)}".`);
      }
      if (agg === "count") return { alias, expr: "count(*)", kind: "number" as ColumnKind };
      const name = column(target, `The ${agg} column`);
      const col = id(name);
      // The earliest or latest of a date is a date, of a text is a text; everything else is a number.
      const kind: ColumnKind = agg === "min" || agg === "max" ? (described.columns[name]?.kind ?? "number") : "number";
      return { alias, expr: agg === "count_distinct" ? `count(distinct ${col})` : `${agg}(${col})`, kind };
    });
    const names = new Set([...keys.map((k) => k.alias), ...measures.map((m) => m.alias)]);
    if (names.size !== keys.length + measures.length) throw new QueryRefused("Two outputs have the same name.");
    const sort = request.sort ?? keys.map((k) => k.alias);
    if (!Array.isArray(sort) || sort.length > 4) throw new QueryRefused("`sort` is a list of at most 4 names.");
    const order = sort.map((s) => {
      if (typeof s !== "string") throw new QueryRefused("`sort` takes names.");
      const desc = s.startsWith("-");
      const name = desc ? s.slice(1) : s;
      if (!names.has(name)) throw new QueryRefused(`"${name}" isn't in the result, so it can't sort it.`);
      return ordered(id(name), desc);
    });
    const limit = clamp(request.limit, ROW_CAP, ROW_CAP, "limit");
    const select = [
      ...keys.map((k) => `${k.expr} as ${id(k.alias)}`),
      ...measures.map((m) => `${m.expr} as ${id(m.alias)}`),
      `count(*) over () as ${id(TOTAL)}`,
    ];
    const sql = [
      `with ${id("__d")} as (\n${datasetSql}\n)`,
      `select ${select.join(", ")} from ${id("__d")}`,
      whereSql,
      keys.length ? `group by ${keys.map((k) => k.expr).join(", ")}` : "",
      order.length ? `order by ${order.join(", ")}` : "",
      `limit ${limit}`,
    ]
      .filter(Boolean)
      .join("\n");
    return {
      sql,
      params,
      dataset: from,
      mode: "aggregate",
      columns: [
        ...keys.map((k) => ({ name: k.alias, kind: k.kind })),
        ...measures.map((m) => ({ name: m.alias, kind: m.kind })),
      ],
      limit,
      offset: 0,
    };
  }

  // ---- rows: granted columns, paged ---------------------------------------------------------------------------------
  const select = request.select;
  if (!Array.isArray(select) || !select.length || select.length > 40) {
    throw new QueryRefused("Name the columns to read: `select`, at most 40.");
  }
  const chosen = [...new Set(select.map((s) => column(s, "The column")))];
  const key = described.key && granted.has(described.key) ? described.key : undefined;
  if (key && !chosen.includes(key)) chosen.push(key);
  const sort = request.sort ?? [];
  if (!Array.isArray(sort) || sort.length > 4) throw new QueryRefused("`sort` is a list of at most 4 columns.");
  const order = sort.map((s) => {
    if (typeof s !== "string") throw new QueryRefused("`sort` takes column names.");
    const desc = s.startsWith("-");
    return ordered(id(column(desc ? s.slice(1) : s, "The sort column")), desc);
  });
  // The key last, so pages don't overlap or skip rows that sort the same; with no key, every column listed.
  if (key) order.push(ordered(id(key), false));
  else for (const c of chosen) order.push(ordered(id(c), false));
  const page = isRecord(request.page) ? request.page : {};
  const limit = clamp(page.size, PAGE_CAP, PAGE_CAP, "page size");
  const offset = clamp(page.offset ?? 0, MAX_OFFSET, 0, "offset", 0);
  const sql = [
    `with ${id("__d")} as (\n${datasetSql}\n)`,
    `select ${[...chosen.map(id), `count(*) over () as ${id(TOTAL)}`].join(", ")} from ${id("__d")}`,
    whereSql,
    order.length ? `order by ${order.join(", ")}` : "",
    `limit ${limit}${offset ? ` offset ${offset}` : ""}`,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    sql,
    params,
    dataset: from,
    mode: "rows",
    columns: chosen.map((c) => ({ name: c, kind: described.columns[c]?.kind ?? "text" })),
    ...(key ? { key } : {}),
    limit,
    offset,
  };
}

/** A whole number within [min, max]; `fallback` when it's left out. */
function clamp(value: unknown, max: number, fallback: number, what: string, min = 1): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new QueryRefused(`The ${what} is a whole number of at least ${min}.`);
  }
  return Math.min(value, max);
}

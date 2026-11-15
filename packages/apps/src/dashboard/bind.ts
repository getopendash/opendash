/**
 * A named query bound to the filter values the frame sent, as the compiler's request (`QuerySpec`): the server's half
 * of "the frame names things, it never describes them". Every value is checked against the definition: a filter the
 * query doesn't take, a value that isn't one of a filter's options, a period that isn't one, a page past the cap, or a
 * sort on a column the query doesn't read is refused. A period is a range of days (periods.ts).
 *
 * Grants come from the definition too (`grantsOf`): a dashboard reads the columns its queries name, and no others.
 */

import {
  type CatalogDataset,
  countAlias,
  type Grants,
  MAX_OFFSET,
  type Op,
  PAGE_CAP,
  type QuerySpec,
} from "../protocol";
import { type Definition, isPeriod, metricSegmentsOf, type NamedQuery, outputsOf } from "./definition";
import { periodRange, previousRange, type Range, yearBeforeRange } from "./periods";

export class BindRefused extends Error {
  override name = "BindRefused";
}

/**
 * A rows query's own condition on one of its columns: a column it lists, an operator from a short list, and values
 * bound as parameters. Never a column, operator or expression the definition doesn't allow.
 */
export type Condition = [string, "in" | "contains" | ">=" | "<=" | "<" | "is null", unknown?];
export const CONDITION_OPS = ["in", "contains", ">=", "<=", "<", "is null"] as const;
/** At most this many conditions on a query, and values in an `in`. */
export const MAX_CONDITIONS = 8;
export const MAX_VALUES = 50;

/** What the frame sends for a query: its filters' values, and for rows, a page, a sort, a page size and conditions. */
export interface QueryAsk {
  filters?: Record<string, string | string[]>;
  /** 0 for the first page. */
  page?: number;
  /** One of the query's columns, `-` for descending. */
  sort?: string;
  /** Rows a page holds: the query's own, or one its rows declare. */
  pageSize?: number;
  /** Conditions on its columns (a query whose rows declare conditions). */
  where?: Condition[];
  /** The record shown: its key. */
  record?: string | number;
  /** A search: text, in the query's own searchable columns. */
  search?: string;
}

/** A key's bounds: a number exactly as sent (never past the safe integer range), or text of at most 200 characters. */
export const MAX_KEY = 200;

/**
 * The condition a record puts on a query: a query drawn for a record (`record`) narrows its column to the key and runs
 * only with one; a query with a key (`key`) narrows its key column when asked for one record. Any other query takes
 * no key. The key only narrows: it never reads past what the query's own definition reads.
 */
export function recordScope(d: Definition, queryId: string, key: unknown): [string, Op, unknown] | null {
  const q = Object.hasOwn(d.queries, queryId) ? d.queries[queryId] : undefined;
  const column = q?.record ?? q?.key;
  if (key === undefined || key === null) {
    if (q?.record) throw new BindRefused(`${queryId} is drawn for a record: say which.`);
    return null;
  }
  if (!column) throw new BindRefused(`${queryId} isn't drawn for a record.`);
  const fits =
    (typeof key === "string" && key.length > 0 && key.length <= MAX_KEY) ||
    (typeof key === "number" && Number.isFinite(key) && (!Number.isInteger(key) || Number.isSafeInteger(key)));
  if (!fits) throw new BindRefused("A record's key is a number, or text of at most 200 characters.");
  return [column, "=", key];
}

export interface BindContext {
  now: Date;
  /** The workspace's time zone: what today is. */
  tz: string;
  /** The datasets a query may read, by name (the source's and the dashboard's own): the rows behind a number. */
  datasets?: Record<string, CatalogDataset>;
}

/** At most this many columns in the rows behind a number. */
export const DRILL_COLUMNS = 12;

/**
 * The columns the rows behind one of a query's numbers show, when it declares no drill of its own: only columns the
 * dashboard's queries already read, so the rows show nothing they don't (personal data is never one: the gateway
 * refuses to return it). The query's own groups, every column a rows query on the same dataset lists (the dataset's
 * key among them when one does), and the columns a dashboard's own dataset declares: its SQL was written for this
 * dashboard, and Publish says everyone it's shared with sees what that returns.
 */
export function drillColumnsOf(d: Definition, queryId: string, ds: CatalogDataset | undefined): string[] {
  const q = Object.hasOwn(d.queries, queryId) ? d.queries[queryId] : undefined;
  if (!q || !ds) return [];
  const out: string[] = [];
  const add = (c: string | undefined) => {
    if (c && !out.includes(c) && Object.hasOwn(ds.columns, c)) out.push(c);
  };
  const listed = Object.values(d.queries)
    .filter((o) => o.source.connection === q.source.connection && o.source.dataset === q.source.dataset)
    .flatMap((o) => o.select ?? []);
  if (ds.key && listed.includes(ds.key)) add(ds.key);
  for (const b of q.by ?? []) add(b.split(":")[0]);
  for (const c of listed) add(c);
  const own = d.datasets?.[q.source.dataset];
  if (own && own.connection === q.source.connection) for (const c of own.columns) add(c.name);
  return out.slice(0, DRILL_COLUMNS);
}

export { MAX_OFFSET };

/** Each filter's value: what was sent, checked, or its default. */
export function filterValues(
  d: Definition,
  sent: Record<string, string | string[]> = {},
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [fid, value] of Object.entries(sent)) {
    const f = Object.hasOwn(d.filters, fid) ? d.filters[fid] : undefined;
    if (!f) throw new BindRefused(`There's no filter ${fid}.`);
    if (f.kind === "period") {
      if (typeof value !== "string" || !isPeriod(value)) throw new BindRefused(`${fid} takes a period.`);
    } else {
      if (!Array.isArray(value)) throw new BindRefused(`${fid} takes a list.`);
      if (f.multiple === false && value.length > 1) throw new BindRefused(`${fid} takes one value.`);
      if (f.values) {
        // From the warehouse: any value it could have, bound as a parameter (one it doesn't have matches nothing).
        if (value.length > MAX_VALUES) throw new BindRefused(`${fid} takes at most ${MAX_VALUES} values.`);
        for (const v of value) {
          if (typeof v !== "string" || v.length > 200) throw new BindRefused(`${fid} takes values of text.`);
        }
      } else {
        if (value.length > f.options.length) throw new BindRefused(`${fid} takes a list.`);
        for (const v of value)
          if (!f.options.includes(v)) throw new BindRefused(`"${v}" isn't one of ${fid}'s options.`);
      }
    }
    out[fid] = value;
  }
  for (const [fid, f] of Object.entries(d.filters)) if (!(fid in out)) out[fid] = f.default;
  return out;
}

const condition = (column: string, range: Range): [string, ">=" | "<", string][] => [
  [column, ">=", range.from],
  [column, "<", range.to],
];

/** Whether a query's rows may be filtered by column: its rows declare it. */
const takesConditions = (d: Definition, queryId: string) => d.queries[queryId]?.rows?.conditions === true;

/** A query's conditions, checked: a column its query lists, an operator from the list, values of the right shape. */
function conditions(d: Definition, queryId: string, q: NamedQuery, sent: Condition[] | undefined, skip?: string) {
  if (!sent?.length) return [] as [string, Op, unknown?][];
  if (!q.select || !takesConditions(d, queryId)) throw new BindRefused(`${queryId} takes no conditions.`);
  if (!Array.isArray(sent) || sent.length > MAX_CONDITIONS)
    throw new BindRefused(`At most ${MAX_CONDITIONS} conditions.`);
  const out: [string, Op, unknown?][] = [];
  for (const c of sent) {
    const [column, op, value] = Array.isArray(c) ? c : [];
    if (typeof column !== "string" || !q.select.includes(column))
      throw new BindRefused(`${queryId} doesn't list ${String(column)}.`);
    if (!(CONDITION_OPS as readonly unknown[]).includes(op))
      throw new BindRefused(`"${String(op)}" isn't a condition here.`);
    if (column === skip) continue;
    if (op === "in") {
      if (!Array.isArray(value) || !value.length || value.length > MAX_VALUES)
        throw new BindRefused(`"in" takes 1 to ${MAX_VALUES} values.`);
      for (const v of value) {
        if (!(typeof v === "string" && v.length <= 200) && !(typeof v === "number" && Number.isFinite(v)))
          throw new BindRefused("A value is text or a number.");
      }
      out.push([column, "in", value]);
    } else if (op === "contains") {
      if (typeof value !== "string" || !value.trim() || value.length > 120)
        throw new BindRefused("Search for some text.");
      out.push([column, "contains", value.trim()]);
    } else if (op === "is null") {
      out.push([column, "is null"]);
    } else {
      const ok =
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(value));
      if (!ok) throw new BindRefused(`"${op}" takes a number or a date.`);
      out.push([column, op as Op, value]);
    }
  }
  return out;
}

/**
 * A query's conditions under the filter values (checked by `filterValues`): its own `where`, each filter it takes on
 * its column (one may be left out: a lookup of that filter's values), and the period's days; with the period's value.
 */
function filtered(
  d: Definition,
  q: NamedQuery,
  values: Record<string, string | string[]>,
  ctx: BindContext,
  skip?: string,
  scope?: [string, Op, unknown] | null,
): {
  where: [string, Op, unknown?][];
  period: { column: string; value: string } | null;
  /** The conditions without the period's days: the period before goes in their place. */
  rest: [string, Op, unknown?][];
} {
  // The record shown comes with the query's own conditions: whatever is bound from here on (the period before, totals,
  // facets, value lists, drills) is the record's.
  const where = [...(specOf(q).where ?? []), ...(scope ? [scope] : [])];
  let period: { column: string; value: string } | null = null;
  for (const [fid, column] of Object.entries(q.filters)) {
    const f = d.filters[fid];
    const value = values[fid];
    if (!f || value === undefined || fid === skip) continue;
    if (f.kind === "period") {
      period = { column, value: value as string };
      continue;
    }
    if ((value as string[]).length) where.push([column, "in", value]);
  }
  const rest = [...where];
  if (period) {
    const range = periodRange(period.value, ctx.now, ctx.tz);
    if (!range) throw new BindRefused("That isn't a period.");
    where.push(...condition(period.column, range));
  }
  return { where, period, rest };
}

/** The days a query's period filter chose, and the days it's compared with: what a chart lines its buckets up by. */
export interface Periods {
  now: Range;
  before?: Range;
}

/**
 * A query's request under the filter values (already checked by `filterValues`), and for one that compares, the same
 * over the period before (or the same days a year before).
 */
export function bindQuery(
  d: Definition,
  queryId: string,
  ask: QueryAsk,
  ctx: BindContext,
): { spec: QuerySpec; previous?: QuerySpec; periods?: Periods } {
  const q = Object.hasOwn(d.queries, queryId) ? d.queries[queryId] : undefined;
  if (!q) throw new BindRefused(`There's no query ${queryId}.`);
  const values = filterValues(d, ask.filters);
  const base: QuerySpec = specOf(q);
  if (q.select) {
    const page = ask.page ?? 0;
    // All its rows at once (a timeline, a box plot): its page is as many as a page holds, unless it says.
    const first = q.page ?? (q.rows?.all === true ? PAGE_CAP : 50);
    const sizes = [first, ...(q.rows?.pageSizes ?? [])];
    if (ask.pageSize !== undefined && !sizes.includes(ask.pageSize))
      throw new BindRefused(`${queryId} doesn't page by ${ask.pageSize}.`);
    const size = Math.min(ask.pageSize ?? first, PAGE_CAP);
    if (!Number.isInteger(page) || page < 0 || page * size > MAX_OFFSET)
      throw new BindRefused("That page is out of reach.");
    base.page = { size, offset: page * size };
    if (ask.sort !== undefined) {
      if (!q.select.includes(ask.sort.replace(/^-/, "")))
        throw new BindRefused(`${queryId} can't sort by ${ask.sort}.`);
      base.sort = [ask.sort];
    }
    if (ask.search !== undefined) {
      if (!q.search) throw new BindRefused(`${queryId} isn't searched.`);
      if (typeof ask.search !== "string" || ask.search.length > 100) throw new BindRefused("Search for some text.");
      // Its own columns: a search never looks where this query doesn't list.
      if (ask.search.trim()) Object.assign(base, { search: ask.search.trim(), searchIn: [...q.select] });
    }
  } else if (ask.search !== undefined) {
    throw new BindRefused(`${queryId} isn't searched.`);
  } else if (ask.page !== undefined || ask.sort !== undefined || ask.pageSize !== undefined) {
    throw new BindRefused(`${queryId} has no pages.`);
  } else if (ask.where?.length) {
    throw new BindRefused(`${queryId} takes no conditions.`);
  }
  const { where, period, rest } = filtered(d, q, values, ctx, undefined, recordScope(d, queryId, ask.record));
  const spec = { ...base, where: [...where, ...conditions(d, queryId, q, ask.where)] };
  if (!period) return { spec };
  const now = periodRange(period.value, ctx.now, ctx.tz) as Range;
  if (!q.compare) return { spec, periods: { now } };
  const before =
    q.compare === "previous_year"
      ? (yearBeforeRange(period.value, ctx.now, ctx.tz) as Range)
      : (previousRange(period.value, ctx.now, ctx.tz) as Range);
  // The period before: the same conditions, its days in place of the period's.
  return {
    spec,
    previous: { ...base, where: [...rest, ...condition(period.column, before)] },
    periods: { now, before },
  };
}

/** The values a select filter offers from the warehouse: the commonest 50, searched, under the other filters. */
export function bindLookup(
  d: Definition,
  filterId: string,
  ask: { filters?: Record<string, string | string[]>; search?: string; record?: string | number },
  ctx: BindContext,
): QuerySpec {
  const f = Object.hasOwn(d.filters, filterId) ? d.filters[filterId] : undefined;
  if (f?.kind !== "select" || !f.values) throw new BindRefused(`${filterId} lists no values from the warehouse.`);
  const q = d.queries[f.values.from];
  const column = q?.filters[filterId];
  if (!q || !column) throw new BindRefused(`${filterId} has no values to list.`);
  const { where } = filtered(
    d,
    q,
    filterValues(d, ask.filters),
    ctx,
    filterId,
    recordScope(d, f.values.from, ask.record),
  );
  return valueCounts(q.source.dataset, column, where, ask.search);
}

/** A column's values with their counts, under the query's filters and its other conditions (never its own). */
export function bindFacet(
  d: Definition,
  queryId: string,
  column: string,
  ask: QueryAsk & { search?: string },
  ctx: BindContext,
): QuerySpec {
  const q = Object.hasOwn(d.queries, queryId) ? d.queries[queryId] : undefined;
  if (!q?.select || !takesConditions(d, queryId)) throw new BindRefused(`${queryId} has no filters.`);
  if (!q.select.includes(column)) throw new BindRefused(`${queryId} doesn't list ${column}.`);
  const { where } = filtered(d, q, filterValues(d, ask.filters), ctx, undefined, recordScope(d, queryId, ask.record));
  return valueCounts(q.source.dataset, column, [...where, ...conditions(d, queryId, q, ask.where, column)], ask.search);
}

/** A query's totals row: each column totalled as its rows declare, over every row its filters and conditions select. */
export function bindTotals(d: Definition, queryId: string, ask: QueryAsk, ctx: BindContext): QuerySpec {
  const q = Object.hasOwn(d.queries, queryId) ? d.queries[queryId] : undefined;
  const totals = q?.rows?.totals;
  if (!q?.select || !totals) throw new BindRefused(`${queryId} has no totals.`);
  const { where } = filtered(d, q, filterValues(d, ask.filters), ctx, undefined, recordScope(d, queryId, ask.record));
  const measures: QuerySpec["measures"] = {};
  for (const [col, how] of Object.entries(totals)) {
    if (!q.select.includes(col)) throw new BindRefused(`${queryId} doesn't list ${col}.`);
    measures[col] = how === "count" ? ["count"] : [how, col];
  }
  return { from: q.source.dataset, measures, where: [...where, ...conditions(d, queryId, q, ask.where)] };
}

/** A column's values and how many rows have each, the commonest first, searched for some text. */
function valueCounts(from: string, column: string, where: [string, Op, unknown?][], search?: string): QuerySpec {
  if (search !== undefined && (typeof search !== "string" || search.length > 120))
    throw new BindRefused("Search for some text.");
  const n = countAlias(column);
  return {
    from,
    measures: { [n]: ["count"] },
    by: [column],
    where: [...where, ...(search?.trim() ? [[column, "contains", search.trim()] as [string, Op, unknown]] : [])],
    sort: [`-${n}`],
    limit: MAX_VALUES,
  };
}

/**
 * The rows behind one of a query's numbers: its drill query (a rows query of the same dataset the definition declares)
 * under the number's filters and its own conditions, narrowed to the clicked row's group (the values of the query's own
 * `by` columns; a month's whole month). A measure's own expression isn't applied: these are the rows its filters and group select.
 */
export function bindDrill(
  d: Definition,
  queryId: string,
  ask: {
    filters?: Record<string, string | string[]>;
    group?: Record<string, string | number | null>;
    page?: number;
    record?: string | number;
  },
  ctx: BindContext,
): QuerySpec {
  const q = Object.hasOwn(d.queries, queryId) ? d.queries[queryId] : undefined;
  const declared = q?.drill && Object.hasOwn(d.queries, q.drill) ? d.queries[q.drill] : undefined;
  if (!q?.measures) throw new BindRefused(`${queryId}'s numbers don't open rows.`);
  // Every number opens its rows: the drill it declares, or the columns the dashboard already shows of its dataset.
  const auto = declared ? [] : drillColumnsOf(d, queryId, ctx.datasets?.[q.source.dataset]);
  if (!declared && !auto.length) {
    throw new BindRefused(`${queryId}'s rows have no columns this dashboard shows: there's nothing to list.`);
  }
  const rows: NamedQuery = declared ?? { source: q.source, select: auto, filters: {} };
  if (!rows.select) throw new BindRefused(`${queryId}'s numbers don't open rows.`);
  const { spec } = bindQuery(
    d,
    queryId,
    { filters: ask.filters ?? {}, ...(ask.record !== undefined ? { record: ask.record } : {}) },
    ctx,
  );
  // The rows opened are the record's: the number's own scope carries (the same dataset); a target drawn for a record
  // narrows too (its record is the number's, the definition's check says), never by another query's key.
  const target = declared && rows.record ? recordScope(d, q.drill as string, ask.record) : null;
  const where = [...(spec.where ?? []), ...(target ? [target] : [])];
  const group = ask.group ?? {};
  const keys = new Map(
    (q.by ?? []).map((b) => {
      const [col, grain] = b.split(":") as [string, string | undefined];
      return [grain ? `${col}_${grain}` : col, { col, grain }] as const;
    }),
  );
  for (const name of Object.keys(group))
    if (!keys.has(name)) throw new BindRefused(`${queryId} isn't grouped by ${name}.`);
  for (const [name, { col, grain }] of keys) {
    if (!(name in group)) throw new BindRefused(`Say which ${name} the number is for.`);
    const value = group[name];
    if (value === null || value === undefined) {
      where.push([col, "is null"]);
    } else if (grain) {
      const start = new Date(
        typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
      );
      if (Number.isNaN(start.getTime())) throw new BindRefused(`${name} takes a date.`);
      where.push([col, ">=", start.toISOString()], [col, "<", nextGrain(start, grain).toISOString()]);
    } else {
      where.push([col, "=", value]);
    }
  }
  const page = ask.page ?? 0;
  if (!Number.isInteger(page) || page < 0 || page * 50 > MAX_OFFSET)
    throw new BindRefused("That page is out of reach.");
  // The rows query's own conditions hold too: a drill lists no row its list would leave out.
  for (const w of rows.where ?? []) where.push([...w] as [string, Op, unknown?]);
  // A metric's segments narrow its rows too: the rows behind it are the ones it counts.
  const segments = metricSegmentsOf(q, ctx.datasets?.[q.source.dataset]);
  return {
    from: q.source.dataset,
    select: [...rows.select],
    where,
    ...(segments.length ? { segments } : {}),
    ...(rows.sort ? { sort: [...rows.sort] } : {}),
    page: { size: 50, offset: page * 50 },
  };
}

/** The start of the next day, week, month, quarter or year after a group's start (as the warehouse truncates, UTC). */
function nextGrain(start: Date, grain: string): Date {
  const t = new Date(start);
  if (grain === "day") t.setUTCDate(t.getUTCDate() + 1);
  else if (grain === "week") t.setUTCDate(t.getUTCDate() + 7);
  else if (grain === "month") t.setUTCMonth(t.getUTCMonth() + 1);
  else if (grain === "quarter") t.setUTCMonth(t.getUTCMonth() + 3);
  else t.setUTCFullYear(t.getUTCFullYear() + 1);
  return t;
}

/** A named query as the compiler's request, before filters and paging. */
function specOf(q: NamedQuery): QuerySpec {
  return {
    from: q.source.dataset,
    ...(q.select ? { select: [...q.select] } : {}),
    ...(q.measures ? { measures: q.measures as QuerySpec["measures"] } : {}),
    ...(q.by ? { by: [...q.by] } : {}),
    ...(q.where ? { where: q.where.map((w) => [...w] as [string, Op, unknown?]) } : {}),
    ...(q.sort ? { sort: [...q.sort] } : {}),
    ...(q.limit ? { limit: q.limit } : {}),
  };
}

/**
 * What a dashboard may read from one source: per dataset, every column its queries name (and no other); a dataset of
 * its own, every column its SQL returns (each checked when it was saved).
 */
export function grantsOf(d: Definition, connection: string): Grants {
  const datasets: Grants["datasets"] = {};
  for (const [name, own] of Object.entries(d.datasets ?? {})) {
    if (own.connection === connection) datasets[name] = { columns: own.columns.map((c) => c.name) };
  }
  for (const q of Object.values(d.queries)) {
    if (q.source.connection !== connection) continue;
    const columns = new Set(datasets[q.source.dataset]?.columns ?? []);
    for (const c of q.select ?? []) columns.add(c);
    for (const b of q.by ?? []) columns.add(b.split(":")[0] as string);
    for (const m of Object.values(q.measures ?? {}))
      if (m[0] !== "measure" && m[0] !== "metric" && m[1]) columns.add(m[1]);
    for (const w of q.where ?? []) columns.add(w[0]);
    for (const c of Object.values(q.filters)) columns.add(c);
    for (const s of q.sort ?? []) if (q.select) columns.add(s.replace(/^-/, ""));
    if (q.record) columns.add(q.record);
    const search = Boolean(datasets[q.source.dataset]?.search || q.search);
    datasets[q.source.dataset] = { columns: [...columns], ...(search ? { search: true } : {}) };
  }
  return { datasets };
}

export { outputsOf };

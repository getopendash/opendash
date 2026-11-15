/**
 * The semantic compiler v0: a `metric_query` and a source's semantic model become one read-only
 * SELECT in the source's dialect, with its parameters and the role of each output column.
 *
 * Shape: one CTE per dataset used (its SQL, verbatim); `__rows`, the base dataset with the fields it needs from
 * datasets it reaches through n:1 or 1:1 relationships (left joins, so no row is lost or repeated); `__agg`, grouped
 * by the time period and the dimensions, with segments, filters and the range applied; and, for a comparison, the
 * previous period's value next to each row. Joining only n:1 makes fan-out impossible by construction; a field
 * reachable only across a 1:n edge is an explicit error, never a silent wrong number.
 *
 * Not in v0: metrics on different base datasets in one query, ratio and cumulative metrics, top-N with "other",
 * segments of joined datasets, the org's timezone (times are UTC).
 */
import { type ParamKind, type QueryParam, type SqlBuilder, TIME_GRAINS, type TimeGrain } from "@opendash/connectors";
import { z } from "zod";
import { metricFinestGrain, metricTimeColumn, type SemanticModel } from "./model";
import {
  type ColumnSpec,
  type DatasetSpec,
  type DrillSpec,
  type FilterSpec,
  MetricQuery,
  type MetricQueryInput,
} from "./spec";
import { type Range, rangeGrain, resolveRange, shift, startOf } from "./time";

/** A query the definitions can't express, said plainly so the model (or a person) can change it. */
export class SemanticError extends Error {
  override name = "SemanticError";
}

export interface CompiledColumn {
  name: string;
  role: "time" | "dimension" | "measure";
  /** For a measure: its metric. For a dimension: the field it groups by (`plans.name`). */
  source: string;
  /** A measure's value for the previous period (compare: previous_period). */
  previous?: boolean;
}

export interface CompiledQuery {
  sql: string;
  params: QueryParam[];
  columns: CompiledColumn[];
  /** The base dataset first, then the ones it joins. */
  datasets: string[];
  /** The range the results cover (without the extra period a comparison reads). */
  range: Range | null;
  grain: TimeGrain | null;
}

interface Edge {
  from: string;
  to: string;
  type: "n:1" | "1:1" | "1:n";
  /** from column → to column */
  on: [string, string][];
}

const INVERSE = { "n:1": "1:n", "1:n": "n:1", "1:1": "1:1" } as const;

function edges(model: SemanticModel): Map<string, Edge[]> {
  const out = new Map<string, Edge[]>();
  const add = (e: Edge) => out.set(e.from, [...(out.get(e.from) ?? []), e]);
  for (const d of model.datasets.values()) {
    for (const r of d.relationships) {
      const on = Object.entries(r.on);
      add({ from: d.ref, to: r.to, type: r.type, on });
      add({ from: r.to, to: d.ref, type: INVERSE[r.type], on: on.map(([a, b]) => [b, a]) });
    }
  }
  // Deterministic: the same model always picks the same path.
  for (const list of out.values()) list.sort((a, b) => a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
  return out;
}

/** Shortest paths from `base` along the edges `allowed` lets through: each reached dataset with its incoming edge. */
function paths(graph: Map<string, Edge[]>, base: string, allowed: (e: Edge) => boolean): Map<string, Edge | null> {
  const parent = new Map<string, Edge | null>([[base, null]]);
  const queue = [base];
  while (queue.length) {
    const at = queue.shift() as string;
    for (const e of graph.get(at) ?? []) {
      if (!allowed(e) || parent.has(e.to)) continue;
      parent.set(e.to, e);
      queue.push(e.to);
    }
  }
  return parent;
}

const pathTo = (parent: Map<string, Edge | null>, ref: string): Edge[] => {
  const out: Edge[] = [];
  for (let e = parent.get(ref); e; e = parent.get(e.from)) out.unshift(e);
  return out;
};

const KIND: Record<ColumnSpec["type"], [ParamKind, ParamKind]> = {
  string: ["string", "strings"],
  number: ["number", "numbers"],
  boolean: ["boolean", "boolean"],
  time: ["time", "time"],
};

/** Compiles a metric query against a model, for one dialect. Throws SemanticError when it can't be expressed. */
export function compileMetricQuery(
  model: SemanticModel,
  input: MetricQueryInput,
  options: { now: Date; sql: SqlBuilder },
): CompiledQuery {
  const { records: _records, ...compiled } = compile(model, input, options);
  return compiled;
}

/** What `compile` plans for the records behind a number; see compileRecordsQuery. */
interface RecordsRequest {
  /** Lower-case column names whose values are never returned (personal or secret data). */
  hide: ReadonlySet<string>;
  limit: number;
  offset: number;
}

function compile(
  model: SemanticModel,
  input: MetricQueryInput,
  options: { now: Date; sql: SqlBuilder },
  recordsRequest?: RecordsRequest,
): CompiledQuery & { records?: CompiledRecords } {
  const parsed = MetricQuery.safeParse(input);
  if (!parsed.success) throw new SemanticError(z.prettifyError(parsed.error));
  const q = parsed.data;
  const b = options.sql;
  const id = b.ident;

  // 1. Metrics, and the one dataset they share.
  const metrics = q.metrics.map((name) => {
    const m = model.metrics.get(name);
    if (!m) {
      throw new SemanticError(`There's no metric ${name}. Metrics: ${[...model.metrics.keys()].sort().join(", ")}.`);
    }
    return m;
  });
  const first = metrics[0] as (typeof metrics)[number];
  const other = metrics.find((m) => m.dataset !== first.dataset);
  if (other) {
    throw new SemanticError(
      `${first.name} is on ${first.dataset} and ${other.name} on ${other.dataset}: ask for them in separate queries.`,
    );
  }
  const base = model.datasets.get(first.dataset) as DatasetSpec;
  const ownSegments = (m: (typeof metrics)[number]) => [...m.segments].sort().join(",");
  if (metrics.some((m) => ownSegments(m) !== ownSegments(first))) {
    throw new SemanticError(
      `${metrics.map((m) => m.name).join(" and ")} count different rows (their segments differ): ask for them in separate queries.`,
    );
  }

  // 2. Time: the column, the grain and the range.
  const timeColumns = new Set(metrics.map((m) => metricTimeColumn(m, base)));
  if (timeColumns.size > 1) {
    throw new SemanticError(`${metrics.map((m) => m.name).join(" and ")} use different time columns: ask separately.`);
  }
  const timeColumn = [...timeColumns][0] ?? null;
  const t = q.time ?? {};
  if (!timeColumn && (t.grain || t.range || t.compare)) {
    throw new SemanticError(
      `${first.name} is about the current state, so it takes no time range, grain or comparison. Ask without one.`,
    );
  }
  const grain: TimeGrain | null =
    t.grain ?? (t.compare ? (rangeGrain(t.range) ?? first.default_grain ?? "month") : null);
  const range = t.range ? resolveRange(t.range, options.now) : null;
  // A month-end snapshot read by week (or a range of days) would group or filter its rows by the wrong dates.
  const finest = metricFinestGrain(first, base);
  if (finest) {
    const finer = (g: TimeGrain | null) => g !== null && TIME_GRAINS.indexOf(g) < TIME_GRAINS.indexOf(finest);
    const unaligned =
      range && typeof t.range === "object" && startOf(range.from, finest).getTime() !== range.from.getTime();
    if (finer(grain) || finer(rangeGrain(t.range)) || unaligned) {
      throw new SemanticError(
        `${first.name} has one value per ${finest} (${base.ref} is dated to the ${finest}), so it can't be read by ${grain && finer(grain) ? grain : "a shorter range"}. Ask by ${TIME_GRAINS.slice(TIME_GRAINS.indexOf(finest)).join(", ")}.`,
      );
    }
  }

  // 3. Fields: on the base dataset, or on one it reaches n:1.
  const graph = edges(model);
  const reach = paths(graph, base.ref, (e) => e.type !== "1:n");
  const used = new Map<string, { dataset: DatasetSpec; column: ColumnSpec; alias: string }>();
  const field = (name: string, purpose: "dimension" | "filter") => {
    const known = used.get(name);
    if (known) return known;
    const dot = name.lastIndexOf(".");
    const ref = dot > 0 ? name.slice(0, dot) : base.ref;
    const columnName = dot > 0 ? name.slice(dot + 1) : name;
    const dataset = model.datasets.get(ref);
    if (!dataset) throw new SemanticError(`There's no dataset ${ref} (in ${name}).`);
    const column = dataset.columns.find((c) => c.name === columnName);
    if (!column) {
      const elsewhere = [...model.datasets.values()]
        .filter((d) => reach.has(d.ref) && d.columns.some((c) => c.name === columnName))
        .map((d) => `${d.ref}.${columnName}`);
      throw new SemanticError(
        `${ref} has no field ${columnName}.${elsewhere.length ? ` Did you mean ${elsewhere.join(" or ")}?` : ""}`,
      );
    }
    if (purpose === "dimension" && !column.dimension && column.type !== "time") {
      throw new SemanticError(`${ref}.${columnName} can't be grouped by: it isn't a dimension of ${ref}.`);
    }
    if (!reach.has(ref)) {
      const anyway = paths(graph, base.ref, () => true);
      const fanOut = anyway.has(ref) ? pathTo(anyway, ref).find((e) => e.type === "1:n") : undefined;
      throw new SemanticError(
        fanOut
          ? `${fanOut.to} is 1:n from ${fanOut.from}: grouping ${first.name} by ${name} would count rows of ${base.ref} more than once. Pre-aggregate it in a dataset, or write SQL.`
          : `${ref} isn't related to ${base.ref}, so ${first.name} can't be grouped or filtered by ${name}.`,
      );
    }
    const entry = { dataset, column, alias: ref === base.ref ? columnName : `${ref}__${columnName}` };
    used.set(name, entry);
    return entry;
  };
  const dims = q.dimensions.map((d) => ({ name: d, ...field(d, "dimension") }));
  const filters = q.filters.map((f) => ({ spec: f, ...field(f.field, "filter") }));
  // The records behind a number: which columns a record shows, in what order, and what a row stands for.
  const plan = recordsRequest
    ? planRecords({
        base,
        metric: first,
        timeColumn,
        measureExpr: base.measures.find((x) => x.name === first.measure)?.expr ?? "",
        hide: recordsRequest.hide,
        field,
      })
    : null;

  // 4. Joins: the union of the shortest paths to every dataset a field is on.
  const joined: Edge[] = [];
  for (const { dataset } of used.values()) {
    for (const e of pathTo(reach, dataset.ref)) if (!joined.includes(e)) joined.push(e);
  }
  const alias = (ref: string) => (ref === base.ref ? "__b" : `__j_${ref}`);

  // 5. Segments: the base dataset's defaults, the metric's own, and the query's.
  const segmentNames = new Set([
    ...base.segments.filter((s) => s.default && !q.exclude_segments.includes(s.name)).map((s) => s.name),
    ...first.segments,
    ...q.segments,
  ]);
  for (const s of [...q.segments, ...q.exclude_segments]) {
    if (!base.segments.some((x) => x.name === s)) {
      throw new SemanticError(
        `${base.ref} has no segment ${s}. Segments: ${base.segments.map((x) => x.name).join(", ") || "none"}.`,
      );
    }
  }
  for (const s of q.exclude_segments) {
    if (first.segments.includes(s)) throw new SemanticError(`${s} is part of ${first.name}'s definition.`);
  }
  const segments = base.segments.filter((s) => segmentNames.has(s.name));

  // 6. Parameters, in the order they appear.
  const params: QueryParam[] = [];
  const param = (name: string, value: QueryParam["value"], kind: ParamKind) => {
    params.push({ name, value });
    return b.param(params.length, name, kind);
  };

  // A table of snapshots reads each period's last one: the latest snapshot time in each period (over every row in
  // the range, before segments and filters, so one entity's absence never moves it), then only the rows taken then.
  const snapshot = base.snapshot;
  // Snapshots are compared by their period (the column's grain), never their instant.
  const snapAt = snapshot
    ? b.truncTime(id(snapshot.at), (base.columns.find((c) => c.name === snapshot.at)?.grain ?? "day") as TimeGrain)
    : null;
  if (snapshot && timeColumn && timeColumn !== snapshot.at) {
    throw new SemanticError(
      `${base.ref} is a snapshot by ${snapshot.at}: ${first.name} must be read by ${snapshot.at}, not ${timeColumn}.`,
    );
  }
  const timeExpr = timeColumn && grain ? b.truncTime(id(timeColumn), grain) : null;
  const readFrom = range && grain && t.compare ? shift(range.from, -1, grain) : range?.from;
  const rangeWhere: string[] = [];
  const addRange = () => {
    if (!range || !timeColumn) return;
    rangeWhere.push(`${id(timeColumn)} >= ${param("range_from", b.timeValue(readFrom as Date), "time")}`);
    rangeWhere.push(`${id(timeColumn)} < ${param("range_to", b.timeValue(range.to), "time")}`);
  };
  // Parameters are made in the order the SQL reads them (MySQL binds ? by position): a snapshot's window, with a
  // filter on its own time column (which picks the snapshots, so it's inside the window), comes before the rest.
  const where: string[] = segments.map((s) => `(${s.where})`);
  const onAt = (f: (typeof filters)[number]) => snapshot !== undefined && f.alias === snapshot.at;
  if (snapshot) addRange();
  const ordered = [...filters.entries()].sort(([, a], [, b]) => Number(onAt(b)) - Number(onAt(a)));
  for (const [i, f] of ordered) {
    (onAt(f) ? rangeWhere : where).push(filterSql(f.spec, id(f.alias), f.column, `f${i + 1}`));
  }
  if (!snapshot) addRange();
  function filterSql(f: FilterSpec, expr: string, column: ColumnSpec, name: string): string {
    const [one, many] = KIND[column.type];
    if (f.op === "is_null") return `${expr} is null`;
    if (f.op === "is_not_null") return `${expr} is not null`;
    if (f.value === undefined) throw new SemanticError(`The filter on ${f.field} needs a value.`);
    const list = f.op === "in" || f.op === "not_in";
    if (list !== Array.isArray(f.value)) {
      throw new SemanticError(
        `The filter on ${f.field}: ${list ? `${f.op} takes a list` : `${f.op} takes one value`}.`,
      );
    }
    if (list) {
      if (column.type === "time" || column.type === "boolean") {
        throw new SemanticError(`${f.field} can't be filtered with a list.`);
      }
      // No values: nothing is in an empty list (written out, since `in ()` isn't SQL everywhere).
      if (!(f.value as unknown[]).length) return f.op === "in" ? "(1 = 0)" : "(1 = 1)";
      const inList = b.inList(expr, param(name, f.value as (string | number)[], many));
      return f.op === "in" ? inList : `not (${inList})`;
    }
    const op = f.op === "!=" ? "<>" : f.op;
    let value = f.value as string | number | boolean;
    if (column.type === "time") {
      const t =
        typeof value === "string" ? new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value) : null;
      if (!t || Number.isNaN(t.getTime())) throw new SemanticError(`${f.field} takes a date or time, like 2026-09-01.`);
      value = b.timeValue(t);
    }
    return `${expr} ${op} ${param(name, value, one)}`;
  }

  // 7. Output columns.
  const columns: CompiledColumn[] = [];
  const names = new Set<string>();
  const output = (c: CompiledColumn) => {
    if (names.has(c.name)) throw new SemanticError(`Two outputs would be named ${c.name}; drop one of them.`);
    names.add(c.name);
    columns.push(c);
  };
  if (grain && timeExpr) output({ name: grain, role: "time", source: `${base.ref}.${timeColumn}` });
  const dimOut = dims.map((d) => {
    const name = d.dataset.ref === base.ref ? d.column.name : `${d.dataset.ref}_${d.column.name}`;
    output({ name, role: "dimension", source: `${d.dataset.ref}.${d.column.name}` });
    return { ...d, out: name };
  });
  const measures = metrics.map((m) => {
    const measure = base.measures.find((x) => x.name === m.measure);
    if (!measure) throw new SemanticError(`${base.ref} has no measure ${m.measure}.`);
    output({ name: m.name, role: "measure", source: m.name });
    return { metric: m.name, expr: measure.expr };
  });
  if (t.compare) {
    if (!grain) throw new SemanticError("A comparison needs a time grain.");
    for (const m of measures) {
      output({ name: `${m.metric}_previous`, role: "measure", source: m.metric, previous: true });
    }
  }

  // 8. SQL.
  const datasets = [base.ref, ...joined.map((e) => e.to)];
  const ctes = datasets.map((ref) => {
    const d = model.datasets.get(ref) as DatasetSpec;
    return `${id(ref)} as (\n${d.sql.trim().replace(/;\s*$/, "")}\n)`;
  });
  const rowColumns = [
    ...base.columns.map((c) => `__b.${id(c.name)} as ${id(c.name)}`),
    ...[...used.values()]
      .filter((u) => u.dataset.ref !== base.ref)
      .map((u) => `${alias(u.dataset.ref)}.${id(u.column.name)} as ${id(u.alias)}`),
  ];
  const joins = joined.map(
    (e) =>
      `left join ${id(e.to)} as ${alias(e.to)} on ${e.on
        .map(([ours, theirs]) => `${alias(e.to)}.${id(theirs)} = ${alias(e.from)}.${id(ours)}`)
        .join(" and ")}`,
  );
  // Inside, outputs have internal names (__p, __d0, __m0): ClickHouse aliases are global, so `… as month` would
  // shadow a dataset column called month in the same query. The final select gives them their public names.
  const P = "__p";
  const D = (i: number) => `__d${i}`;
  const M = (i: number) => `__m${i}`;
  const groupBy = [...(timeExpr ? [timeExpr] : []), ...dimOut.map((d) => id(d.alias))];
  const agg = [
    `select ${[
      ...(timeExpr ? [`${timeExpr} as ${P}`] : []),
      ...dimOut.map((d, i) => `${id(d.alias)} as ${D(i)}`),
      ...measures.map((m, i) => `${m.expr} as ${M(i)}`),
    ].join(", ")}`,
    snapshot ? "from __snap" : "from __rows",
    ...(() => {
      const all = snapshot ? [`${snapAt} = __latest`, ...where] : [...where, ...rangeWhere];
      return all.length ? [`where ${all.join("\n  and ")}`] : [];
    })(),
    ...(groupBy.length ? [`group by ${groupBy.join(", ")}`] : []),
  ].join("\n");
  const internals = [...(timeExpr ? [P] : []), ...dimOut.map((_, i) => D(i)), ...measures.map((_, i) => M(i))];
  const publicNames = [
    ...(timeExpr && grain ? [`${P} as ${id(grain)}`] : []),
    ...dimOut.map((d, i) => `${D(i)} as ${id(d.out)}`),
    ...measures.map((m, i) => `${M(i)} as ${id(m.metric)}`),
  ];

  const order = (q.order.length ? q.order : defaultOrder()).map((o) => {
    if (!names.has(o.by)) throw new SemanticError(`Can't order by ${o.by}: outputs are ${[...names].join(", ")}.`);
    return `${id(o.by)} ${o.dir}`;
  });
  function defaultOrder(): { by: string; dir: "asc" | "desc" }[] {
    if (grain) return [{ by: grain, dir: "asc" }, ...dimOut.map((d) => ({ by: d.out, dir: "asc" as const }))];
    return [
      { by: measures[0]?.metric as string, dir: "desc" },
      ...dimOut.map((d) => ({ by: d.out, dir: "asc" as const })),
    ];
  }

  let final: string;
  const baseWiths = [
    ...ctes,
    `__rows as (\nselect ${rowColumns.join(", ")}\nfrom ${id(base.ref)} as __b${joins.map((j) => `\n${j}`).join("")}\n)`,
    ...(snapshot
      ? [
          `__snap as (\nselect __rows.*, max(${snapAt}) over (${timeExpr ? `partition by ${timeExpr}` : ""}) as __latest\nfrom __rows${rangeWhere.length ? `\nwhere ${rangeWhere.join("\n  and ")}` : ""}\n)`,
        ]
      : []),
  ];
  // The records behind the number: the same rows the number is computed over, listed instead of grouped.
  if (recordsRequest && plan) {
    const from = snapshot ? "__snap" : "__rows";
    const preds = snapshot ? [`${snapAt} = __latest`, ...where] : [...where, ...rangeWhere];
    const filtered = `from ${from}${preds.length ? `\nwhere ${preds.join("\n  and ")}` : ""}`;
    const shown = plan.columns.map((c) => id(c.name)).join(", ");
    const orderBy = plan.order.map((o) => `${id(o.column)} ${o.dir}`).join(", ");
    const withClause = `with ${baseWiths.join(",\n")}`;
    const entity = plan.entity ? id(plan.entity) : null;
    const pageSql = entity
      ? `${withClause}\nselect ${shown}\nfrom (select ${shown}, row_number() over (partition by ${entity} order by ${orderBy}) as __rn\n${filtered}) as __d\nwhere __rn = 1\norder by ${orderBy}\nlimit ${recordsRequest.limit} offset ${recordsRequest.offset}`
      : `${withClause}\nselect ${shown}\n${filtered}\norder by ${orderBy}\nlimit ${recordsRequest.limit} offset ${recordsRequest.offset}`;
    const summarySql = `${withClause}\nselect ${entity ? `count(distinct ${entity})` : "count(*)"} as __records, ${plan.measureExpr} as __value\n${filtered}`;
    return {
      sql: pageSql,
      params,
      columns: plan.columns.map((c) => ({ name: c.name, role: "dimension" as const, source: c.field })),
      datasets,
      range,
      grain: null,
      records: {
        summary: { sql: summarySql, params },
        columns: plan.columns,
        hidden: plan.hidden,
        kind: plan.kind,
        valueColumn: plan.valueColumn,
        entity: plan.entity,
        noun: plan.noun,
        order: plan.order,
        metric: first.name,
        measureExpr: plan.measureExpr,
        snapshot: snapshot ? snapshot.at : null,
      },
    };
  }
  const withs = [...baseWiths, `__agg as (\n${agg}\n)`];
  if (t.compare && grain) {
    const partition = dimOut.map((_, i) => D(i));
    withs.push(
      `__cmp as (\nselect ${[
        ...internals,
        ...measures.map((_, i) => `${b.previous(M(i), partition, P)} as __mp${i}`),
        `${b.previous(P, partition, P)} as __pp`,
      ].join(", ")}\nfrom __agg\n)`,
    );
    // A missing period (no rows that month) mustn't make an older one look like the previous one.
    final = [
      `select ${[
        ...publicNames,
        ...measures.map(
          (m, i) => `case when __pp = ${b.shiftDate(P, -1, grain)} then __mp${i} end as ${id(`${m.metric}_previous`)}`,
        ),
      ].join(", ")}`,
      "from __cmp",
      ...(range ? [`where ${P} >= ${param("range_since", b.timeValue(range.from), "time")}`] : []),
    ].join("\n");
  } else {
    final = [`select ${publicNames.join(", ")}`, "from __agg"].join("\n");
  }
  const sql = `with ${withs.join(",\n")}\n${final}\norder by ${order.join(", ")}\nlimit ${q.limit}`;
  return { sql, params, columns, datasets, range, grain };
}

/**
 * The fields a metric can be grouped or filtered by: its dataset's columns, then those of the datasets it reaches
 * through n:1 or 1:1 relationships, as `dataset.field`. What the prompt lists for each metric.
 */
export function metricFields(
  model: SemanticModel,
  metricName: string,
): { name: string; column: ColumnSpec; dimension: boolean }[] {
  const metric = model.metrics.get(metricName);
  const base = metric ? model.datasets.get(metric.dataset) : undefined;
  if (!base) return [];
  const reach = paths(edges(model), base.ref, (e) => e.type !== "1:n");
  return [...reach.keys()].flatMap((ref) => {
    const d = model.datasets.get(ref) as DatasetSpec;
    return d.columns.map((c) => ({
      name: ref === base.ref ? c.name : `${ref}.${c.name}`,
      column: c,
      dimension: c.dimension || c.type === "time",
    }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The records behind a number

/** Records are listed a page at a time, within what the gateway keeps of a result (BUDGETS.gateway.previewRows). */
export const RECORDS_PAGE_MAX = 50;
/** The gateway reads at most this many rows of any query (BUDGETS.gateway.maxRows): a list never goes past it. */
export const RECORDS_ROW_CAP = 1_000;
/** A list shows at most this many columns. */
const RECORD_COLUMNS_DEFAULT = 10;

/** What a metric's number is made of, from its measure's expression. */
export type RecordsKind =
  /** `count(*)`: one record per row, so the list's total is the number. */
  | "count"
  /** `count(distinct x)`: one record per entity x, so the list's total is the number. */
  | "distinct"
  /** `sum(x)`: the records add up to the number, which the list says. */
  | "sum"
  /** Anything else (an average, a ratio): the rows the calculation reads, with the number computed over them. */
  | "other";

export interface RecordColumn {
  /** The column's name in the result. */
  name: string;
  /** The field it is, as the definitions name it: `status`, or `plans.name` of a joined dataset. */
  field: string;
  label: string;
  type: ColumnSpec["type"];
  format?: NonNullable<ColumnSpec["format"]>;
  description?: string;
}

export interface CompiledRecords {
  /** Its row count and the metric's own measure over the same rows (columns __records and __value). */
  summary: { sql: string; params: QueryParam[] };
  columns: RecordColumn[];
  /** The fields left out because they are personal or secret data. */
  hidden: string[];
  kind: RecordsKind;
  /** For a sum: the column it adds up. */
  valueColumn: string | null;
  /** For a count of entities: the column that says which entity a row is. */
  entity: string | null;
  /** What a record is called, plural. */
  noun: string;
  order: { column: string; dir: "asc" | "desc" }[];
  metric: string;
  measureExpr: string;
  /** For a snapshot dataset: the column that dates its snapshots. */
  snapshot: string | null;
}

export interface CompiledRecordsQuery extends CompiledQuery {
  records: CompiledRecords;
}

const COUNT_ROWS = /^\s*count\s*\(\s*(?:\*|1)\s*\)\s*$/i;
const COUNT_DISTINCT = /^\s*count\s*\(\s*distinct\s+"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)\s*$/i;
const SUM_OF =
  /^\s*(?:round\s*\(\s*)?sum\s*\(\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*\)\s*(?:,\s*\d+\s*\))?\s*(?:::\s*[A-Za-z0-9_]+)?\s*$/i;

/** What a measure's expression adds up to: rows, entities, a column, or a calculation. */
export function recordsKindOf(expr: string): { kind: RecordsKind; column: string | null } {
  if (COUNT_ROWS.test(expr)) return { kind: "count", column: null };
  const distinct = COUNT_DISTINCT.exec(expr);
  if (distinct) return { kind: "distinct", column: distinct[1] as string };
  const sum = SUM_OF.exec(expr);
  if (sum) return { kind: "sum", column: sum[1] as string };
  return { kind: "other", column: null };
}

/** "item_id" → "Item ID", "plans.name" → "Plans name", "billing_interval" → "Billing interval". */
const humanize = (name: string) => {
  const words = name
    .replaceAll("__", " ")
    .replaceAll("_", " ")
    .trim()
    .split(/\s+/)
    .map((w) => (w.toLowerCase() === "id" ? "ID" : w));
  const spaced = words.join(" ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
};

type FieldFn = (
  name: string,
  purpose: "dimension" | "filter",
) => { dataset: DatasetSpec; column: ColumnSpec; alias: string };

/** Chooses and registers the columns of a list of records, and the order of its rows. */
function planRecords(input: {
  base: DatasetSpec;
  metric: { drill?: DrillSpec | undefined; name: string };
  timeColumn: string | null;
  measureExpr: string;
  hide: ReadonlySet<string>;
  field: FieldFn;
}) {
  const { base, metric, timeColumn, hide, field } = input;
  const drill: DrillSpec = { ...(base.drill ?? {}), ...(metric.drill ?? {}) };
  const { kind, column: measureColumn } = recordsKindOf(input.measureExpr);
  const entityName = drill.entity ?? (kind === "distinct" ? measureColumn : null);

  const keyColumns = base.primary_key.filter((c) => c !== timeColumn);
  // A list that isn't told its columns leaves out the ones a default segment filters on (`is_test`: always "No").
  const filteredOn = new Set(
    base.columns
      .filter((c) => base.segments.some((s) => s.default && new RegExp(`\\b${c.name}\\b`).test(s.where)))
      .map((c) => c.name),
  );
  const requested = drill.columns ?? [
    ...new Set([
      ...keyColumns,
      ...(timeColumn ? [timeColumn] : []),
      ...base.columns.map((c) => c.name).filter((n) => !filteredOn.has(n)),
    ]),
  ];
  const hidden: string[] = [];
  const columns: RecordColumn[] = [];
  const seen = new Set<string>();
  const add = (name: string, forced: boolean) => {
    const known = columns.find((c) => c.field === name);
    if (known) return known;
    const dot = name.lastIndexOf(".");
    const columnName = dot > 0 ? name.slice(dot + 1) : name;
    if (hide.has(columnName.toLowerCase())) {
      if (!hidden.includes(name)) hidden.push(name);
      return null;
    }
    // A list that isn't told which columns shows the first few: a limit applies to what's chosen by default only.
    if (!forced && !drill.columns && columns.length >= RECORD_COLUMNS_DEFAULT) return null;
    const { dataset, column, alias } = field(name, "filter");
    if (seen.has(alias)) return null;
    seen.add(alias);
    const out: RecordColumn = {
      name: alias,
      field: name,
      label: humanize(dot > 0 ? `${dataset.ref} ${column.name}` : column.name),
      type: column.type,
      ...(column.format ? { format: column.format } : {}),
      ...(column.description ? { description: column.description } : {}),
    };
    columns.push(out);
    return out;
  };
  for (const name of requested) add(name, false);

  // A count of entities lists each entity once: the entity column must be shown, and not personal.
  let entity: string | null = null;
  if (entityName) {
    if (hide.has(entityName.toLowerCase())) {
      throw new SemanticError(
        `${metric.name} counts ${entityName}, which is personal data: its records can't be listed by it.`,
      );
    }
    const e = add(entityName, true);
    entity = e?.name ?? null;
  }
  if (columns.length === 0) {
    throw new SemanticError(
      hidden.length
        ? `Every column of these records is personal data (${hidden.join(", ")}): there's nothing to show.`
        : "These records have no columns to show.",
    );
  }

  const shown = new Set(columns.map((c) => c.name));
  const orderSpec = drill.order ?? [
    ...(timeColumn ? [{ by: timeColumn, dir: "desc" as const }] : []),
    ...keyColumns.map((by) => ({ by, dir: "asc" as const })),
  ];
  const order: { column: string; dir: "asc" | "desc" }[] = [];
  for (const o of orderSpec) {
    if (hide.has((o.by.includes(".") ? o.by.slice(o.by.lastIndexOf(".") + 1) : o.by).toLowerCase())) continue;
    const { alias } = field(o.by, "filter");
    // Ordering needs the column in the result (a deduplicated list orders after the window).
    if (!shown.has(alias)) {
      const col = add(o.by, true);
      if (!col) continue;
    }
    order.push({ column: alias, dir: o.dir });
  }
  if (order.length === 0) order.push({ column: (columns[0] as RecordColumn).name, dir: "asc" });
  // A stable page: the first column breaks any tie.
  if (!order.some((o) => o.column === (columns[0] as RecordColumn).name)) {
    order.push({ column: (columns[0] as RecordColumn).name, dir: "asc" });
  }

  return {
    columns,
    hidden,
    kind,
    valueColumn: kind === "sum" ? measureColumn : null,
    entity,
    noun: drill.noun ?? "records",
    order,
    measureExpr: input.measureExpr,
  };
}

/** Where a number was clicked: the period of its bucket, and the value of each dimension it was grouped by. */
export interface RecordsGroup {
  /** The first day of the clicked period (YYYY-MM-DD), for a number grouped by time. */
  time?: string;
  /** Each grouped dimension (as the query names it: `plan_id`, `plans.name`) and the value clicked; null for none. */
  values?: Record<string, string | number | boolean | null>;
}

/**
 * Compiles the records behind one number of a metric query: the query's own rows (its segments, filters, range and
 * the clicked group), listed a page at a time instead of aggregated. Joins stay n:1 only, so a row is never repeated;
 * a metric that counts entities lists each once. `hide` names the columns (lower case) whose values may never be
 * returned. Throws SemanticError when the query can't be expressed, or isn't about one metric.
 */
export function compileRecordsQuery(
  model: SemanticModel,
  input: {
    query: MetricQueryInput;
    group?: RecordsGroup;
    limit?: number;
    offset?: number;
    hide?: ReadonlySet<string>;
  },
  options: { now: Date; sql: SqlBuilder },
): CompiledRecordsQuery {
  const parsed = MetricQuery.safeParse(input.query);
  if (!parsed.success) throw new SemanticError(z.prettifyError(parsed.error));
  const q = parsed.data;
  if (q.metrics.length !== 1) {
    throw new SemanticError("Records are listed for one metric at a time.");
  }
  const metric = model.metrics.get(q.metrics[0] as string);
  const dataset = metric ? model.datasets.get(metric.dataset) : undefined;
  if (!metric || !dataset) throw new SemanticError(`There's no metric ${q.metrics[0]}.`);
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 25), 1), RECORDS_PAGE_MAX);
  const offset = Math.max(Math.trunc(input.offset ?? 0), 0);
  if (offset + limit > RECORDS_ROW_CAP) {
    throw new SemanticError(`Records are listed up to the first ${RECORDS_ROW_CAP.toLocaleString("en-US")}.`);
  }

  // The clicked group becomes filters, and its time bucket a range.
  const group = input.group ?? {};
  const filters: FilterSpec[] = [...q.filters];
  for (const [dimension, value] of Object.entries(group.values ?? {})) {
    if (!q.dimensions.includes(dimension)) {
      throw new SemanticError(`${dimension} isn't a dimension of this number, so it can't narrow its records.`);
    }
    filters.push(
      value === null
        ? { field: dimension, op: "is_null" }
        : { field: dimension, op: "=", value: value as string | number | boolean },
    );
  }
  let range = q.time?.range;
  if (group.time) {
    const grain =
      q.time?.grain ?? (q.time?.compare ? (rangeGrain(q.time?.range) ?? metric.default_grain ?? "month") : null);
    if (!grain) throw new SemanticError("This number isn't grouped by time, so a period can't narrow its records.");
    const from = new Date(/^\d{4}-\d{2}-\d{2}$/.test(group.time) ? `${group.time}T00:00:00Z` : group.time);
    if (Number.isNaN(from.getTime())) throw new SemanticError("The period is a date, like 2026-09-01.");
    const start = startOf(from, grain);
    const to = shift(start, 1, grain);
    range = { from: start.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
  }
  const query: MetricQueryInput = {
    metrics: [metric.name],
    dimensions: [],
    filters,
    segments: q.segments,
    exclude_segments: q.exclude_segments,
    ...(range ? { time: { range } } : {}),
    limit: 1,
  };
  const compiled = compile(model, query, options, { hide: input.hide ?? new Set(), limit, offset });
  if (!compiled.records) throw new SemanticError("The records couldn't be compiled.");
  return { ...compiled, records: compiled.records };
}

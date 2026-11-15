/**
 * An App's definition, `dashboard.json`: its named queries, its filters, its own datasets and
 * its summaries. Its page is its own code, which names these (a query by its id, a filter's value, a record's key) and
 * never describes a query of its own: the server runs only the queries a checked definition declares, bound to filter
 * values it checks too (bind.ts).
 *
 * Ids are stable (`q_`, `f_`, `s_`, `a_` and a short slug), so a rename or a reorder keeps every reference. One pure
 * check (`checkDefinition`) serves the server, the API and the analyst alike; each problem names where it is.
 */

import { z } from "zod";
import {
  AGGREGATES,
  type Catalog,
  type CatalogDataset,
  type ColumnKind,
  GRAINS,
  OPS,
  PAGE_CAP,
  type Provenance,
  ROW_CAP,
} from "../protocol";
import { actionArgumentsProblem } from "./actions";
import { isPeriodValue } from "./periods";
import { linkTemplateProblem, SERVICE_PATH } from "./service";

/** Column, dataset and measure names: lower-case plain identifiers, as the catalog has them. */
export const PLAIN = /^[a-z_][a-z0-9_]{0,62}$/;
const id = (prefix: "q" | "f" | "s" | "a") =>
  z.string().regex(new RegExp(`^${prefix}_[a-z0-9_]{1,40}$`), `an id like ${prefix}_revenue`);
const plain = z.string().regex(PLAIN, "a lower-case name like created_at");
const label = z.string().trim().min(1).max(80);

export const FORMATS = ["money", "money-compact", "number", "percent", "date", "text"] as const;
export type Format = (typeof FORMATS)[number];
/** A grid's cells: the formats, a number drawn as a bar against the page's largest, or a value as a tag. */
export const CELL_FORMATS = [...FORMATS, "bar", "badge", "person", "dots"] as const;
/** What a value means, for a pill: its tone (good, warn, bad, neutral), drawn with its words. */
export const TONES = ["good", "warn", "bad", "neutral"] as const;
/** How a grid's totals row totals a column. */
export const TOTALS = ["sum", "avg", "min", "max", "count"] as const;

export const LIMITS = { queries: 60, filters: 10, options: 100, datasets: 12 } as const;

export { CHART_TYPES, type ChartType, groupsOf, isAdditive, MAX_DAYS, MAX_PANELS, MAX_SERIES } from "./contracts";

const PeriodFilter = z.object({
  kind: z.literal("period"),
  label,
  /** A preset (this_month, last_12_months…) or a month, 2026-09. */
  default: z.string().refine((v) => isPeriod(v), "a period: this_month, last_12_months… or a month like 2026-09"),
});
const SelectFilter = z.object({
  kind: z.literal("select"),
  label,
  /** The values it offers, listed; or none when they come from the warehouse (`values`). */
  options: z.array(z.string().min(1).max(120)).max(LIMITS.options).default([]),
  /** Its values from the warehouse: the distinct values of the column it narrows in this query, searched. */
  values: z.object({ from: z.string().regex(/^q_[a-z0-9_]{1,40}$/, "an id like q_accounts") }).optional(),
  /** Several chosen at once (tokens), or one (absent: several). */
  multiple: z.boolean().optional(),
  /** A search box over its values (always, for values from the warehouse). */
  search: z.boolean().optional(),
  /** What's chosen at first; none chosen means every value. */
  default: z.array(z.string()).default([]),
});
export const Filter = z.discriminatedUnion("kind", [PeriodFilter, SelectFilter]);
export type Filter = z.infer<typeof Filter>;

const Measure = z.union([
  z.tuple([z.literal("measure"), plain]),
  z.tuple([z.literal("metric"), plain]),
  z.tuple([z.enum(AGGREGATES)]),
  z.tuple([z.enum(AGGREGATES), plain]),
]);

/**
 * Work on a list's records: an owner, a status of these, a note and a follow-up day for each, kept in
 * OpenDash and seen by everyone who reads it.
 */
const Work = z
  .object({
    statuses: z.array(z.string().trim().min(1).max(40)).min(2).max(8),
    tones: z.record(z.string().max(40), z.enum(TONES)).optional(),
  })
  .strict();

/**
 * Changes in a service from each row: a button that calls one tool with these arguments, the row's
 * key in the one that's exactly "{key}", made by the person pressing it with their own account once they confirm it.
 */
const RowActions = z
  .array(
    z
      .object({
        id: id("a"),
        label: z.string().trim().min(1).max(40),
        connection: z.uuid(),
        tool: z.string().min(1).max(128),
        arguments: z.record(z.string().max(64), z.unknown()),
        /** What the dialog asks ("Move {key} to Done?"); else it says the tool and its arguments. */
        confirm: z.string().trim().min(1).max(160).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(3);
export type RowAction = z.infer<typeof RowActions>[number];

/**
 * What an App's code may ask of a rows query: each of these was a grid section's; the
 * server checks every request against them, so code can't ask a query for more than it declares.
 */
const QueryRows = z
  .object({
    /** The rows a page may hold, the person's choice (the first is where it starts). */
    pageSizes: z.array(z.int().min(5).max(PAGE_CAP)).min(1).max(5).optional(),
    /** All its rows at once, up to a page's cap (a timeline, a box plot). */
    all: z.literal(true).optional(),
    /** Each listed column filtered by its kind (values with their counts, a range). */
    conditions: z.literal(true).optional(),
    /** A totals row over every row its filters and conditions select: a column and how it's totalled. */
    totals: z.record(plain, z.enum(TOTALS)).optional(),
  })
  .strict();

/**
 * A named query: one verified dataset of one source, read as rows (`select`, paged) or as an aggregate (`measures`,
 * grouped `by` columns, a date column at a grain as `created_at:month`). `filters` says which of the dashboard's
 * filters narrow it, and on which of its columns. Never SQL.
 */
export const NamedQuery = z
  .object({
    source: z.object({ connection: z.uuid(), dataset: plain }),
    select: z.array(plain).min(1).max(40).optional(),
    measures: z.record(plain, Measure).optional(),
    by: z
      .array(z.string().regex(/^[a-z_][a-z0-9_]{0,62}(:(day|week|month|quarter|year))?$/, "a column, or column:month"))
      .max(4)
      .optional(),
    /** Fixed conditions, always applied. */
    where: z
      .array(z.tuple([plain, z.enum(OPS)]).or(z.tuple([plain, z.enum(OPS), z.unknown()])))
      .max(20)
      .optional(),
    sort: z
      .array(z.string().regex(/^-?[a-z_][a-z0-9_]{0,62}$/, "a name, or -name for descending"))
      .max(4)
      .optional(),
    limit: z.int().min(1).max(ROW_CAP).optional(),
    /** Rows a page holds, for a rows query. */
    page: z.int().min(1).max(PAGE_CAP).optional(),
    filters: z.record(id("f"), plain).default({}),
    /** The same query over the period before, beside it: a KPI's change. */
    compare: z.enum(["previous_period", "previous_year"]).optional(),
    /** For a query of measures: the rows query (same source and dataset) a press on one of its numbers opens. */
    drill: id("q").optional(),
    /** Drawn for the record shown on a list or record page: this column equals its key. */
    record: plain.optional(),
    /** A rows query a list may search: the searchable columns it lists. */
    search: z.boolean().optional(),
    /** An App's: this column is a row's key, and the query may be asked for one record by it. */
    key: plain.optional(),
    /** An App's: what its code may ask of these rows (paging, all at once, conditions, totals). */
    rows: QueryRows.optional(),
    /** An App's: work on these rows' records, kept in OpenDash. */
    work: Work.optional(),
    /** An App's: changes in a service from each of these rows. */
    actions: RowActions.optional(),
  })
  .strict();
export type NamedQuery = z.infer<typeof NamedQuery>;

/** An own dataset's name: `t_` and lower-case, so it never reads as a released dataset of the same name. */
export const OWN_NAME = /^t_[a-z0-9_]{1,40}$/;

/**
 * An own dataset column's type: string, number, time or boolean, with the names a model writes for them taken as those
 * (a build once had "date" refused, and every file written again).
 */
const TYPE_NAMES: Record<string, "string" | "number" | "time" | "boolean"> = {
  text: "string",
  varchar: "string",
  str: "string",
  uuid: "string",
  enum: "string",
  int: "number",
  integer: "number",
  bigint: "number",
  float: "number",
  double: "number",
  decimal: "number",
  numeric: "number",
  date: "time",
  datetime: "time",
  timestamp: "time",
  timestamptz: "time",
  bool: "boolean",
};
/** A column's type from these kinds, a name a model writes for one (integer, text, timestamp) taken as it. */
const columnType = <K extends string>(kinds: readonly [K, ...K[]]) =>
  z.preprocess(
    (v) => {
      if (typeof v !== "string") return v;
      const t = v.trim().toLowerCase();
      return (kinds as readonly string[]).includes(t) ? t : (TYPE_NAMES[t] ?? t);
    },
    z.enum(kinds, { error: `A column's type is ${kinds.join(", ")}.` }),
  );
const ColumnType = columnType(["string", "number", "time", "boolean"]);

/**
 * The dashboard's own dataset: SQL the analyst wrote over the source's tables (any it has learned), when no released
 * dataset holds what's asked for. Its columns are what the SQL returns, typed by running it through the gateway when
 * it's saved (Ask's checks: read-only, learned tables only, personal columns never returned), and again whenever a
 * section reads it. Everything it draws says "Unverified · from a table".
 */
export const SqlDataset = z
  .object({
    connection: z.uuid(),
    title: label,
    sql: z.string().min(10).max(20_000),
    columns: z
      .array(z.object({ name: plain, type: ColumnType }))
      .min(1)
      .max(60),
    /** The column that tells its rows apart: a list or a record page needs one. */
    key: plain.optional(),
    /** How it joins another dataset (released, or another of the dashboard's own): its column → theirs. */
    links: z
      .array(z.object({ to: plain, on: z.record(plain, plain) }))
      .max(8)
      .optional(),
  })
  .strict();
export type SqlDataset = z.infer<typeof SqlDataset>;

/**
 * A dashboard's own dataset read from a service: one call of an MCP tool its owner's account can
 * use, shaped into typed columns (service.ts). `connection` is the MCP server's id; `digest` is the tool's as it was
 * when the call was checked: a different one stops it until it's checked again.
 */
export const ServiceDataset = z
  .object({
    connection: z.uuid(),
    title: label,
    service: z
      .object({
        tool: z.string().min(1).max(128),
        arguments: z.record(z.string().max(64), z.unknown()).default({}),
        digest: z.string().max(128).optional(),
      })
      .strict(),
    /** Where its records are in the answer: a dot path to a list, or none when the answer is the list. */
    rows: z.string().regex(SERVICE_PATH, "a path like issues or data.items: keys joined by dots").optional(),
    columns: z
      .array(
        z.object({
          name: plain,
          path: z
            .string()
            .regex(
              SERVICE_PATH,
              "a path like fields.status.name: keys joined by dots, as the answer names them (spaces are fine: fields.Owner Team.value), a number for a list's item (labels.0)",
            ),
          type: columnType(["string", "number", "time", "date", "boolean"]),
        }),
      )
      .min(1)
      .max(40),
    key: plain.optional(),
    /** A link for each row, from its columns: `https://acme.atlassian.net/browse/{key}`. */
    link: z
      .object({ column: plain, url: z.string().max(300) })
      .strict()
      .optional(),
  })
  .strict();
export type ServiceDataset = z.infer<typeof ServiceDataset>;

/** The dashboard's own dataset: its SQL over the source's tables, or a call of a service's tool. */
export const OwnDataset = z.union([SqlDataset, ServiceDataset]);
export type OwnDataset = z.infer<typeof OwnDataset>;
export const isServiceDataset = (ds: OwnDataset): ds is ServiceDataset => "service" in ds;

export const Definition = z
  .object({
    /** An App: its page is its own code, so the definition holds only its data. */
    version: z.literal(2),
    title: label,
    description: z.string().max(300).optional(),
    filters: z.record(id("f"), Filter).default({}),
    /** Its own datasets (`t_…`), when a released one doesn't hold what's asked for. */
    datasets: z.record(z.string().regex(OWN_NAME, "a name like t_revenue"), OwnDataset).optional(),
    queries: z.record(id("q"), NamedQuery),
    /** Its written summaries: each of these queries' answers, said in words. */
    summaries: z
      .record(
        id("s"),
        z
          .object({
            queries: z.array(id("q")).min(1).max(8),
            /** What to look for, in a line. */
            prompt: z.string().trim().max(200).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type Definition = z.infer<typeof Definition>;

export interface Problem {
  /** Where it is: `queries.q_mrr.measures.mrr`, `filters.f_plan.values.from`. */
  path: string;
  message: string;
}

export type Checked = { ok: true; definition: Definition } | { ok: false; problems: Problem[] };

/** What a definition is checked against beyond its own shape, when it's known. */
export interface CheckContext {
  /** Each source's verified datasets, by connection id: its queries' names are checked against them. */
  catalogs?: Record<string, Catalog>;
}

export function isPeriod(value: string): boolean {
  return isPeriodValue(value);
}

/** A query's output columns, in order: what a section may show. */
export function outputsOf(q: NamedQuery): string[] {
  if (q.select) return [...q.select];
  return [
    ...(q.by ?? []).map((b) => {
      const [col, grain] = b.split(":");
      return grain ? `${col}_${grain}` : (col as string);
    }),
    ...Object.keys(q.measures ?? {}),
  ];
}

const pathOf = (parts: PropertyKey[]) =>
  parts.reduce<string>(
    (out, p) => (typeof p === "number" ? `${out}[${p}]` : out ? `${out}.${String(p)}` : String(p)),
    "",
  );

type Issue = { path: PropertyKey[]; message: string; code?: string; errors?: Issue[][] };

/**
 * A union's refusal said as the branch it was meant to be ("Invalid input" says nothing): a dashboard's own dataset with
 * a `service` is read as a service's, otherwise as its own SQL; any other union, by the branch with fewest problems.
 */
function unwrapped(issue: Issue, input: unknown): Issue[] {
  if (issue.code !== "invalid_union" || !issue.errors?.length) return [issue];
  let value: unknown = input;
  for (const k of issue.path)
    value = value && typeof value === "object" ? (value as Record<PropertyKey, unknown>)[k] : undefined;
  const isService = Boolean(value && typeof value === "object" && "service" in value);
  const own = issue.path.length === 2 && issue.path[0] === "datasets" && issue.errors.length === 2;
  const branch = own
    ? (issue.errors[isService ? 1 : 0] as Issue[])
    : ([...issue.errors].sort((a, b) => a.length - b.length)[0] ?? []);
  return branch.length ? branch.flatMap((i) => unwrapped({ ...i, path: [...issue.path, ...i.path] }, input)) : [issue];
}

/** Checks a definition: its shape, every reference, and (when known) the datasets it names. */
export function checkDefinition(input: unknown, ctx: CheckContext = {}): Checked {
  const parsed = Definition.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues
        .flatMap((i) => unwrapped(i, input))
        .slice(0, 30)
        .map((i) => ({ path: pathOf(i.path), message: i.message })),
    };
  }
  const d = parsed.data;
  const problems: Problem[] = [];
  const at = (path: string, message: string): void => {
    problems.push({ path, message });
  };
  // The source's datasets with the dashboard's own beside them (own names first: they're the dashboard's).
  const catalogs = ctx.catalogs ? withOwnDatasets(ctx.catalogs, d.datasets) : undefined;

  const own = Object.entries(d.datasets ?? {});
  if (own.length > LIMITS.datasets) at("datasets", `At most ${LIMITS.datasets} datasets of its own.`);
  for (const [name, ds] of own) {
    const here = `datasets.${name}`;
    const names = ds.columns.map((c) => c.name);
    if (new Set(names).size !== names.length) at(`${here}.columns`, "Each column once.");
    if (ds.key && !names.includes(ds.key)) at(`${here}.key`, `${ds.key} isn't one of its columns.`);
    if (isServiceDataset(ds) && ds.link) {
      if (!names.includes(ds.link.column)) at(`${here}.link.column`, `${ds.link.column} isn't one of its columns.`);
      // Its only slot is its own column (a key, like an issue's): no other value of a row ever leaves in an address.
      const wrong = linkTemplateProblem(ds.link.url, [ds.link.column]);
      if (wrong) at(`${here}.link.url`, wrong);
    }
    ("links" in ds ? (ds.links ?? []) : []).forEach((l, li) => {
      for (const [mine, theirs] of Object.entries(l.on)) {
        if (!names.includes(mine)) at(`${here}.links[${li}].on`, `${mine} isn't one of ${name}'s columns.`);
        const target = catalogs?.[ds.connection]?.[l.to];
        if (catalogs && !target) at(`${here}.links[${li}].to`, `There's no dataset ${l.to} on that source.`);
        else if (target && !Object.hasOwn(target.columns, theirs)) {
          at(`${here}.links[${li}].on`, `${l.to} has no column ${theirs}.`);
        }
      }
    });
  }

  const queries = Object.entries(d.queries);
  if (!queries.length) at("queries", "A dashboard needs at least one query.");
  if (queries.length > LIMITS.queries) at("queries", `At most ${LIMITS.queries} queries.`);
  if (Object.keys(d.filters).length > LIMITS.filters) at("filters", `At most ${LIMITS.filters} filters.`);

  for (const [fid, f] of Object.entries(d.filters)) {
    if (f.kind === "select") {
      if (new Set(f.options).size !== f.options.length) at(`filters.${fid}.options`, "Each option once.");
      if (!f.options.length && !f.values) at(`filters.${fid}`, "List its options, or take its values from a query.");
      if (f.options.length && f.values) at(`filters.${fid}`, "Its values come from options or a query, not both.");
      if (f.multiple === false && f.default.length > 1) at(`filters.${fid}.default`, "It takes one value: choose one.");
      if (!f.values) {
        for (const v of f.default) {
          if (!f.options.includes(v)) at(`filters.${fid}.default`, `"${v}" isn't one of its options.`);
        }
      } else {
        if (f.default.length > 50 || f.default.some((v) => v.length > 200)) {
          at(`filters.${fid}.default`, "At most 50 values, each at most 200 characters.");
        }
        const from = Object.hasOwn(d.queries, f.values.from) ? d.queries[f.values.from] : undefined;
        if (!from) at(`filters.${fid}.values.from`, `There's no query ${f.values.from}.`);
        else if (!Object.hasOwn(from.filters, fid)) {
          at(
            `filters.${fid}.values.from`,
            `${f.values.from} isn't narrowed by ${fid}: its values come from the column it narrows.`,
          );
        } else if (from.record) {
          // Drawn for a record, it would run without a key.
          at(`filters.${fid}.values.from`, `${f.values.from} is drawn for a record: a filter's values aren't.`);
        }
      }
    }
  }

  // Its summaries: each reads queries it has.
  for (const [sid, sm] of Object.entries(d.summaries ?? {})) {
    for (const qid of sm.queries) {
      if (!Object.hasOwn(d.queries, qid)) at(`summaries.${sid}.queries`, `There's no query ${qid}.`);
    }
  }

  for (const [qid, q] of queries) {
    const here = `queries.${qid}`;
    if (!q.select === !q.measures) at(here, "A query reads rows (select) or computes measures, one of the two.");
    if (q.select && q.by) at(`${here}.by`, "Grouping goes with measures, not with select.");
    if (q.measures && q.page) at(`${here}.page`, "Pages are for rows (select).");
    if (q.measures && !Object.keys(q.measures).length) at(`${here}.measures`, "Name at least one measure.");
    const outputs = outputsOf(q);
    if (new Set(outputs).size !== outputs.length) at(here, "Two outputs have the same name.");
    for (const s of q.sort ?? []) {
      const name = s.replace(/^-/, "");
      if (q.measures && !outputs.includes(name)) at(`${here}.sort`, `"${name}" isn't one of its outputs.`);
    }
    let periods = 0;
    for (const fid of Object.keys(q.filters)) {
      const f = d.filters[fid];
      if (!f) at(`${here}.filters.${fid}`, `There's no filter ${fid}.`);
      else if (f.kind === "period") periods += 1;
    }
    if (periods > 1) at(`${here}.filters`, "At most one period narrows a query.");
    // What its code may ask of it: declared on the query, each named column one it lists.
    if (q.search && !q.select) at(`${here}.search`, "Only a rows query (select) is searched.");
    if (q.key && !q.select?.includes(q.key)) at(`${here}.key`, `A key is a column the query lists: ${q.key} isn't.`);
    if ((q.rows || q.work || q.actions) && !q.select) {
      at(here, "Paging, conditions, totals, work and actions are for a rows query (select).");
    }
    const described = catalogs?.[q.source.connection]?.[q.source.dataset];
    for (const [col, how] of Object.entries(q.rows?.totals ?? {})) {
      if (q.select && !q.select.includes(col)) at(`${here}.rows.totals.${col}`, `${col} isn't a column it lists.`);
      else if (how !== "count" && described?.columns[col] && described.columns[col].kind !== "number") {
        at(`${here}.rows.totals.${col}`, `${col} isn't a number: only count totals it.`);
      }
    }
    if ((q.work || q.actions) && !q.key && !q.record) {
      at(here, "Work and actions are on a row: say which column is its key (key).");
    }
    if (q.actions) {
      // An action names its row by the dataset's key.
      if (catalogs && described && !described.key) {
        at(`${here}.actions`, `${q.source.dataset} has no key: an action names its row by it.`);
      }
      if (new Set(q.actions.map((a) => a.id)).size !== q.actions.length)
        at(`${here}.actions`, "Each action's id once.");
      q.actions.forEach((a, i) => {
        const problem = actionArgumentsProblem(a.arguments);
        if (problem) at(`${here}.actions[${i}].arguments`, problem);
        if (a.confirm?.includes("{") && a.confirm.replace(/\{key\}/g, "").includes("{")) {
          at(`${here}.actions[${i}].confirm`, "Its question may say the row's key as {key}, nothing else in braces.");
        }
      });
    }
    if (q.work) {
      // Work is kept by record: the rows need their dataset's key.
      if (catalogs && described && !described.key) {
        at(
          `${here}.work`,
          `${q.source.dataset} has no key: a list people work through needs one, to keep each record's work.`,
        );
      }
      if (new Set(q.work.statuses).size !== q.work.statuses.length) at(`${here}.work.statuses`, "Each status once.");
      for (const t of Object.keys(q.work.tones ?? {})) {
        if (!q.work.statuses.includes(t)) at(`${here}.work.tones`, `${t} isn't one of its statuses.`);
      }
    }
    if (q.compare && periods !== 1) at(`${here}.compare`, "Comparing with the period before needs a period filter.");
    if (q.compare === "previous_year" && !q.measures) at(`${here}.compare`, "A comparison is of numbers: measures.");
    if (q.drill) {
      const rows = Object.hasOwn(d.queries, q.drill) ? d.queries[q.drill] : undefined;
      if (!q.measures) at(`${here}.drill`, "Only numbers open rows: drill goes on a query of measures.");
      else if (!rows) at(`${here}.drill`, `There's no query ${q.drill}.`);
      else if (!rows.select) at(`${here}.drill`, `${q.drill} computes measures: a drill opens a rows query.`);
      else if (rows.source.connection !== q.source.connection || rows.source.dataset !== q.source.dataset) {
        at(`${here}.drill`, `${q.drill} reads another dataset: a drill opens rows of the same one.`);
      } else if (rows.record && rows.record !== q.record) {
        at(
          `${here}.drill`,
          `${q.drill} and ${qid} aren't drawn for a record alike: the rows a number opens are its record's.`,
        );
      }
    }
    const catalog = catalogs?.[q.source.connection];
    if (catalogs && !catalog) at(`${here}.source.connection`, "That source isn't one this dashboard can read.");
    if (catalog) checkAgainst(catalog, here, q, d, at);
  }

  return problems.length ? { ok: false, problems } : { ok: true, definition: d };
}

const OWN_KINDS: Record<ServiceDataset["columns"][number]["type"], ColumnKind> = {
  string: "text",
  boolean: "text",
  number: "number",
  time: "date",
  date: "date",
};

/** An own dataset as the catalog describes a dataset: its columns and kinds, its key and links. */
export function ownCatalogDataset(ds: OwnDataset): CatalogDataset {
  return {
    title: ds.title,
    columns: Object.fromEntries(
      ds.columns.map((c) => [c.name, { kind: OWN_KINDS[c.type], ...(c.type === "string" ? { search: true } : {}) }]),
    ),
    ...(ds.key ? { key: ds.key } : {}),
    ...("links" in ds && ds.links?.length ? { links: ds.links.map((l) => ({ to: l.to, on: { ...l.on } })) } : {}),
    own: true,
    ...(isServiceDataset(ds) ? { service: true } : {}),
  };
}

/**
 * What each query reads, for its label: the dashboard's own SQL ("from a table"), a dataset read before an admin
 * released it ("unverified"), or a released one ("verified").
 */
export function provenanceOf(d: Definition, catalogs: Record<string, Catalog>): Record<string, Provenance> {
  const out: Record<string, Provenance> = {};
  for (const [qid, q] of Object.entries(d.queries)) {
    const own = d.datasets?.[q.source.dataset];
    const ds = catalogs[q.source.connection]?.[q.source.dataset];
    const metricUnverified = Object.values(q.measures ?? {}).some(
      (m) => m[0] === "metric" && (!ds?.metrics?.[m[1]] || ds.metrics[m[1]]?.unverified),
    );
    if (own && own.connection === q.source.connection) out[qid] = isServiceDataset(own) ? "service" : "table";
    // A definition the catalog doesn't have now is never called verified.
    else out[qid] = !ds || ds.unverified || metricUnverified ? "unverified" : "verified";
  }
  return out;
}

/** The sources' catalogs with the dashboard's own datasets added to theirs (an own name is the dashboard's). */
export function withOwnDatasets(
  catalogs: Record<string, Catalog>,
  datasets: Record<string, OwnDataset> | undefined,
): Record<string, Catalog> {
  const out: Record<string, Catalog> = { ...catalogs };
  for (const [name, ds] of Object.entries(datasets ?? {})) {
    out[ds.connection] = { ...(out[ds.connection] ?? {}), [name]: ownCatalogDataset(ds) };
  }
  return out;
}

/** A query's names against its source's datasets: the dataset, its columns, measures and filter columns. */
function checkAgainst(
  catalog: Catalog,
  here: string,
  q: NamedQuery,
  d: Definition,
  at: (path: string, message: string) => void,
) {
  const ds: CatalogDataset | undefined = Object.hasOwn(catalog, q.source.dataset)
    ? catalog[q.source.dataset]
    : undefined;
  if (!ds) {
    at(
      `${here}.source.dataset`,
      `There's no dataset "${q.source.dataset}" on that source: a released or checked one, or one of this dashboard's own (datasets: t_…, its SQL).`,
    );
    return;
  }
  const has = (c: string) => Object.hasOwn(ds.columns, c);
  const column = (c: string, path: string) => {
    if (!has(c)) at(`${here}.${path}`, `${q.source.dataset} has no column "${c}".`);
  };
  // A service's rows are counted and summed as they came: no metrics, no named measures, no period before (yet).
  if (ds.service) {
    for (const [name, m] of Object.entries(q.measures ?? {})) {
      if (m[0] === "metric" || m[0] === "measure") {
        at(`${here}.measures.${name}`, `${q.source.dataset} is read from a service: count or sum its columns instead.`);
      }
    }
    if (q.compare)
      at(`${here}.compare`, `${q.source.dataset} is read from a service: it shows no change against before.`);
  }
  q.select?.forEach((c, i) => {
    column(c, `select[${i}]`);
  });
  // Rows page in a total order: on the dataset's key when it has one (the compiler breaks ties on it), else on every
  // column the query lists. A list or a record page still needs a key (checked with the page).
  if (q.select && ds.key && !q.select.includes(ds.key)) at(`${here}.select`, `Add ${ds.key}, the rows' key.`);
  // A metric keeps its meaning, or isn't read here (checked again whenever it's read: a metric can change after).
  for (const p of metricProblems(q, ds, d.filters, q.source.dataset)) at(`${here}${p.path}`, p.message);
  for (const [alias, m] of Object.entries(q.measures ?? {})) {
    if (m[0] === "metric") continue;
    if (m[0] === "measure") {
      if (!ds.measures?.[m[1]]) at(`${here}.measures.${alias}`, `${q.source.dataset} has no measure "${m[1]}".`);
    } else if (m[0] !== "count") {
      if (m[1] === undefined) at(`${here}.measures.${alias}`, `${m[0]} needs a column: ["${m[0]}", "column"].`);
      else column(m[1], `measures.${alias}`);
    }
  }
  q.by?.forEach((b, i) => {
    const [col, grain] = b.split(":") as [string, string | undefined];
    column(col, `by[${i}]`);
    if (grain && has(col) && ds.columns[col]?.kind !== "date") at(`${here}.by[${i}]`, `${col} isn't a date.`);
    if (grain && !(GRAINS as readonly string[]).includes(grain)) at(`${here}.by[${i}]`, `There's no grain ${grain}.`);
  });
  q.where?.forEach((w, i) => {
    column(w[0], `where[${i}]`);
  });
  if (q.select) for (const s of q.sort ?? []) column(s.replace(/^-/, ""), "sort");
  for (const [fid, col] of Object.entries(q.filters)) {
    column(col, `filters.${fid}`);
    const f = d.filters[fid];
    if (f?.kind === "period" && has(col) && ds.columns[col]?.kind !== "date") {
      at(`${here}.filters.${fid}`, `A period narrows a date column, and ${col} isn't one.`);
    }
    // A list of a column's values is shown to everyone who reads the dashboard: never a personal column's.
    if (f?.kind === "select" && f.values && ds.columns[col]?.personal) {
      at(`${here}.filters.${fid}`, `${col} is personal: a filter can't list its values.`);
    }
  }
}

/**
 * Whether a query's metrics keep their meaning on this dataset as the catalog has it now: each one there, never a table
 * of snapshots added up across them, its own time column (a period, or a date grouping, on another column changes what
 * it counts; a number about now takes no period), and one set of segments for every measure in the query (a segment
 * narrows the rows of every measure beside it). Paths are relative to the query. Run when the definition is saved and
 * again whenever the query is read: a metric can change after.
 */
export function metricProblems(
  q: NamedQuery,
  ds: CatalogDataset,
  filters: Record<string, Filter>,
  dataset: string,
): Problem[] {
  const out: Problem[] = [];
  const entries = Object.entries(q.measures ?? {});
  const metrics = entries.filter(([, m]) => m[0] === "metric");
  if (!metrics.length) return out;
  const key = (segs: readonly string[] | undefined) => JSON.stringify([...(segs ?? [])].sort());
  let first: string | null = null;
  for (const [alias, m] of metrics) {
    const name = m[1] as string;
    const metric = ds.metrics?.[name];
    const path = `.measures.${alias}`;
    if (!metric) {
      const names = Object.keys(ds.metrics ?? {});
      out.push({
        path,
        message: `${dataset} has no metric "${name}"${names.length ? ` (its metrics: ${names.join(", ")})` : ""}.`,
      });
      continue;
    }
    if (ds.snapshot) {
      out.push({
        path,
        message: `${name} is a state taken each period (${dataset} is a table of snapshots): a dashboard can't add it up across them yet. Use its measure grouped by ${ds.snapshot.at} at its grain.`,
      });
    }
    const time = metric.timeColumn;
    for (const [fid, col] of Object.entries(q.filters)) {
      if (filters[fid]?.kind !== "period") continue;
      if (time === null)
        out.push({ path: `.filters.${fid}`, message: `${name} is a number about now: no period narrows it.` });
      else if (time && col !== time) {
        out.push({
          path: `.filters.${fid}`,
          message: `${name} counts by ${time}: its period narrows ${time}, not ${col}.`,
        });
      }
    }
    for (const b of q.by ?? []) {
      const [col, grain] = b.split(":") as [string, string | undefined];
      if (grain && time !== undefined && col !== time) {
        out.push({
          path: ".by",
          message: `${name} counts by ${time ?? "nothing over time"}: group it by ${time ?? "a value"}, not ${col}.`,
        });
      }
    }
    // Every metric in the query reads the same rows: one set of segments, the first one's (an empty set included).
    const mine = key(metric.segments);
    if (first === null) first = mine;
    else if (mine !== first)
      out.push({ path, message: "Two metrics with different segments read different rows: put them in two queries." });
  }
  const plain = entries.length - metrics.length;
  const segs = metrics.flatMap(([, m]) => ds.metrics?.[m[1] as string]?.segments ?? []);
  if (segs.length && plain) {
    out.push({
      path: ".measures",
      message: `A metric's segments (${[...new Set(segs)].join(", ")}) would change the rows the other measures count: put them in another query.`,
    });
  }
  return out;
}

/** The segments a query's metrics narrow its rows by (one set: metricProblems refuses two). */
export function metricSegmentsOf(q: NamedQuery, ds: CatalogDataset | undefined): string[] {
  const out = new Set<string>();
  for (const m of Object.values(q.measures ?? {})) {
    if (m[0] === "metric") for (const seg of ds?.metrics?.[m[1] as string]?.segments ?? []) out.add(seg);
  }
  return [...out];
}

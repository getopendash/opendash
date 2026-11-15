/**
 * Datasets and metrics, in the Apache Ossie shape with OpenDash's extensions, and the `metric_query`
 * spec the compiler takes. Authored as YAML (context_item_version.body) and parsed into these.
 *
 * A dataset is SQL on one source, in its own dialect. Measures and segments are SQL expressions over the dataset's
 * own columns; relationships say how it joins other datasets of the same source.
 */
import { PLAIN_NAME, TIME_GRAINS, type TimeGrain } from "@opendash/connectors";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const Name = z.string().regex(/^[a-z][a-z0-9_]*$/, "lower_snake_case: letters, digits and underscores");
const Text = z.string().trim().min(1);
const Expr = z.string().trim().min(1).max(2_000);

export const COLUMN_TYPES = ["string", "number", "boolean", "time"] as const;

export const ColumnSpec = z.object({
  name: z.string().regex(PLAIN_NAME, "a plain column name"),
  type: z.enum(COLUMN_TYPES),
  description: Text.optional(),
  /** Can be grouped by and filtered on. */
  dimension: z.boolean().default(false),
  synonyms: z.array(Text).default([]),
  /**
   * A time column's finest grain, when it has one: `month` when each row is dated to its month (a snapshot at each
   * month's end, like MRR's). Read by week or day, such a column gives wrong rows, so the compiler refuses it.
   * Absent, any grain.
   */
  grain: z.enum(TIME_GRAINS as [TimeGrain, ...TimeGrain[]]).optional(),
  /** How the column's values are shown in a list of records (a number column holding dollars: `usd`). */
  format: z.enum(["number", "usd", "percent"]).optional(),
});

export const MeasureSpec = z.object({
  name: Name,
  /** An aggregate over the dataset's columns, in the source's dialect: `round(sum(mrr_usd), 2)`. */
  expr: Expr,
  description: Text.optional(),
  format: z.enum(["number", "usd", "percent"]).default("number"),
});

export const SegmentSpec = z.object({
  name: Name,
  /** A condition over the dataset's columns: `not is_test`. */
  where: Expr,
  description: Text.optional(),
  /** Applies to every metric on this dataset unless a query says otherwise. */
  default: z.boolean().default(false),
});

/**
 * What a person sees when they open the records behind a number: which columns, in what order, and what one record is
 * called. Everything is optional: without it the list shows the dataset's key, its time column and its other columns
 * (up to ten), newest first. Columns are the metric's dataset's own, or `dataset.field` of one it joins n:1.
 */
export const DrillSpec = z.object({
  columns: z.array(z.string().regex(PLAIN_NAME)).min(1).max(12).optional(),
  order: z
    .array(z.object({ by: z.string().regex(PLAIN_NAME), dir: z.enum(["asc", "desc"]).default("desc") }))
    .max(3)
    .optional(),
  /** What the records are called, plural: `tickets`, `subscription items`. */
  noun: Text.max(60).optional(),
  /**
   * The column that says which entity a row belongs to, when a metric counts entities rather than rows (a number of
   * paying customers over rows of subscription items): the list shows each entity once. By default the column a
   * `count(distinct …)` measure counts.
   */
  entity: z.string().regex(PLAIN_NAME).optional(),
});

export const RelationshipSpec = z.object({
  to: Name,
  /** From this dataset's rows to the other's: n:1 (many of ours to one of theirs), 1:1, or 1:n. */
  type: z.enum(["n:1", "1:1", "1:n"]),
  /** Our column → their column. */
  on: z.record(z.string().regex(PLAIN_NAME), z.string().regex(PLAIN_NAME)).refine((o) => Object.keys(o).length > 0),
});

export const DatasetSpec = z.object({
  ref: Name,
  label: Text,
  description: Text.optional(),
  sql: z.string().trim().min(1).max(50_000),
  /** What one row is: "one row per subscription item active at the end of each month". */
  grain: Text,
  primary_key: z.array(z.string().regex(PLAIN_NAME)).min(1),
  time_column: z.string().regex(PLAIN_NAME).optional(),
  columns: z.array(ColumnSpec).min(1),
  measures: z.array(MeasureSpec).default([]),
  segments: z.array(SegmentSpec).default([]),
  relationships: z.array(RelationshipSpec).default([]),
  /**
   * A table of snapshots: each row is an entity's state at `at`, taken again each period (MRR at each
   * month's end, a usage count per day). A period longer than the snapshot's reads its last snapshot (a quarter is
   * its last month), never the sum of them; with no period, the latest snapshot. The entity is the primary key minus
   * `at`. Only for a state, never for events (orders, signups), which add up.
   */
  snapshot: z.object({ at: z.string().regex(PLAIN_NAME) }).optional(),
  usage_guidance: Text.optional(),
  /** The list of records behind this dataset's numbers (a metric's own `drill` overrides it). */
  drill: DrillSpec.optional(),
  ai_context: z
    .object({ instructions: Text.optional(), synonyms: z.array(Text).default([]), examples: z.array(Text).default([]) })
    .optional(),
});

export const MetricSpec = z.object({
  name: Name,
  label: Text,
  description: Text,
  dataset: Name,
  measure: Name,
  /** Segments of the dataset this metric always applies, on top of the dataset's defaults. */
  segments: z.array(Name).default([]),
  /**
   * Which time column ranges and grains use: the dataset's by default, another of its time columns (CSAT by when a
   * ticket was solved), or `none` for a metric about the current state (subscriptions active right now).
   */
  time_column: z.union([z.literal("none"), z.string().regex(PLAIN_NAME)]).optional(),
  default_grain: z.enum(TIME_GRAINS as [TimeGrain, ...TimeGrain[]]).optional(),
  format: z.enum(["number", "usd", "percent"]).optional(),
  direction: z.enum(["higher_is_better", "lower_is_better", "neutral"]).default("neutral"),
  synonyms: z.array(Text).default([]),
  /** The list of records behind this metric's numbers, over its dataset's default. */
  drill: DrillSpec.optional(),
});

export type DrillSpec = z.infer<typeof DrillSpec>;
export type ColumnSpec = z.infer<typeof ColumnSpec>;
export type MeasureSpec = z.infer<typeof MeasureSpec>;
export type SegmentSpec = z.infer<typeof SegmentSpec>;
export type RelationshipSpec = z.infer<typeof RelationshipSpec>;
export type DatasetSpec = z.infer<typeof DatasetSpec>;
export type MetricSpec = z.infer<typeof MetricSpec>;

/** Relative ranges (in UTC, ending before the current period unless they say "this" or "to date") or two dates. */
export const RANGE_TOKENS = [
  "today",
  "yesterday",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "this_quarter",
  "last_quarter",
  "this_year",
  "last_year",
  "month_to_date",
  "year_to_date",
] as const;
export const LAST_N = /^last_(\d{1,3})_(days|weeks|months|quarters|years)$/;

export const TimeRange = z.union([
  z.enum(RANGE_TOKENS),
  z.string().regex(LAST_N, "last_<n>_<days|weeks|months|quarters|years>"),
  z
    .object({
      from: z.iso.date(),
      /** Exclusive. */
      to: z.iso.date(),
    })
    .refine((r) => r.from < r.to, "from must be before to"),
]);

export const FILTER_OPS = ["=", "!=", "in", "not_in", ">", ">=", "<", "<=", "is_null", "is_not_null"] as const;

export const FilterSpec = z.object({
  /** A field of the metric's dataset, or `dataset.field` of one it joins n:1. */
  field: z.string().regex(PLAIN_NAME),
  op: z.enum(FILTER_OPS),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]).optional(),
});

export const MetricQuery = z.object({
  metrics: z.array(Name).min(1).max(5),
  dimensions: z.array(z.string().regex(PLAIN_NAME)).max(4).default([]),
  filters: z.array(FilterSpec).max(10).default([]),
  /** More segments of the base dataset to apply; `exclude: [name]` lifts a default one. */
  segments: z.array(Name).default([]),
  exclude_segments: z.array(Name).default([]),
  time: z
    .object({
      grain: z.enum(TIME_GRAINS as [TimeGrain, ...TimeGrain[]]).optional(),
      range: TimeRange.optional(),
      compare: z.literal("previous_period").optional(),
    })
    .optional(),
  order: z
    .array(z.object({ by: z.string().regex(PLAIN_NAME), dir: z.enum(["asc", "desc"]).default("desc") }))
    .max(4)
    .default([]),
  limit: z.number().int().min(1).max(1_000).default(200),
});

export type TimeRange = z.infer<typeof TimeRange>;
export type FilterSpec = z.infer<typeof FilterSpec>;
export type MetricQuery = z.infer<typeof MetricQuery>;
export type MetricQueryInput = z.input<typeof MetricQuery>;

/** A YAML body parsed and checked against its kind's spec, or the problems, each with where it is. */
export function parseSpec<T extends z.ZodType>(
  schema: T,
  body: string,
): { ok: true; spec: z.infer<T> } | { ok: false; problems: string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(body);
  } catch (error) {
    return { ok: false, problems: [`Not valid YAML: ${(error as Error).message.split("\n")[0]}`] };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, spec: parsed.data };
  return {
    ok: false,
    problems: parsed.error.issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`),
  };
}

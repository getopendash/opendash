/**
 * Charts in answers (inline blocks): the agent writes a small spec tied to one of its query
 * results, and the gate resolves it into points, each one a cell of that result, the way a reference is. So a chart
 * can only show numbers a query returned, every bar is traceable, and a spec that doesn't fit its data comes back as
 * a problem to fix rather than a misleading picture.
 */
import { z } from "zod";
import { type Format, formatNumber, formatTime, parseFormat } from "./format";
import type { CitableResult } from "./gate";

export const ChartSpec = z.object({
  type: z.enum(["bar", "line"]),
  title: z.string().trim().min(1).max(120),
  /** The query alias the chart reads (q1). */
  query: z.string().regex(/^q\d+$/),
  /** The categories (bar) or the time axis (line). */
  x: z.string().min(1),
  /** One series per column, or one column split into a series per value of `series_by`. */
  y: z.array(z.string().min(1)).min(1).max(4),
  /** Names for the y columns' series, in the same order (defaults to the column names). */
  labels: z.array(z.string().max(60)).max(4).optional(),
  series_by: z.string().optional(),
  /** How values show, as for references: currency:USD,compact. */
  format: z.string().optional(),
  horizontal: z.boolean().optional(),
});
export type ChartSpec = z.infer<typeof ChartSpec>;

export interface ChartPoint {
  value: number;
  display: string;
  /** The cell it was read from: what the trace opens. */
  cell: { alias: string; queryRunId: string; row: number; column: string };
}

export interface ResolvedChart {
  type: "bar" | "line";
  title: string;
  horizontal: boolean;
  /**
   * The spec's columns and format, so a dashboard can draw it again from a fresh run (a query tile).
   * Absent on older answers, saved before it was kept.
   */
  spec?: Pick<ChartSpec, "x" | "y" | "labels" | "series_by" | "format">;
  /** How the value axis shows numbers, from the spec's format. */
  axis: { currency?: string; percent?: boolean; compact: boolean };
  categories: string[];
  series: { name: string; points: (ChartPoint | null)[] }[];
}

const MAX_CATEGORIES = 50;
const MAX_SERIES = 6;

const isTime = (type: string) => type === "timestamp" || type === "date";
const numeric = (v: unknown): number | null => {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const humanize = (column: string) =>
  column.endsWith("_previous") ? "Previous period" : column.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Resolves a chart against the results the answer may cite, or says why it can't be drawn. */
export function resolveChart(
  raw: unknown,
  results: CitableResult[],
): { ok: true; chart: ResolvedChart } | { ok: false; problem: string } {
  const parsed = ChartSpec.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: `A chart's spec isn't valid: ${z.prettifyError(parsed.error)}` };
  const spec = parsed.data;
  const at = `Chart "${spec.title}"`;
  const result = results.find((r) => r.alias === spec.query);
  if (!result) return { ok: false, problem: `${at}: there's no query ${spec.query} in this conversation.` };
  const col = (name: string) => result.columns.findIndex((c) => c.name === name);
  const missing = [spec.x, ...spec.y, ...(spec.series_by ? [spec.series_by] : [])].filter((n) => col(n) < 0);
  if (missing.length) {
    return {
      ok: false,
      problem: `${at}: ${spec.query} has no column ${missing.join(", ")}. Its columns: ${result.columns.map((c) => c.name).join(", ")}.`,
    };
  }
  if (spec.series_by && spec.y.length > 1) {
    return { ok: false, problem: `${at}: with series_by, y takes one column.` };
  }
  let format: Format = {};
  if (spec.format) {
    const f = parseFormat(spec.format);
    if (!f.ok) return { ok: false, problem: `${at}: ${f.message}` };
    format = f.format;
  }
  // A label reads its own column: a time column shows its month, anything else as it is.
  const labelOf = (column: string) => {
    const type = result.columns[col(column)]?.type ?? "text";
    return (v: unknown) =>
      v === null || v === undefined ? "—" : isTime(type) ? formatTime(String(v), { month: true }) : String(v);
  };
  const label = labelOf(spec.x);
  const point = (row: number, column: string): ChartPoint | null | "bad" => {
    const v = result.rows[row]?.[col(column)];
    if (v === null || v === undefined) return null;
    const n = numeric(v);
    if (n === null) return "bad";
    return {
      value: n,
      display: formatNumber(n, format),
      cell: { alias: result.alias, queryRunId: result.queryRunId, row, column },
    };
  };

  const categories: string[] = [];
  const index = new Map<string, number>();
  for (const row of result.rows) {
    const key = label(row[col(spec.x)]);
    if (!index.has(key)) {
      index.set(key, categories.length);
      categories.push(key);
    }
  }
  if (categories.length > MAX_CATEGORIES) {
    return {
      ok: false,
      problem: `${at}: ${categories.length} categories is too many to read; aggregate or limit the query.`,
    };
  }
  let series: ResolvedChart["series"];
  if (spec.series_by) {
    const by = col(spec.series_by);
    const named = labelOf(spec.series_by);
    // A group with no value (null, or empty text) still needs a name: a legend leaves out a series without one.
    const none = `No ${humanize(spec.series_by).toLowerCase()}`;
    const group = (v: unknown) => (v === null || v === undefined || String(v).trim() === "" ? none : named(v));
    const groups = [...new Set(result.rows.map((r) => group(r[by])))];
    if (groups.length > MAX_SERIES) return { ok: false, problem: `${at}: ${groups.length} series is too many.` };
    series = groups.map((g) => ({ name: g, points: categories.map(() => null as ChartPoint | null) }));
    for (const [i, row] of result.rows.entries()) {
      const s = series[groups.indexOf(group(row[by]))];
      const p = point(i, spec.y[0] as string);
      if (p === "bad") return { ok: false, problem: `${at}: ${spec.y[0]} holds values that aren't numbers.` };
      if (s) s.points[index.get(label(row[col(spec.x)])) as number] = p;
    }
  } else {
    series = [];
    for (const [k, column] of spec.y.entries()) {
      const points = categories.map(() => null as ChartPoint | null);
      for (const [i, row] of result.rows.entries()) {
        const p = point(i, column);
        if (p === "bad") return { ok: false, problem: `${at}: ${column} holds values that aren't numbers.` };
        points[index.get(label(row[col(spec.x)])) as number] = p;
      }
      series.push({ name: spec.labels?.[k] ?? humanize(column), points });
    }
  }
  if (spec.type === "line" && categories.length < 2) {
    return {
      ok: false,
      problem: `${at}: a line needs at least two points on its x axis; use a bar, or state the number.`,
    };
  }
  if (series.every((s) => s.points.every((p) => p === null))) {
    return { ok: false, problem: `${at}: there's nothing to draw (every value is empty).` };
  }
  return {
    ok: true,
    chart: {
      type: spec.type,
      title: spec.title,
      horizontal: Boolean(spec.horizontal),
      spec: {
        x: spec.x,
        y: spec.y,
        ...(spec.labels ? { labels: spec.labels } : {}),
        ...(spec.series_by ? { series_by: spec.series_by } : {}),
        ...(spec.format ? { format: spec.format } : {}),
      },
      axis: {
        ...(format.currency ? { currency: format.currency } : {}),
        ...(format.percent ? { percent: true } : {}),
        compact: true,
      },
      categories,
      series,
    },
  };
}

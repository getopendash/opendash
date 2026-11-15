/**
 * What a chart needs of its query, shared by the definition's check and the frame that draws it: no zod
 * here, so the frame's bundle stays without it.
 */
import type { Grain } from "../protocol";

/** What a chart section draws; each takes its query in one shape (`checkDefinition` says which). */
export const CHART_TYPES = [
  "line",
  "bar",
  "area",
  "scatter",
  "bullet",
  "calendar",
  "funnel",
  "treemap",
  "waterfall",
  "heatmap",
  "sankey",
  "timeline",
  "boxplot",
] as const;
export type ChartType = (typeof CHART_TYPES)[number];
/** Series one chart tells apart by colour: the validated palette's six, then "Other" (or a cut, said). */
export const MAX_SERIES = 6;
/** Small charts one section draws, at most: the largest twelve. */
export const MAX_PANELS = 12;
/** The days a calendar draws, at most: a year (the last 366 of a longer period). */
export const MAX_DAYS = 366;
/** Bullets one section draws, at most. */
export const MAX_BULLETS = 20;
/** A heatmap's columns and rows, at most: past them, the largest (or the latest dates) are drawn and the cut said. */
export const MAX_HEAT_COLUMNS = 36;
export const MAX_HEAT_ROWS = 24;
/** A sankey's flows, at most: the largest, the rest said. */
export const MAX_FLOWS = 40;
/** A timeline's bars, at most: the earliest starts, the rest said. */
export const MAX_SPANS = 60;
/** A box plot's groups, at most: the ones with the most rows. */
export const MAX_BOXES = 20;
/** Charts that read rows (a query that selects columns), not measures: a timeline's spans, a box plot's values. */
export const ROW_CHARTS = ["timeline", "boxplot"] as const;

interface Grouped {
  by?: string[] | undefined;
  measures?: Record<string, readonly unknown[]> | undefined;
}

/** A query's groups as its outputs, in order: `created_at:month` is `created_at_month`. */
export function groupsOf(q: Grouped): string[] {
  return (q.by ?? []).map((b) => b.replace(":", "_"));
}

/** The grain of a group that's a date at a grain (`created_at:month` read as `created_at_month`), else undefined. */
export function grainOf(q: Grouped, output: string): Grain | undefined {
  const b = q.by?.[groupsOf(q).indexOf(output)];
  return b?.includes(":") ? (b.split(":")[1] as Grain) : undefined;
}

/**
 * Whether a measure's values add up across groups, so the groups past a cut can be summed into "Other" and sizes shown
 * as parts of a whole: a count or a sum. An average, a distinct count or a named measure isn't known to add up.
 */
export function isAdditive(q: Grouped, name: string): boolean {
  const m = q.measures?.[name];
  return m?.[0] === "count" || m?.[0] === "sum";
}

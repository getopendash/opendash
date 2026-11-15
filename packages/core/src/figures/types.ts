/**
 * A metric's figures, worked out on the server from the rows its query returned, so whatever draws them (Home's
 * tiles, a goal, a routine's summary, a check) only shows numbers the query returned. Each point's `row` opens its
 * trace.
 */
import { z } from "zod";

export const Point = z.object({
  /** The period's first day (2026-09-01) for a time series, else the category. */
  period: z.string(),
  /** Its short label: Sep, or Sep 26 across years. */
  label: z.string(),
  value: z.number().nullable(),
  display: z.string(),
  /** The row of the query run it was read from. */
  row: z.number().int(),
});
export type Point = z.infer<typeof Point>;

export const MetricFigures = z.object({
  /** The latest period's value: what a tile shows. */
  latest: Point.nullable(),
  /** The period before it, only when it's the adjacent one. */
  previous: Point.nullable(),
  /** From previous to latest, coloured by the metric's direction (null when neutral). */
  change: z.object({ pct: z.number(), display: z.string(), good: z.boolean().nullable() }).nullable(),
  points: z.array(Point),
});
export type MetricFigures = z.infer<typeof MetricFigures>;

/** Text that reads as a figure ($9.8k, 12.5%, 412,600, 3.12): numbers belong in a query, not in words written by hand. */
const FIGURE = /[$€£¥]\s?\d|\d\.\d|\d\s?%|\d{1,3}(,\d{3})+|\b\d+[kmb]\b|\b\d{5,}\b/i;

/** Whether text states a figure ("MRR $1.2M"). */
export const hasFigure = (text: string) => FIGURE.test(text);

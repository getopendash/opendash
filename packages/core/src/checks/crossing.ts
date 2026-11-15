/**
 * A line crossed: a metric's latest period beyond a value the team drew, below or above it. The finding is
 * the run of periods beyond it that ends at the latest, keyed by where the run began, so it's told once and again only
 * after the metric comes back and crosses anew. Deterministic: no model.
 */
import { addPeriods, type CheckGrain } from "../routines/schedule";

export interface Line {
  direction: "below" | "above";
  value: number;
}

export interface Crossed {
  /** The run's first period beyond the line, and how many periods it's lasted. */
  since: string;
  periods: number;
  latest: { period: string; value: number; row: number };
}

const beyond = (line: Line, value: number) => (line.direction === "below" ? value < line.value : value > line.value);

/** The run beyond the line that ends at the latest period, or null when the latest isn't beyond it. */
export function crossed(
  points: { period: string; value: number; row: number }[],
  line: Line,
  grain: CheckGrain,
): Crossed | null {
  const latest = points.at(-1);
  if (!latest || !beyond(line, latest.value)) return null;
  let first = points.length - 1;
  while (first > 0) {
    const before = points[first - 1] as { period: string; value: number };
    const here = points[first] as { period: string };
    if (!beyond(line, before.value) || addPeriods(before.period, 1, grain) !== here.period.slice(0, 10)) break;
    first--;
  }
  return {
    since: (points[first] as { period: string }).period.slice(0, 10),
    periods: points.length - first,
    latest: { period: latest.period.slice(0, 10), value: latest.value, row: latest.row },
  };
}

/** A line's dedupe key prefix: the metric and the line, so lines drawn by two routines are two findings. */
export const lineKey = (metricId: string, line: Line) => `threshold:${metricId}:${line.direction}:${line.value}:`;

import { displayMetric, formatNumber, type MetricFormat } from "../answer/format";
import { shift } from "../semantic/time";
import type { MetricFigures, Point } from "./types";

export { displayMetric, type MetricFormat, metricFormat } from "../answer/format";
export type MetricDirection = "higher_is_better" | "lower_is_better" | "neutral";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const monthOf = (period: string) => new Date(`${period.slice(0, 10)}T00:00:00Z`);

/**
 * A metric's figures over whole months (or weeks), from the rows its query returned: the latest period, the one
 * before (only when it's the adjacent one, so a gap never reads as a change), the change coloured by the metric's
 * direction, and every point labelled for a chart (Sep; a week by its Monday, Oct 5). The same function draws Home's
 * tiles, goals and routines' summaries, so they agree.
 */
export function metricFigures(
  metric: { format: MetricFormat; direction: MetricDirection },
  rows: { period: string; value: number | string | null }[],
  grain: "month" | "week" | "day" = "month",
): MetricFigures {
  const dated = (period: string) => !Number.isNaN(monthOf(period).getTime());
  const years = new Set(rows.filter((r) => dated(r.period)).map((r) => r.period.slice(0, 4)));
  const points: Point[] = rows.map((r, row) => {
    const d = monthOf(r.period);
    const value = r.value === null || r.value === "" ? null : Number(r.value);
    const finite = value !== null && Number.isFinite(value) ? value : null;
    return {
      period: r.period.slice(0, 10),
      // A month (Sep, or Sep 26 across years), or a week or a day (Oct 5); a metric without time is its value now.
      label: !dated(r.period)
        ? r.period || "Now"
        : grain === "week" || grain === "day"
          ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`
          : `${MONTHS[d.getUTCMonth()]}${years.size > 1 ? ` ${String(d.getUTCFullYear()).slice(2)}` : ""}`,
      value: finite,
      display: finite === null ? "—" : displayMetric(metric.format, finite),
      row,
    };
  });
  const latest = points.at(-1) ?? null;
  const before = points.at(-2) ?? null;
  const expected = latest && dated(latest.period) ? shift(monthOf(latest.period), -1, grain) : null;
  const previous = before && expected && before.period === expected.toISOString().slice(0, 10) ? before : null;
  let change: MetricFigures["change"] = null;
  if (latest?.value !== null && latest && previous?.value !== null && previous && previous.value !== 0) {
    const pct = (latest.value - previous.value) / Math.abs(previous.value);
    change = {
      pct,
      display: formatNumber(Math.abs(pct), { percent: true, decimals: 1 }),
      good: metric.direction === "neutral" ? null : pct >= 0 === (metric.direction === "higher_is_better"),
    };
  }
  return { latest, previous, change, points };
}

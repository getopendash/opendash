/**
 * Outcome checks v0: a done task's metric over the whole months after it, against
 * a counterfactual of prior-trend extrapolation, with no model involved. The trend is the median month-on-month
 * change over the months before the task (relative for a metric that stays positive), projected from the last whole
 * month before it was done to the last month of its horizon.
 */
import type { SeriesPoint } from "../checks/detect";

export interface OutcomeSpec {
  /** Which way the task should move the metric. */
  direction: "up" | "down";
  /** The first whole month after the month it was done (YYYY-MM-01). */
  fromMonth: string;
  /** How many whole months, from `fromMonth`, it's judged over. */
  horizonMonths: number;
  /** A difference smaller than this, against the projection, is no change. */
  threshold: number;
}

export type Verdict = "improved" | "no_change" | "worsened" | "inconclusive";

export interface OutcomeJudgement {
  verdict: Verdict;
  /** Why it's inconclusive, in words. */
  reason?: string;
  /** The last whole month before the task, and the last of its horizon: cells of the query run. */
  baseline?: { period: string; value: number; row: number };
  observed?: { period: string; value: number; row: number };
  /** What the metric would have done on its trend, at the last month of the horizon. */
  projected?: number;
  /** (observed − projected) / |projected|. */
  delta?: number;
  /** The trend: the median monthly change (relative or absolute) and how many months it came from. */
  trend?: { change: number; relative: boolean; months: number };
}

/** The trend's months at most, and at least. */
const TREND_MAX = 6;
const TREND_MIN = 3;

export const addMonths = (month: string, n: number) => {
  const d = new Date(`${month.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** The first whole month after the month `doneAt` falls in. */
export const monthAfter = (doneAt: Date) =>
  new Date(Date.UTC(doneAt.getUTCFullYear(), doneAt.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);

/** When the check runs: the morning after the horizon's last month closes. */
export function checkAt(doneAt: Date, horizonMonths: number, hourUtc = 6): Date {
  const end = addMonths(monthAfter(doneAt), horizonMonths);
  return new Date(`${end}T${String(hourUtc).padStart(2, "0")}:00:00Z`);
}

export function judgeOutcome(points: SeriesPoint[], spec: OutcomeSpec): OutcomeJudgement {
  const known = new Map(
    points
      .filter((p): p is SeriesPoint & { value: number } => p.value !== null && Number.isFinite(p.value))
      .map((p) => [p.period.slice(0, 10), p]),
  );
  // The month it was done is mixed, so the baseline is the month before it.
  const baselineMonth = addMonths(spec.fromMonth, -2);
  const lastMonth = addMonths(spec.fromMonth, spec.horizonMonths - 1);
  const base = known.get(baselineMonth);
  if (!base) return { verdict: "inconclusive", reason: "It has no value for the month before the task." };
  const seen = known.get(lastMonth);
  if (!seen) return { verdict: "inconclusive", reason: "The horizon's last month has no value yet." };
  const history: { value: number }[] = [];
  for (let i = TREND_MAX; i >= 0; i--) {
    const p = known.get(addMonths(baselineMonth, -i));
    if (p) history.push(p);
    else history.length = 0;
  }
  const relative = history.every((p) => p.value > 0);
  const changes = history
    .slice(1)
    .map((p, i) =>
      relative
        ? p.value / (history[i] as { value: number }).value - 1
        : p.value - (history[i] as { value: number }).value,
    );
  if (changes.length < TREND_MIN) {
    return {
      verdict: "inconclusive",
      reason: `It needs ${TREND_MIN} whole months in a row before the task to have a trend.`,
    };
  }
  const change = median(changes);
  const steps = spec.horizonMonths + 1;
  const projected = relative ? base.value * (1 + change) ** steps : base.value + change * steps;
  const scale = Math.abs(projected) || Math.abs(base.value) || 1;
  const delta = (seen.value - projected) / scale;
  const toward = spec.direction === "up" ? delta : -delta;
  return {
    verdict: toward >= spec.threshold ? "improved" : toward <= -spec.threshold ? "worsened" : "no_change",
    baseline: { period: baselineMonth, value: base.value, row: base.row },
    observed: { period: lastMonth, value: seen.value, row: seen.row },
    projected,
    delta,
    trend: { change, relative, months: changes.length },
  };
}

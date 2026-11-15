/**
 * Goal risk (detector "forecast vs target"): a goal's metric, projected on its trend
 * from its latest whole month to the month the goal is due, against the target. The trend is the median
 * month-on-month change of up to 6 months before (relative for a metric that stays positive), as a task's outcome
 * check uses. Deterministic: no model.
 */
import type { GoalSpec } from "../context/goals";
import type { SeriesPoint } from "./detect";

const TREND_MAX = 6;
const TREND_MIN = 3;

export interface GoalForecast {
  /** The latest whole month: a cell of its check's query run. */
  latest: { period: string; value: number; row: number };
  /** The month the goal is due in (YYYY-MM-01), and the value projected for it. */
  dueMonth: string;
  projected: number;
  onCourse: boolean;
  /** How far the projection misses the target, as a share of it (0 when on course). */
  shortfall: number;
  trend: { change: number; relative: boolean; months: number };
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

const monthOf = (day: string) => `${day.slice(0, 7)}-01`;
const monthsBetween = (from: string, to: string) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + (Number(to.slice(5, 7)) - Number(from.slice(5, 7)));
const addMonths = (month: string, n: number) => {
  const d = new Date(`${month.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/** Null when there's no latest month or too short a trend to project, or the goal's month is already past. */
export function forecastGoal(
  points: SeriesPoint[],
  goal: Pick<GoalSpec, "target" | "due" | "direction">,
): GoalForecast | null {
  const known = points.filter(
    (p): p is SeriesPoint & { value: number } => p.value !== null && Number.isFinite(p.value),
  );
  const latest = known.at(-1);
  if (!latest) return null;
  const dueMonth = monthOf(goal.due);
  const steps = monthsBetween(monthOf(latest.period), dueMonth);
  if (steps < 0) return null;
  // The months in a row that end at the latest one.
  const run: (SeriesPoint & { value: number })[] = [latest];
  for (let i = known.length - 2; i >= 0 && run.length <= TREND_MAX; i--) {
    const p = known[i] as SeriesPoint & { value: number };
    if (addMonths(monthOf(p.period), 1) !== monthOf((run[0] as SeriesPoint).period)) break;
    run.unshift(p);
  }
  const relative = run.every((p) => p.value > 0);
  const changes = run.slice(1).map((p, i) => {
    const before = (run[i] as { value: number }).value;
    return relative ? p.value / before - 1 : p.value - before;
  });
  if (steps > 0 && changes.length < TREND_MIN) return null;
  const change = changes.length ? median(changes) : 0;
  const projected = relative ? latest.value * (1 + change) ** steps : latest.value + change * steps;
  // A due date far off can compound past any number: no forecast rather than Infinity.
  if (!Number.isFinite(projected)) return null;
  const onCourse = goal.direction === "at_least" ? projected >= goal.target : projected <= goal.target;
  const miss = goal.direction === "at_least" ? goal.target - projected : projected - goal.target;
  return {
    latest: { period: latest.period.slice(0, 10), value: latest.value, row: latest.row },
    dueMonth,
    projected,
    onCourse,
    shortfall: onCourse ? 0 : miss / (Math.abs(goal.target) || 1),
    trend: { change, relative, months: changes.length },
  };
}

/** 1 within 5% of the target, 2 within 15%, 3 beyond. */
export const goalRiskSeverity = (shortfall: number): 1 | 2 | 3 => (shortfall < 0.05 ? 1 : shortfall < 0.15 ? 2 : 3);

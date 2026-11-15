/**
 * How a goal stands: how far along its metric is, or how far over for a keep-below goal,
 * and the time left. The forecast, when its metric is watched, is goalForecastLine.
 */
const DAY = 86_400_000;
const dueLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export interface GoalProgress {
  /** How full the bar is, 0 to 1. */
  bar: number;
  met: boolean;
  tone: "success" | "accent" | "warning";
  /** "83% of the target", "$1.8k above the target", "Reached the target", "Within the target". */
  standing: string;
  /** "81 days left", "Due today", "Due Dec 31 passed". */
  time: string;
}

export function goalProgress(
  goal: { target: number; due: string; direction: "at_least" | "at_most" },
  current: number | null,
  now: number,
  /** The metric's own formatting ("$1.8k"). */
  show: (value: number) => string,
): GoalProgress {
  const end = Date.parse(`${goal.due}T00:00:00Z`) + DAY;
  const days = Math.ceil((end - now) / DAY);
  const time =
    end <= now
      ? `Due ${dueLabel.format(new Date(`${goal.due}T00:00:00Z`))} passed`
      : days <= 1
        ? "Due today"
        : `${days} days left`;
  if (current === null) return { bar: 0, met: false, tone: "accent", standing: "No value yet", time };
  const ratio = goal.target === 0 ? (current >= 0 ? 1 : 0) : current / goal.target;
  if (goal.direction === "at_least") {
    const met = current >= goal.target;
    return {
      bar: Math.max(0, Math.min(1, ratio)),
      met,
      tone: met ? "success" : "accent",
      standing: met ? "Reached the target" : `${Math.floor(ratio * 100)}% of the target`,
      time,
    };
  }
  const met = current <= goal.target;
  return {
    bar: Math.max(0, Math.min(1, ratio)),
    met,
    tone: met ? "success" : "warning",
    standing: met ? "Within the target" : `${show(current - goal.target)} above the target`,
    time,
  };
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/**
 * Goal risk v0 on Home: "At risk: $466.8k projected for December, on its trend". Null without a forecast (its metric
 * isn't watched, or hasn't the history). The projection isn't a cell, so the line says it's projected.
 */
export function goalForecastLine(
  forecast: { onCourse: boolean; projected: number; dueMonth: string } | null,
  show: (value: number) => string,
): { text: string; onCourse: boolean } | null {
  if (!forecast) return null;
  const month = MONTH.format(new Date(`${forecast.dueMonth}T00:00:00Z`));
  return {
    text: `${forecast.onCourse ? "On course" : "At risk"}: ${show(forecast.projected)} projected for ${month}, on its trend`,
    onCourse: forecast.onCourse,
  };
}

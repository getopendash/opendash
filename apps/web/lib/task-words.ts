import type { TaskOutcome, TaskView, Verdict } from "@opendash/core";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** A task's first wording, from the insight it's made from. */
export const defaultTaskTitle = (insightTitle: string) => `Find out why ${insightTitle}`;

export const HORIZON_LABEL: Record<number, string> = {
  1: "The whole month after it's done",
  2: "The 2 whole months after it's done",
  3: "The 3 whole months after it's done",
  6: "The 6 whole months after it's done",
};

/** The chip on a task: where it is, or what its outcome was. */
export function taskChip(t: Pick<TaskView, "status" | "checkAt" | "outcome">): {
  label: string;
  tone: "default" | "accent" | "success" | "warning" | "danger";
} {
  if (t.status === "accepted") return { label: "To do", tone: "default" };
  if (t.status === "in_progress") return { label: "In progress", tone: "accent" };
  if (t.status === "dismissed") return { label: "Dismissed", tone: "default" };
  if (!t.outcome) {
    return { label: t.checkAt ? `Checked ${SHORT.format(new Date(t.checkAt))}` : "Done", tone: "default" };
  }
  return VERDICT[t.outcome.verdict];
}

const VERDICT: Record<Verdict, { label: string; tone: "success" | "default" | "danger" | "warning" }> = {
  improved: { label: "Improved", tone: "success" },
  no_change: { label: "No change", tone: "default" },
  worsened: { label: "Worsened", tone: "danger" },
  inconclusive: { label: "Inconclusive", tone: "warning" },
};

/** "Expected: New accounts up, judged over the 2 whole months after it's done". */
export function expectationLine(t: Pick<TaskView, "metric" | "direction" | "horizonMonths">): string {
  const months = t.horizonMonths === 1 ? "the whole month" : `the ${t.horizonMonths} whole months`;
  return `Expected: ${t.metric?.title ?? "its metric"} ${t.direction}, judged over ${months} after it's done`;
}

/** "+10%" against the projection. */
export const deltaLabel = (delta: number) => `${delta >= 0 ? "+" : "−"}${Math.round(Math.abs(delta) * 100)}%`;

/** What a done task's card says under its figures, or instead of them. */
export function outcomeNote(t: Pick<TaskView, "metric" | "horizonMonths" | "checkAt">, o: TaskOutcome | null): string {
  const metric = t.metric?.title ?? "its metric";
  const months = t.horizonMonths === 1 ? "the whole month" : `the ${t.horizonMonths} whole months`;
  if (!o) {
    return t.checkAt
      ? `Its outcome is checked on ${DAY.format(new Date(t.checkAt))}, after ${months} that follow it, against what ${metric} would have done on its trend.`
      : "It has no metric to check.";
  }
  if (o.verdict === "inconclusive") return `It couldn't be checked: ${lower(o.reason ?? "its data wasn't there.")}`;
  const trend = o.trendMonths ? `the ${o.trendMonths} months before` : "the months before";
  return `Checked ${DAY.format(new Date(o.checkedAt))}, over ${months} after it was done. The projection extends how ${metric} changed in ${trend}; it isn't a query cell.`;
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);

/** The observed month's name, for the figure's label. */
export const monthLabel = (period: string) => MONTH.format(new Date(`${period.slice(0, 10)}T00:00:00Z`));

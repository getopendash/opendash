import "server-only";
import { displayMetric, type Goal } from "@opendash/core";
import type { GoalRow } from "@/components/goals/goals-table";
import { goalForecastLine, goalProgress } from "./goal-progress";

const dueLabel = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A goal as the goals list and Home show it: in its metric's own format, with how it stands now. */
export function goalRow(
  g: Goal,
  now: number,
): GoalRow & {
  current: string | null;
  metricId: string | null;
  forecast: ReturnType<typeof goalForecastLine>;
} {
  const format = g.metric?.format ?? "number";
  const show = (v: number) => displayMetric(format, v);
  const p = goalProgress(g.spec, g.current?.value ?? null, now, show);
  return {
    id: g.id,
    title: g.title,
    metric: g.metric?.title ?? "A metric that was removed",
    metricId: g.metric?.id ?? null,
    target: show(g.spec.target),
    due: dueLabel.format(new Date(`${g.spec.due}T00:00:00Z`)),
    current: g.current ? show(g.current.value) : null,
    standing: g.metric ? p.standing : "Its metric was removed",
    time: p.time,
    bar: p.bar,
    tone: p.tone,
    forecast: g.metric ? goalForecastLine(g.forecast, show) : null,
    draft: { id: g.id, metricId: g.spec.metric, target: g.spec.target, due: g.spec.due, direction: g.spec.direction },
  };
}

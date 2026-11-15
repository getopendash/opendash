import type { DefinitionUsage } from "@opendash/core";

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What a change reaches once approved, in a sentence; null when nothing depends on it. */
export function impactOf(usage: DefinitionUsage, kind: "dataset" | "metric"): string | null {
  const { metrics, dashboards, verifiedQueries, evalQuestions, goals } = usage;
  const boards = dashboards.visible.length + dashboards.hidden;
  const parts = [
    kind === "dataset" && metrics.length ? count(metrics.length, "metric") : null,
    boards ? `${count(boards, "dashboard")}${dashboards.hidden ? ` (${dashboards.hidden} private)` : ""}` : null,
    verifiedQueries.length ? count(verifiedQueries.length, "verified query", "verified queries") : null,
    goals.length ? count(goals.length, "goal") : null,
    evalQuestions ? count(evalQuestions, "eval question") : null,
  ].filter((p): p is string => Boolean(p));
  if (!parts.length) return null;
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `Once approved, the change reaches ${list}.`;
}

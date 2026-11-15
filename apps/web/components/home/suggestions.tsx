import type { KeyMetric } from "@opendash/core";
import { CornerDownRight } from "lucide-react";
import Link from "next/link";

/** Home's starting points, phrased from the verified metrics (each opens a new question, filled in). */
export function Suggestions({
  metrics,
  goal,
}: {
  metrics: KeyMetric[];
  /** The first goal: its starter carries the target, so the asker's own numbers say it. */
  goal?: { metric: string; target: string };
}) {
  // An acronym if the metric has one (MRR), else its title with a lowercase first letter (churned MRR).
  const called = (m: KeyMetric) =>
    m.synonyms.find((x) => /^[A-Z]{2,5}$/.test(x)) ?? m.title.charAt(0).toLowerCase() + m.title.slice(1);
  const goalMetric = goal ? metrics.find((m) => m.title === goal.metric) : undefined;
  const questions = [
    ...(goal
      ? [`How is ${goalMetric ? called(goalMetric) : goal.metric} tracking against its ${goal.target} target?`]
      : []),
    ...metrics.slice(0, 2).map((m) => `How did ${called(m)} change last month?`),
    ...metrics.slice(0, 2).map((m) => `${m.title} by month this year`),
  ].slice(0, 4);
  return (
    <div className="flex flex-wrap gap-2">
      {questions.map((q) => (
        <Link
          key={q}
          href={`/ask/new?q=${encodeURIComponent(q)}`}
          className="flex items-center gap-1.5 rounded-xl border border-border px-2.5 py-1 text-small text-muted hover:bg-default hover:text-foreground"
        >
          <CornerDownRight className="size-3" aria-hidden />
          {q}
        </Link>
      ))}
    </div>
  );
}

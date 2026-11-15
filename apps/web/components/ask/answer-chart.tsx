"use client";

import type { ResolvedChart } from "@opendash/core";
import { Chart, PathLabel } from "@opendash/ui";
import type { ReactNode } from "react";
import type { TracedRef } from "./answer-text";

/**
 * A chart in an answer: drawn from one query's cells, so every bar is a number that can be traced; pressing one
 * opens its trace, like a traced number in the text. Its `action` (Add to dashboard) sits by its label.
 */
export function AnswerChart({
  chart,
  metric,
  onTrace,
  action,
}: {
  chart: ResolvedChart;
  /** Its numbers came from verified definitions. */
  metric: boolean;
  onTrace: (ref: TracedRef) => void;
  action?: ReactNode;
}) {
  const alias = chart.series.flatMap((s) => s.points).find((p) => p)?.cell.alias;
  return (
    <figure className="flex flex-col gap-3 rounded-2xl border border-border px-4 py-3.5">
      <figcaption className="flex items-center justify-between gap-3">
        <span className="text-body font-medium">{chart.title}</span>
        <span className="flex shrink-0 items-center gap-2">
          <PathLabel path={metric ? "metric" : "unmodelled"} />
          {action}
        </span>
      </figcaption>
      <Chart
        chart={chart}
        label={`${chart.title}: ${chart.series.map((s) => s.name).join(", ")} by ${chart.categories.length} categories`}
        className={chart.horizontal ? "h-56" : "h-64"}
        onPoint={(series, index) => {
          const p = chart.series[series]?.points[index];
          if (!p) return;
          onTrace({
            ref: `${p.cell.alias}:${p.cell.row}:${p.cell.column}`,
            display: p.display,
            kind: "number",
            citations: [p.cell],
          });
        }}
      />
      <span className="text-small text-muted-tertiary">
        Every value is a cell of {alias ?? "its query"}. Press one to see where it comes from.
      </span>
    </figure>
  );
}

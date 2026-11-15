"use client";

import { History } from "lucide-react";
import { Chart, type ChartData } from "./chart";

/**
 * A line a routine would watch, over the metric's recent periods: its checked values as bars, the latest in
 * the accent, the line across them in the danger tone, and what the line would have done, in words, beneath.
 */
export function ThresholdPreview({
  label,
  periods,
  values,
  line,
  axis,
  note,
}: {
  /** What it shows, for screen readers. */
  label: string;
  /** Each period's label ("Jul 20"), oldest first. */
  periods: string[];
  values: ({ value: number; display: string } | null)[];
  line: { value: number; display: string } | null;
  axis?: ChartData["axis"];
  /** "Over the last 12 weeks this would have stayed quiet." */
  note?: string;
}) {
  const chart: ChartData = {
    type: "bar",
    horizontal: false,
    emphasizeLast: true,
    categories: periods,
    series: [{ name: label, points: values }],
    ...(axis ? { axis } : {}),
    ...(line ? { line } : {}),
  };
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-3">
      <Chart chart={chart} label={label} className="h-36" />
      {note ? (
        <span className="flex items-center gap-1.5 text-small text-muted">
          <History className="size-3.5 shrink-0" aria-hidden />
          {note}
        </span>
      ) : null}
    </div>
  );
}

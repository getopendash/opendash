"use client";

import type { KeyMetric } from "@opendash/core";
import { Chart, type ChartData, PathLabel } from "@opendash/ui";
import Link from "next/link";

const month = new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });

/** Home's large chart: the first key metric over the last year of months, with its latest value and change. */
export function TrendCard({
  metric,
  value,
  change,
  displays,
}: {
  metric: KeyMetric;
  value: string;
  change: string | null;
  /** Each month's value, formatted (the server formats, as the tiles do). */
  displays: string[];
}) {
  const chart: ChartData = {
    type: "bar",
    horizontal: false,
    emphasizeLast: true,
    axis: metric.format === "usd" ? { currency: "USD" } : metric.format === "percent" ? { percent: true } : {},
    categories: metric.trend.map((t) => month.format(new Date(`${t.period}T00:00:00Z`))),
    series: [
      {
        name: metric.title,
        points: metric.trend.map((t, i) =>
          t.value === null ? null : { value: Number(t.value), display: displays[i] ?? String(t.value) },
        ),
      },
    ],
  };
  return (
    <section className="flex min-w-0 flex-1 flex-col gap-3 rounded-2xl border border-border p-4">
      <header className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link href={`/knowledge/metrics/${metric.id}`} className="text-body font-medium hover:underline">
            {metric.title} by month
          </Link>
          <span className="flex items-baseline gap-2">
            <span className="text-title tabular-nums">{value}</span>
            {change ? <span className="text-small text-muted">{change}</span> : null}
          </span>
        </div>
        <PathLabel path="metric" />
      </header>
      <Chart chart={chart} label={`${metric.title} for each of the last twelve months`} className="h-64" />
    </section>
  );
}

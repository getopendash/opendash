"use client";

import type { AnswerSegment, ResolvedChart } from "@opendash/core";
import { DownloadMenu } from "@opendash/ui";
import { useQueries } from "@tanstack/react-query";
import { useState } from "react";
import { apiQueries } from "@/lib/api";

/** Where a query's rows download as CSV (the route reads its query card as the viewer). */
export const csvUrl = (queryRunId: string) => `/queries/${queryRunId}/csv`;

const WHAT = "The query's rows as kept, at most 100";

/** The queries a chart reads (one, in practice). */
export const chartQueries = (chart: Pick<ResolvedChart, "series">): string[] => [
  ...new Set(chart.series.flatMap((s) => s.points.flatMap((p) => (p ? [p.cell.queryRunId] : [])))),
];

/** The queries behind an answer: the ones its numbers cite, then its charts'. */
export function answerQueries(answer: {
  segments?: { markdown: AnswerSegment[]; caveats: AnswerSegment[][]; interpretation: AnswerSegment[][] } | null;
  charts?: Pick<ResolvedChart, "series">[] | null;
}): string[] {
  const segments = [
    ...(answer.segments?.markdown ?? []),
    ...(answer.segments?.caveats.flat() ?? []),
    ...(answer.segments?.interpretation.flat() ?? []),
  ];
  return [
    ...new Set([
      ...segments.flatMap((s) => ("ref" in s ? s.citations.map((c) => c.queryRunId) : [])),
      ...(answer.charts ?? []).flatMap(chartQueries),
    ]),
  ];
}

/**
 * Downloads the rows behind a table, a chart or an answer as CSV: each query's kept rows (at most 100), the same file
 * Slack attaches. One query is a link; several are a menu named by each query's title, read when it opens.
 */
export function CsvDownload({ queryRunIds, icon = false }: { queryRunIds: string[]; icon?: boolean }) {
  const [open, setOpen] = useState(false);
  const ids = [...new Set(queryRunIds)];
  const cards = useQueries({
    queries: ids.map((queryRunId) => ({
      ...apiQueries.queries.get.queryOptions({ input: { queryRunId } }),
      enabled: open && ids.length > 1,
    })),
  });
  const items = ids.map((id, i) => {
    const card = cards[i]?.data;
    return {
      href: csvUrl(id),
      label: card ? `${card.alias ? `${card.alias} · ` : ""}${card.title ?? "Query"}` : "Query",
    };
  });
  return <DownloadMenu items={items} what={WHAT} icon={icon} onOpenChange={setOpen} />;
}

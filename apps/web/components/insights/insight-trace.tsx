"use client";

import { CellTrace } from "./cell-trace";
import type { TraceTarget } from "./insight-card";

/** An insight figure's trace: the cell its check's query read; the band is said to be derived, not a cell. */
export function InsightTrace({ target, onClose }: { target: TraceTarget; onClose: () => void }) {
  if (target.which === "investigation") {
    // A figure of the investigation's write-up: its first cell, read by one of the Investigator's own queries (whose
    // card says how it was computed: a metric's or its own SQL).
    const [cell] = target.ref.citations;
    if (!cell) return null;
    return (
      <CellTrace
        cell={{
          display: target.ref.display,
          row: cell.row,
          column: cell.column,
          queryRunId: cell.queryRunId,
          ranBy: "Run by the Investigator",
          ...(target.ref.citations.length > 1
            ? {
                note: `Computed from ${target.ref.citations.length} cells; this is the first. The others are in the investigation's queries.`,
              }
            : {}),
        }}
        onClose={onClose}
      />
    );
  }
  const g = target.insight.goalRisk;
  if (g) {
    return (
      <CellTrace
        cell={{
          ...g.value,
          of: { metric: { id: g.metric.id, title: g.metric.title }, period: g.value.period },
          ranBy: "Run by its check",
          note: `The projection (${g.projected.display}) and the goal (${g.goal.target.display}) aren't query cells: the projection extends how ${g.metric.title} changed over the ${g.trendMonths} months before.`,
        }}
        onClose={onClose}
      />
    );
  }
  const t = target.insight.trend;
  if (t) {
    return (
      <CellTrace
        cell={{
          ...t.value,
          of: { metric: { id: t.metric.id, title: t.metric.title }, period: t.value.period },
          ranBy: "Run by its check",
          note: `The changes a month (${t.before.display} before, ${t.recent.display} lately) aren't query cells: the check takes the median of ${t.metric.title}'s month-on-month changes in this run, over the ${t.months.before} months before the shift and over the shift.`,
        }}
        onClose={onClose}
      />
    );
  }
  const l = target.insight.threshold;
  if (l) {
    return (
      <CellTrace
        cell={{
          ...l.value,
          of: { metric: { id: l.metric.id, title: l.metric.title }, period: l.value.period },
          ranBy: "Run by its check",
          note: `The line (${l.line.display}) isn't a query cell: a routine watches for ${l.metric.title} going ${l.line.direction} it.`,
        }}
        onClose={onClose}
      />
    );
  }
  const c = target.insight.claims;
  if (!c) return null;
  const cell = target.which === "value" ? c.value : (c.previous ?? c.value);
  return (
    <CellTrace
      cell={{
        ...cell,
        of: { metric: { id: c.metric.id, title: c.metric.title }, period: cell.period },
        ranBy: "Run by its check",
        note: `The expected range (${c.expected.display}) isn't a query cell: the check derives it from how ${c.metric.title} changed over the ${c.expected.periods} ${c.grain}s before.`,
      }}
      onClose={onClose}
    />
  );
}

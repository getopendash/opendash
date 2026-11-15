"use client";

import { Button } from "@heroui/react";
import { PathLabel } from "@opendash/ui";
import { X } from "lucide-react";
import Link from "next/link";
import { QueryCard } from "@/components/ask/query-card";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });

/** A figure read from one query cell: the cell, the definition, how it was run, a note, and the query. */
export interface TracedCell {
  display: string;
  row: number;
  column: string;
  queryRunId: string;
  /** "Run by its check", "Run by the task's outcome check". */
  ranBy: string;
  /** What beside it isn't a cell (an expected band, a projection). */
  note?: string;
  /**
   * The verified metric the cell is a period of, when it is (a metric check's, a task's): its definition and the
   * metric path are then said. A cell of the Investigator's own queries isn't one; its query card says its path.
   */
  of?: {
    metric: { id: string; title: string };
    period: string /** Its period in words, when not a month ("Oct 5–11"). */;
    label?: string;
  };
}

export function CellTrace({ cell, onClose }: { cell: TracedCell; onClose: () => void }) {
  return (
    <aside className="flex h-full w-full flex-col gap-4 overflow-y-auto border-l border-border p-5 @5xl/page:w-inspector">
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-body font-medium">Where this number comes from</h2>
        <Button isIconOnly size="sm" variant="ghost" aria-label="Close" onPress={onClose}>
          <X className="size-4" aria-hidden />
        </Button>
      </header>
      <div className="flex flex-col gap-1">
        <span className="text-number-lg tabular-nums">{cell.display}</span>
        <span className="text-small text-muted-tertiary">
          {cell.of
            ? `${cell.of.metric.title} · ${cell.of.label ?? MONTH.format(new Date(`${cell.of.period}T00:00:00Z`))} · read from one query cell`
            : `${cell.ranBy}: read from one query cell`}
        </span>
      </div>
      <dl className="flex flex-col gap-2 text-body">
        <div className="flex gap-3">
          <dt className="w-24 shrink-0 text-muted">Source cell</dt>
          <dd className="font-mono text-small">
            row {cell.row + 1} · {cell.column}
          </dd>
        </div>
        {cell.of ? (
          <>
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-muted">Definition</dt>
              <dd>
                <Link href={`/knowledge/metrics/${cell.of.metric.id}`} className="text-link hover:underline">
                  {cell.of.metric.title}
                </Link>
              </dd>
            </div>
            <div className="flex gap-3">
              <dt className="w-24 shrink-0 text-muted">Path</dt>
              <dd className="flex items-center gap-2">
                <PathLabel path="metric" /> {cell.ranBy}, from verified definitions
              </dd>
            </div>
          </>
        ) : null}
      </dl>
      {cell.note ? <p className="text-small text-muted">{cell.note}</p> : null}
      <QueryCard queryRunId={cell.queryRunId} highlight={[{ row: cell.row, column: cell.column }]} defaultOpen />
    </aside>
  );
}

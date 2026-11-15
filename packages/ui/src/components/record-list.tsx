"use client";

import { Button } from "@heroui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import {
  formatRecordCell,
  isIdentifier,
  type RecordColumnLike,
  recordsPages,
  recordsRange,
  recordTone,
} from "../record-format";
import { DataTable, dataColumns, useDataTable } from "./data-table";

const TONE = {
  good: "bg-status-verified-soft text-status-verified-foreground",
  bad: "bg-status-failed-soft text-status-failed-foreground",
  wait: "bg-status-stale-soft text-status-stale-foreground",
  high: "bg-status-progress-soft text-status-progress-foreground",
} as const;

type Row = Record<string, unknown>;
const col = dataColumns<Row>();

export interface RecordListProps {
  columns: RecordColumnLike[];
  /** Each row's cells, in the columns' order. */
  rows: unknown[][];
  page: number;
  pageSize: number;
  /** How many records there are, and the most that can be listed. */
  total: number;
  cap: number;
  /** What a record is called, plural: "tickets". */
  noun: string;
  /** What the table lists, for screen readers. */
  label: string;
  onPage?: (page: number) => void;
  /** Another page is on its way: the rows stay, dimmed. */
  busy?: boolean;
  /** The page came back shorter than it should: a result is kept only up to a size. */
  trimmed?: boolean;
}

/**
 * The records behind a number: a compact table of what a metric counts, a page at a time, with its range and pager.
 * Cells are written for reading (dates, money, Yes/No, status tones); identifiers are left as they are. Numbers sit
 * on the right. It draws what it's given: the request, the reconciliation with the clicked number and the hidden
 * columns are the panel's.
 */
export function RecordList({
  columns,
  rows,
  page,
  pageSize,
  total,
  cap,
  noun,
  label,
  onPage,
  busy = false,
  trimmed = false,
}: RecordListProps) {
  const data = useMemo<Row[]>(
    () => rows.map((r) => Object.fromEntries(columns.map((c, i) => [c.name, r[i]]))),
    [rows, columns],
  );
  const defs = useMemo(
    () =>
      columns.map((c, i) =>
        col.accessor(c.name, {
          header: c.label,
          enableSorting: false,
          meta: {
            ...(c.type === "number" && !isIdentifier(c.name) ? { align: "end" as const } : {}),
            ...(i === 0 ? { rowHeader: true } : {}),
            // One line each: a long text is cut short, anything else scrolls the table sideways.
            className: c.type === "string" && !recordTone(c.name, "x") ? "ui-record-text" : "whitespace-nowrap",
          },
          cell: (info) => {
            const value = info.getValue();
            const tone = recordTone(c.name, value);
            const text = formatRecordCell(value, c);
            if (tone) return <span className={`rounded-full px-2 py-0.5 text-micro ${TONE[tone]}`}>{text}</span>;
            return (
              <span
                className={[
                  value === null || value === undefined || value === "" ? "text-muted-tertiary" : "",
                  c.type === "number" ? "tabular-nums" : "",
                ]
                  .join(" ")
                  .trim()}
              >
                {text}
              </span>
            );
          },
        }),
      ),
    [columns],
  );
  const table = useDataTable<Row>({ columns: defs as never, data });
  const pages = recordsPages({ page, pageSize, total, cap });
  return (
    <div className="flex min-w-0 flex-col gap-2" aria-busy={busy}>
      <div className={busy ? "opacity-60 transition-opacity" : "transition-opacity"}>
        <DataTable
          table={table}
          label={label}
          variant="plain"
          empty={<span className="text-small text-muted">No {noun} here.</span>}
        />
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-small text-muted tabular-nums" aria-live="polite">
          {recordsRange({ page, pageSize, shown: rows.length, total, cap, noun })}
        </span>
        <div className="flex items-center gap-1">
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Previous page"
            isDisabled={!pages.prev || busy}
            onPress={() => onPage?.(page - 1)}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </Button>
          <Button
            isIconOnly
            size="sm"
            variant="ghost"
            aria-label="Next page"
            isDisabled={!pages.next || busy}
            onPress={() => onPage?.(page + 1)}
          >
            <ChevronRight className="size-4" aria-hidden />
          </Button>
        </div>
      </div>
      {trimmed ? (
        <p className="text-small text-muted-tertiary">
          Some rows are left out of this page to keep it small. Narrow the number to see them.
        </p>
      ) : null}
    </div>
  );
}

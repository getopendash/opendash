"use client";

import { Button } from "@heroui/react";
import type { RecordsAnswer } from "@opendash/core";
import { csvText } from "@opendash/core/csv";
import { RecordList } from "@opendash/ui";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert, CircleCheck, Download, EyeOff } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { apiQueries } from "@/lib/api";
import { hiddenWords, narrowingWords, periodWords, reconcileWords, segmentWords } from "@/lib/records-words";

type Ready = Extract<RecordsAnswer, { status: "succeeded" }>;

/** A worker reads the records, so there's a wait: asked again each second until they're in. */
const POLL_MS = 1_000;
/** Past this long in the queue, say so (BUDGETS.jobs.queuedWarningMs). */
const SLOW_MS = 15_000;

function Chip({ children, tone = "plain" }: { children: React.ReactNode; tone?: "plain" | "accent" }) {
  return (
    <span
      className={[
        "rounded-full px-2 py-0.5 text-small",
        tone === "accent" ? "bg-accent-soft text-accent-soft-foreground" : "bg-surface-secondary text-muted",
      ].join(" ")}
    >
      {children}
    </span>
  );
}

function download(view: Ready) {
  // The page as CSV: a header of the columns' labels, then each row's raw values.
  const csv = csvText(
    view.columns.map((c) => ({ name: c.label, type: c.type })),
    view.rows,
  );
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${view.metric.name}-records-page-${view.page + 1}.csv`;
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/**
 * The records behind a number: the rows a metric's figure counts, as a list under the number's own trace. Asked for by
 * the figure's query run and the row clicked (or the period and group); a worker reads them, a page at a time, and the
 * list says what they are, what narrows them, and whether they add up to the number that was clicked. Columns of
 * personal data are never listed, and the list says so.
 */
export function RecordsPanel({
  queryRunId,
  row,
  group,
  display,
  onBack,
  backLabel,
}: {
  queryRunId: string;
  /** The row of the run's result that was clicked. */
  row?: number;
  /** Or the period and dimension values. */
  group?: { time?: string; values?: Record<string, string | number | boolean | null> };
  /** The figure as it was shown ("$412.6k"), for the heading. */
  display?: string;
  onBack: () => void;
  backLabel: string;
}) {
  const [page, setPage] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const [waited, setWaited] = useState(false);
  const input = { queryRunId, ...(row !== undefined ? { row } : {}), ...(group ? { group } : {}), page };
  const query = useQuery({
    ...apiQueries.queries.records.queryOptions({ input }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.status === "queued" ? POLL_MS : false),
    // A failed answer is a result, not a transport error: don't retry it into a second queue.
    retry: false,
  });
  const data = query.data;
  const queued = data?.status === "queued" || (query.isPending && !data);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  useEffect(() => {
    setWaited(false);
    if (!queued) return;
    const t = setTimeout(() => setWaited(true), SLOW_MS);
    return () => clearTimeout(t);
  }, [queued]);

  const ready = data?.status === "succeeded" ? data : null;
  const busy = query.isPlaceholderData || (query.isFetching && Boolean(ready) && data?.status === "queued");
  const reconcile = useMemo(
    () =>
      ready
        ? reconcileWords({
            kind: ready.kind,
            matches: ready.matches,
            total: ready.total,
            value: ready.value,
            expected: ready.expected,
            noun: ready.noun,
            valueColumn: ready.valueColumn,
            format: ready.metric.format,
          })
        : null,
    [ready],
  );

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <button
        type="button"
        onClick={onBack}
        className="flex w-fit items-center gap-1.5 text-small text-muted hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" aria-hidden />
        {backLabel}
      </button>

      <div className="flex flex-col gap-1">
        <h2 ref={heading} tabIndex={-1} className="text-number-lg tabular-nums outline-none">
          {ready
            ? `${ready.total.toLocaleString("en-US")} ${ready.noun}`
            : display
              ? `Records of ${display}`
              : "Records"}
        </h2>
        <span className="text-small text-muted-tertiary">
          {ready ? `Behind ${ready.metric.label}` : "The rows behind this number"}
        </span>
      </div>

      {data?.status === "failed" ? (
        <div role="alert" className="flex flex-col gap-3 rounded-lg border border-border p-3">
          <p className="flex items-start gap-2 text-body">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
            <span>{data.message}</span>
          </p>
          {data.busy ? (
            <Button size="sm" variant="secondary" className="w-fit" onPress={() => void query.refetch()}>
              Try again
            </Button>
          ) : null}
        </div>
      ) : null}

      {queued && !ready ? (
        <p className="text-small text-muted" role="status">
          Reading the records…
          {waited ? " The worker is taking a while to pick this up." : ""}
        </p>
      ) : null}

      {ready ? (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {periodWords(ready.range, ready.grain) ? (
              <Chip tone="accent">{periodWords(ready.range, ready.grain)}</Chip>
            ) : null}
            {narrowingWords(ready).map((w) => (
              <Chip key={w}>{w}</Chip>
            ))}
            {ready.segments.map((s) => (
              <Chip key={s.name}>{segmentWords(s)}</Chip>
            ))}
          </div>

          {reconcile ? (
            <p className="flex items-start gap-2 text-small text-muted" role="status">
              {reconcile.ok ? (
                <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden />
              ) : (
                <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
              )}
              <span>{reconcile.text}</span>
            </p>
          ) : ready.kind === "other" && ready.value !== null ? (
            <p className="text-small text-muted">
              This number is a calculation over these {ready.noun}: together they give{" "}
              {ready.value.toLocaleString("en-US", { maximumFractionDigits: 2 })}.
            </p>
          ) : null}
          {ready.kind === "distinct" ? (
            <p className="text-small text-muted-tertiary">Each is listed once, however many rows it has behind it.</p>
          ) : null}
          {ready.snapshot ? (
            <p className="text-small text-muted-tertiary">
              Each row is as it stood at the end of the period, not a total of its days.
            </p>
          ) : null}

          <RecordList
            columns={ready.columns}
            rows={ready.rows}
            page={ready.page}
            pageSize={ready.pageSize}
            total={ready.total}
            cap={ready.cap}
            noun={ready.noun}
            label={`The ${ready.noun} behind ${ready.metric.label}`}
            busy={busy}
            trimmed={ready.trimmed}
            onPage={setPage}
          />

          <div className="flex flex-wrap items-center justify-between gap-2">
            {ready.hidden.length ? (
              <p className="flex items-start gap-1.5 text-small text-muted-tertiary">
                <EyeOff className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                <span>
                  {ready.hidden.length} {ready.hidden.length === 1 ? "column is" : "columns are"} hidden: personal data
                  ({hiddenWords(ready.hidden).join(", ")}).
                </span>
              </p>
            ) : (
              <span />
            )}
            {ready.rows.length ? (
              <Button size="sm" variant="ghost" onPress={() => download(ready)}>
                <Download className="size-4" aria-hidden />
                Download this page
              </Button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

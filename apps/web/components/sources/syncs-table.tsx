"use client";

import type { SchemaDiff, SyncRunView } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { useMemo } from "react";
import { count, dataTime } from "@/lib/format";
import { StepIcon } from "./check-row";

type Run = SyncRunView & { diff: SchemaDiff | null; now: number };

/** "No schema changes", "1 table added · 2 columns removed", or the reason a run failed. */
function changes(r: Run): string {
  if (r.status === "failed") return r.message ?? "Failed";
  if (r.status !== "succeeded") return "Learning now…";
  const d = r.diff ?? {};
  if (!r.diff || Object.keys(d).length === 0) return `First sync · ${count(r.facts.tables ?? 0, "table")}`;
  const parts = [
    d.addedTables?.length ? `${count(d.addedTables.length, "table")} added` : "",
    d.removedTables?.length ? `${count(d.removedTables.length, "table")} removed` : "",
    d.addedColumns?.length
      ? `${count(d.addedColumns.length, "column")} added${d.addedColumns.length === 1 ? ` (${d.addedColumns[0]})` : ""}`
      : "",
    d.removedColumns?.length ? `${count(d.removedColumns.length, "column")} removed` : "",
  ].filter(Boolean);
  return `${count(r.facts.tables ?? 0, "table")} · ${parts.length ? parts.join(" · ") : "no schema changes"}`;
}

/** "4s", "3m 12s". */
function duration(r: Run): string {
  if (!r.startedAt || !r.finishedAt) return "";
  const s = Math.max(0, Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

const OUTCOME = { succeeded: "Succeeded", failed: "Failed", running: "Running", queued: "Queued" } as const;

const col = dataColumns<Run>();
const columns = col.columns([
  col.accessor("createdAt", {
    header: "Started",
    meta: { rowHeader: true, className: "whitespace-nowrap" },
    cell: ({ row: { original: r } }) => (
      <span className="flex items-center gap-2.5">
        <StepIcon status={r.status === "succeeded" ? "ok" : r.status === "failed" ? "fail" : "running"} />
        {dataTime(r.createdAt, r.now)}
      </span>
    ),
  }),
  col.accessor("status", {
    header: "Outcome",
    enableSorting: false,
    meta: { className: "whitespace-nowrap font-medium" },
    cell: ({ getValue }) => OUTCOME[getValue()],
  }),
  col.display({
    id: "changes",
    header: "What changed",
    meta: { className: "w-full text-muted" },
    cell: ({ row: { original: r } }) => changes(r),
  }),
  col.display({
    id: "duration",
    header: "Took",
    meta: { align: "end", className: "hidden whitespace-nowrap tabular-nums @xl/page:table-cell" },
    cell: ({ row: { original: r } }) => duration(r),
  }),
]);

/** Recent syncs: the latest learning runs, with what each changed in the schema. */
export function SyncsTable({ runs, now }: { runs: (SyncRunView & { diff: SchemaDiff | null })[]; now: number }) {
  const data = useMemo(() => runs.map((r) => ({ ...r, now })), [runs, now]);
  const table = useDataTable({ columns, data, getRowId: (r) => r.id });
  return <DataTable table={table} label="Recent syncs" variant="plain" />;
}

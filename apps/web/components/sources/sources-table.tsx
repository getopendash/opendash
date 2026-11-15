"use client";

import type { SourceStatus, SourceSummary } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { useMemo } from "react";
import { ago, count, dataTime, dialectLabel } from "@/lib/format";
import { SourceMenu } from "./source-menu";
import { needsAttention, SampleDataChip, SourceStatusChip } from "./source-status";
import { SourceTile } from "./source-tile";

interface Row extends SourceSummary {
  /** Server time, so relative times render the same on server and client. */
  now: number;
  canManage: boolean;
}

/** Sorting by status puts what needs attention first. */
const STATUS_ORDER: Record<SourceStatus, number> = {
  error: 0,
  failing: 0,
  failed: 1,
  write_access: 2,
  learning: 3,
  syncing: 4,
  healthy: 5,
  disabled: 6,
};

function Freshness({ s }: { s: Row }) {
  if (s.status === "learning") return <span className="text-muted">Learning…</span>;
  if (!s.learnedAt) return <span className="text-muted">Not learned yet</span>;
  return (
    <div className="flex flex-col">
      <span>{s.dataTo ? `Data to ${dataTime(s.dataTo, s.now)}` : "No time columns"}</span>
      <span className="text-small text-muted-tertiary">
        {s.status === "syncing" ? "syncing now" : `learned ${ago(s.learnedAt, s.now)}`}
      </span>
    </div>
  );
}

function RowMenu({ s }: { s: Row }) {
  if (!s.canManage) return null;
  const canSync = s.status !== "learning" && s.status !== "syncing" && s.status !== "disabled";
  return <SourceMenu source={s} items={canSync ? ["sync", "credentials", "delete"] : ["credentials", "delete"]} />;
}

const col = dataColumns<Row>();
const columns = col.columns([
  col.accessor("name", {
    header: "Source",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: s } }) => (
      <div className="flex items-center gap-3">
        <SourceTile kind={s.dialect} />
        <div className="flex min-w-0 flex-col">
          <span className="flex items-center gap-2">
            <span className="truncate font-mono font-medium">{s.name}</span>
            {s.sample ? <SampleDataChip /> : null}
          </span>
          <span className="truncate text-small text-muted">
            {dialectLabel(s.dialect, s.serverVersion)} · {s.host}
          </span>
        </div>
      </div>
    ),
  }),
  col.accessor((s) => STATUS_ORDER[s.status], {
    id: "status",
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: s } }) => <SourceStatusChip source={s} />,
  }),
  col.accessor((s) => s.tables ?? undefined, {
    id: "tables",
    header: "Tables",
    sortUndefined: "last",
    meta: { align: "end", className: "hidden @xl/page:table-cell" },
    cell: ({ getValue }) => <span className="tabular-nums">{getValue()?.toLocaleString("en-US") ?? "—"}</span>,
  }),
  col.accessor((s) => s.dataTo ?? undefined, {
    id: "freshness",
    header: "Freshness",
    sortUndefined: "last",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ row: { original: s } }) => <Freshness s={s} />,
  }),
  col.display({
    id: "actions",
    header: () => <span className="sr-only">Actions</span>,
    meta: { align: "end" },
    cell: ({ row: { original: s } }) => <RowMenu s={s} />,
  }),
]);

/** The org's sources as a table (Tables). Each row opens the source's page. */
export function SourcesTable({
  sources,
  now,
  canManage,
}: {
  sources: SourceSummary[];
  now: number;
  canManage: boolean;
}) {
  const data = useMemo(() => sources.map((s) => ({ ...s, now, canManage })), [sources, now, canManage]);
  const table = useDataTable({ columns, data, getRowId: (s) => s.id });
  const attention = sources.filter(needsAttention).length;
  return (
    <DataTable
      table={table}
      label="Sources"
      rowHref={(s) => `/data/sources/${s.id}`}
      footer={`${count(sources.length, "source")}${attention ? ` · ${attention} ${attention === 1 ? "needs" : "need"} attention` : ""}`}
    />
  );
}

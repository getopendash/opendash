"use client";

import { Chip } from "@heroui/react";
import type { VerifiedQuerySummary } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { Sigma } from "lucide-react";
import { shortDate } from "@/lib/format";

type Row = VerifiedQuerySummary & { verifiedByName: string | null; metricTitles: string[] };

const c = dataColumns<Row>();
const columns = c.columns([
  c.accessor("question", {
    header: "Question",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: v } }) => (
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{v.question}</span>
        {v.phrasings.length ? (
          <span className="truncate text-small text-muted-tertiary">Also: {v.phrasings.join(" · ")}</span>
        ) : null}
      </div>
    ),
  }),
  c.accessor((v) => v.metricTitles.join(", "), {
    id: "computes",
    header: "Computes",
    meta: { className: "hidden whitespace-nowrap @4xl/page:table-cell" },
    cell: ({ row: { original: v } }) => (
      <span className="flex items-center gap-1.5">
        {v.metricTitles.map((m) => (
          <Chip key={m} size="sm" variant="soft" color="accent" className="gap-1">
            <Sigma className="size-3" aria-hidden />
            {m}
          </Chip>
        ))}
        {v.dimensions.length ? <span className="text-small text-muted">by {v.dimensions.join(", ")}</span> : null}
      </span>
    ),
  }),
  c.accessor("usageCount", {
    header: "Guided",
    meta: { align: "end", className: "whitespace-nowrap tabular-nums" },
  }),
  c.accessor((v) => v.verifiedByName ?? "", {
    id: "by",
    header: "Verified by",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-muted">{getValue() || "—"}</span>,
  }),
  c.accessor("updatedAt", {
    header: "Updated",
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ getValue }) => <span className="text-muted">{shortDate(getValue())}</span>,
  }),
]);

/** The verified queries. */
export function VerifiedTable({ items }: { items: Row[] }) {
  const table = useDataTable({ columns, data: items, getRowId: (v) => v.id });
  const guided = items.reduce((s, v) => s + v.usageCount, 0);
  return (
    <DataTable
      table={table}
      label="Verified queries"
      rowHref={(v) => `/knowledge/verified/${v.id}`}
      footer={`${items.length} ${items.length === 1 ? "verified query" : "verified queries"} · guided ${guided} ${guided === 1 ? "answer" : "answers"}`}
    />
  );
}

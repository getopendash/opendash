"use client";

import type { ContextSummary } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { ListChecks } from "lucide-react";
import { useMemo } from "react";
import { shortDate } from "@/lib/format";
import { ContextStatus } from "./context-tables";

type Row = ContextSummary & { followed: number };

const col = dataColumns<Row>();
const columns = col.columns([
  col.accessor("title", {
    header: "Skill",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: s } }) => (
      <span className="flex min-w-0 items-start gap-2.5">
        <ListChecks className="mt-0.5 size-4 shrink-0 text-muted" aria-hidden />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{s.title}</span>
          <span className="truncate text-small text-muted-tertiary">{s.summary}</span>
        </span>
      </span>
    ),
  }),
  col.accessor((s) => s.useWhen ?? "", {
    id: "useWhen",
    header: "Use it when",
    meta: { className: "hidden min-w-64 max-w-80 @4xl/page:table-cell" },
    cell: ({ getValue }) => <span className="line-clamp-2 text-small text-muted">{getValue()}</span>,
  }),
  col.accessor("followed", {
    header: "Answers",
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ getValue }) =>
      getValue() ? <span className="tabular-nums">{getValue()}</span> : <span className="text-muted-tertiary">—</span>,
  }),
  col.accessor("status", {
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: s } }) => <ContextStatus c={s} />,
  }),
  col.accessor("updatedAt", {
    header: "Updated",
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ getValue }) => <span className="text-muted">{shortDate(getValue())}</span>,
  }),
]);

/** The skills, each with when to use it and how many answers followed it in the last 30 days. */
export function SkillsTable({ items }: { items: Row[] }) {
  const data = useMemo(() => items, [items]);
  const table = useDataTable({ columns, data, getRowId: (s) => s.id });
  const drafts = items.filter((s) => s.status !== "verified").length;
  return (
    <DataTable
      table={table}
      label="Skills"
      rowHref={(s) => `/knowledge/skills/${s.id}`}
      footer={`${items.length} ${items.length === 1 ? "skill" : "skills"}${drafts ? ` · ${drafts} ${drafts === 1 ? "draft" : "drafts"}` : ""} · answers in the last 30 days`}
    />
  );
}

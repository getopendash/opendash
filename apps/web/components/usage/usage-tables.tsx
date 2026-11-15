"use client";

import type { UsageRow } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { costLabel, tokens } from "@/lib/format";

type Day = UsageRow & { day: string };
type Model = UsageRow & { model: string; keySource: "org" | "deployment"; price: string | null };

const dayLabel = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const end = { align: "end" as const, className: "whitespace-nowrap tabular-nums" };
const d = dataColumns<Day>();
const dayColumns = d.columns([
  d.accessor("day", {
    header: "Day",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ getValue }) => <span className="font-medium">{dayLabel.format(new Date(`${getValue()}T00:00:00Z`))}</span>,
  }),
  d.accessor("questions", { header: "Questions", meta: end }),
  d.accessor("calls", { header: "Model calls", meta: end }),
  d.accessor("tokens", { header: "Tokens", meta: end, cell: ({ getValue }) => tokens(getValue()) }),
  d.accessor("costUsd", { header: "Cost", meta: end, cell: ({ row }) => costLabel(row.original) }),
]);

const m = dataColumns<Model>();
const modelColumns = m.columns([
  m.accessor("model", {
    header: "Model",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ getValue }) => <code className="font-mono text-small">{getValue()}</code>,
  }),
  m.accessor("keySource", {
    header: "Key",
    meta: { className: "whitespace-nowrap" },
    cell: ({ getValue }) => (
      <span className="text-small text-muted">{getValue() === "org" ? "Your key" : "OpenDash's key"}</span>
    ),
  }),
  m.accessor("calls", { header: "Calls", meta: end }),
  m.accessor("tokens", { header: "Tokens", meta: end, cell: ({ getValue }) => tokens(getValue()) }),
  m.accessor("costUsd", { header: "Cost", meta: end, cell: ({ row }) => costLabel(row.original) }),
  m.accessor("price", {
    header: "Price per million tokens",
    meta: { align: "end", className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ getValue }) => <span className="text-muted">{getValue() ?? "No price"}</span>,
  }),
]);

export function UsageByDay({ days, of }: { days: Day[]; of: number }) {
  const table = useDataTable({ columns: dayColumns, data: days, getRowId: (r) => r.day });
  return <DataTable table={table} label="Usage by day" footer={`${days.length} of ${of} days had questions`} />;
}

export function UsageByModel({ models }: { models: Model[] }) {
  const table = useDataTable({ columns: modelColumns, data: models, getRowId: (r) => `${r.model}:${r.keySource}` });
  return (
    <DataTable
      table={table}
      label="Usage by model"
      footer={`${models.length} ${models.length === 1 ? "model" : "models"}`}
    />
  );
}

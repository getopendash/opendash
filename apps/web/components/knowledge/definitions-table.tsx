"use client";

import type { DefinitionKind, DefinitionSummary } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { Sigma, Table2 } from "lucide-react";
import { useMemo } from "react";
import { shortDate } from "@/lib/format";
import { DefinitionStatusChip } from "./definition-status";

interface Row extends DefinitionSummary {
  /** Labels of datasets by ref, for a metric's Dataset column. */
  datasetLabel: string | null;
}

const col = dataColumns<Row>();

const name = col.accessor("title", {
  header: "Name",
  meta: { rowHeader: true, className: "w-full" },
  cell: ({ row: { original: d } }) => (
    <div className="flex min-w-0 items-center gap-2.5">
      {d.kind === "metric" ? (
        <Sigma className="size-4 shrink-0 text-muted" aria-hidden />
      ) : (
        <Table2 className="size-4 shrink-0 text-muted" aria-hidden />
      )}
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{d.title}</span>
        <span className="truncate font-mono text-small text-muted-tertiary">{d.slug}</span>
      </div>
    </div>
  ),
});
const status = col.accessor("status", {
  header: "Status",
  meta: { className: "whitespace-nowrap" },
  cell: ({ row: { original: d } }) => <DefinitionStatusChip status={d.status} />,
});
const source = col.accessor("connectionName", {
  header: "Source",
  meta: { className: "hidden whitespace-nowrap @4xl/page:table-cell" },
  cell: ({ getValue }) => <span className="font-mono text-small text-muted">{getValue()}</span>,
});
const updated = col.accessor("updatedAt", {
  header: "Updated",
  meta: { align: "end", className: "whitespace-nowrap" },
  cell: ({ getValue }) => <span className="text-muted">{shortDate(getValue())}</span>,
});

const COLUMNS = {
  dataset: col.columns([
    name,
    col.accessor("grain", {
      header: "Grain",
      meta: { className: "hidden min-w-64 text-muted @2xl/page:table-cell" },
      cell: ({ getValue }) => <span className="line-clamp-2">{getValue()}</span>,
    }),
    col.accessor("measures", { header: "Measures", meta: { align: "end", className: "tabular-nums" } }),
    status,
    source,
    updated,
  ]),
  metric: col.columns([
    name,
    col.accessor("datasetLabel", {
      header: "Dataset",
      meta: { className: "hidden whitespace-nowrap text-muted @2xl/page:table-cell" },
    }),
    status,
    source,
    updated,
  ]),
};

/** A kind's definitions as a table; each row opens its page. */
export function DefinitionsTable({
  kind,
  definitions,
  datasets,
}: {
  kind: DefinitionKind;
  definitions: DefinitionSummary[];
  /** Every dataset, so a metric's row can name its dataset. */
  datasets: DefinitionSummary[];
}) {
  const data = useMemo(
    () =>
      definitions.map((d) => ({
        ...d,
        datasetLabel:
          datasets.find((x) => x.slug === d.dataset && x.connectionId === d.connectionId)?.title ?? d.dataset,
      })),
    [definitions, datasets],
  );
  const table = useDataTable({ columns: COLUMNS[kind], data, getRowId: (d) => d.id });
  const noun = kind === "metric" ? "metric" : "dataset";
  return (
    <DataTable
      table={table}
      label={kind === "metric" ? "Metrics" : "Datasets"}
      rowHref={(d) => `/knowledge/${kind === "metric" ? "metrics" : "datasets"}/${d.id}`}
      footer={`${definitions.length.toLocaleString("en-US")} ${definitions.length === 1 ? noun : `${noun}s`}`}
      empty={<p className="py-8 text-center text-body text-muted">No {noun}s yet.</p>}
    />
  );
}

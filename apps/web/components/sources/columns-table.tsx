"use client";

import { Button, Chip, SearchField, Switch, Tooltip, toast } from "@heroui/react";
import type { CatalogColumn } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { useMemo, useOptimistic, useState, useTransition } from "react";
import { setColumnPersonal } from "@/app/(app)/data/sources/actions";

interface Row extends CatalogColumn {
  sourceId: string;
  canManage: boolean;
}

/** The detected roles as chips (the catalog's "Detected as"): Key, Join → accounts, Cents, Category · 4 values, Time… */
function Roles({ c }: { c: Row }) {
  const chips: { label: string; tone?: "warning" | "danger"; title?: string }[] = [];
  if (c.roles.includes("key")) chips.push({ label: "Key" });
  if (c.references) {
    chips.push({
      label: `Join → ${c.references.table}`,
      title: c.references.declared
        ? `Declared foreign key to ${c.references.schema}.${c.references.table}.${c.references.column}`
        : `${Math.round(c.references.overlap * 100)}% of values match ${c.references.table}.${c.references.column}`,
    });
  }
  if (c.roles.includes("amount_cents")) chips.push({ label: "Cents" });
  // Personal and secret columns aren't categories or free text (profiling drops those roles on the next sync).
  const hidden = c.sensitivity !== "none";
  if (c.roles.includes("category") && !hidden) {
    chips.push({ label: c.ndv ? `Category · ${c.ndv.toLocaleString("en-US")} distinct` : "Category" });
  }
  if (c.roles.includes("time")) chips.push({ label: "Time" });
  if (c.roles.includes("free_text") && !hidden) chips.push({ label: "Free text" });
  if (c.sensitivity === "secret") chips.push({ label: "Secret", tone: "danger" });
  else if (c.sensitivity === "pii") {
    chips.push({ label: "Personal data", tone: "warning", title: c.sensitivityReason ?? "Marked by an admin" });
  }
  if (!chips.length) return <span className="text-muted-tertiary">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {chips.map((chip) =>
        chip.title ? (
          <Tooltip key={chip.label} delay={300}>
            <Tooltip.Trigger>
              <Chip size="sm" variant="soft" color={chip.tone ?? "default"}>
                {chip.label}
              </Chip>
            </Tooltip.Trigger>
            <Tooltip.Content>{chip.title}</Tooltip.Content>
          </Tooltip>
        ) : (
          <Chip key={chip.label} size="sm" variant="soft" color={chip.tone ?? "default"}>
            {chip.label}
          </Chip>
        ),
      )}
    </span>
  );
}

/** The admin's personal-data switch; read-only text for everyone else, and for secrets. */
function Personal({ c }: { c: Row }) {
  const [pending, start] = useTransition();
  const [personal, setPersonal] = useOptimistic(c.sensitivity !== "none");
  if (c.sensitivity === "secret") return <span className="text-muted">Always hidden</span>;
  if (!c.canManage) return <span className={personal ? "" : "text-muted-tertiary"}>{personal ? "Yes" : "—"}</span>;
  return (
    <Switch
      size="sm"
      isSelected={personal}
      isDisabled={pending}
      aria-label={`${c.name} is personal data`}
      onChange={(next) =>
        start(async () => {
          setPersonal(next);
          const result = await setColumnPersonal(c.sourceId, c.id, next);
          if (result?.message) toast.danger(result.message);
        })
      }
    >
      <Switch.Content>
        <Switch.Control>
          <Switch.Thumb />
        </Switch.Control>
      </Switch.Content>
    </Switch>
  );
}

const col = dataColumns<Row>();
const columns = col.columns([
  col.accessor("name", {
    header: "Column",
    meta: { rowHeader: true },
    cell: ({ row: { original: c } }) => (
      <div className="flex min-w-0 max-w-56 flex-col">
        <span className="truncate font-mono">{c.name}</span>
        {c.comment ? <span className="truncate text-small text-muted-tertiary">{c.comment}</span> : null}
      </div>
    ),
  }),
  col.accessor("dataType", {
    header: "Type",
    enableSorting: false,
    meta: { className: "hidden whitespace-nowrap text-muted @2xl/page:table-cell" },
    cell: ({ getValue }) => getValue() ?? "—",
  }),
  col.display({
    id: "roles",
    header: "Detected as",
    meta: { className: "w-full" },
    cell: ({ row: { original: c } }) => <Roles c={c} />,
  }),
  col.accessor((c) => (c.sensitivity === "none" ? 0 : 1), {
    id: "personal",
    header: "Personal data",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: c } }) => <Personal c={c} />,
  }),
  col.accessor("queries", {
    id: "queries",
    header: "Queries",
    meta: { className: "hidden whitespace-nowrap text-right tabular-nums @4xl/page:table-cell" },
    // Runs of the team's own queries that read it, from the source's query history.
    cell: ({ getValue }) =>
      getValue() ? <span>{getValue().toLocaleString("en-US")}</span> : <span className="text-muted-tertiary">—</span>,
  }),
]);

/** How many columns a table draws at first: a warehouse table can have hundreds, and every row is interactive. */
const PAGE = 100;

/**
 * The catalog's column table for one table (Tables). A wide table draws its first hundred columns, with a filter by
 * name and the rest on request.
 */
export function ColumnsTable({
  sourceId,
  columns: rows,
  canManage,
}: {
  sourceId: string;
  columns: CatalogColumn[];
  canManage: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const term = filter.trim().toLowerCase();
  const data = useMemo(
    () =>
      rows
        .filter((c) => !term || c.name.toLowerCase().includes(term) || c.comment?.toLowerCase().includes(term))
        .map((c) => ({ ...c, sourceId, canManage })),
    [rows, term, sourceId, canManage],
  );
  const table = useDataTable({ columns, data, getRowId: (c) => c.id });
  const wide = rows.length > PAGE;
  const rest = data.length - shown;
  return (
    <div className="flex flex-col gap-2">
      {wide ? (
        <SearchField
          aria-label="Filter columns"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            setShown(PAGE);
          }}
          className="max-w-72"
        >
          <SearchField.Group>
            <SearchField.SearchIcon />
            <SearchField.Input placeholder={`Filter ${rows.length.toLocaleString("en-US")} columns`} />
            <SearchField.ClearButton />
          </SearchField.Group>
        </SearchField>
      ) : null}
      <DataTable
        table={table}
        label="Columns"
        variant="plain"
        maxRows={shown}
        empty={<span className="text-muted">No column matches.</span>}
      />
      {rest > 0 ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted-tertiary">
          <span>
            Showing {shown.toLocaleString("en-US")} of {data.length.toLocaleString("en-US")} columns
          </span>
          <Button size="sm" variant="ghost" onPress={() => setShown((n) => n + PAGE)}>
            Show {Math.min(PAGE, rest).toLocaleString("en-US")} more
          </Button>
          {rest > PAGE ? (
            <Button size="sm" variant="ghost" onPress={() => setShown(data.length)}>
              Show all
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

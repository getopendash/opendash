"use client";

import { SearchField } from "@heroui/react";
import type { CatalogTreeSchema } from "@opendash/core";
import { ChevronRight, Eye, Folder, Table2 } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { compact } from "@/lib/format";

/** The catalog's left pane: schemas and their tables, filtered by name. The selected table is a link target (?table=). */
export function CatalogTree({
  sourceId,
  schemas,
  selectedId,
}: {
  sourceId: string;
  schemas: CatalogTreeSchema[];
  selectedId: string | null;
}) {
  const [filter, setFilter] = useState("");
  const selectedSchema = schemas.find((s) => s.tables.some((t) => t.id === selectedId))?.id;
  const [open, setOpen] = useState<Set<string>>(() => new Set(selectedSchema ? [selectedSchema] : []));
  const term = filter.trim().toLowerCase();
  const shown = useMemo(
    () =>
      schemas
        .map((s) => ({
          ...s,
          tables: term ? s.tables.filter((t) => `${s.name}.${t.name}`.toLowerCase().includes(term)) : s.tables,
        }))
        .filter((s) => !term || s.tables.length > 0),
    [schemas, term],
  );
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <nav aria-label="Tables" className="flex flex-col gap-2">
      <SearchField aria-label="Filter tables" value={filter} onChange={setFilter} fullWidth>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Filter tables" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>
      <ul className="flex flex-col">
        {shown.map((schema) => {
          const expanded = term !== "" || open.has(schema.id);
          return (
            <li key={schema.id}>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => toggle(schema.id)}
                className="group flex h-7.5 w-full items-center gap-2 rounded-lg px-2 text-body hover:bg-default"
              >
                <ChevronRight
                  className="size-3.5 text-muted-tertiary transition-transform group-aria-expanded:rotate-90"
                  aria-hidden
                />
                <Folder className="size-3.5 text-muted" aria-hidden />
                <span className="flex-1 truncate text-left font-mono">{schema.name}</span>
                <span className="text-small text-muted-tertiary tabular-nums">{schema.tables.length}</span>
              </button>
              {/* Mounted only while open (a schema can hold hundreds of tables): its tables fade in. */}
              {expanded ? (
                <ul className="enter-fade flex flex-col">
                  {schema.tables.map((table) => {
                    const selected = table.id === selectedId;
                    const Icon = table.kind === "view" ? Eye : Table2;
                    return (
                      <li key={table.id}>
                        <Link
                          href={`/data/sources/${sourceId}/catalog?table=${table.id}`}
                          scroll={false}
                          aria-current={selected ? "page" : undefined}
                          className={`flex h-7.5 items-center gap-2 rounded-lg ps-8 pe-2 text-body ${
                            selected ? "bg-default font-medium" : "hover:bg-default"
                          }`}
                        >
                          <Icon className="size-3.5 shrink-0 text-muted" aria-hidden />
                          <span className="flex-1 truncate font-mono">{table.name}</span>
                          {table.rows !== null ? (
                            <span className="text-small text-muted-tertiary tabular-nums">{compact(table.rows)}</span>
                          ) : null}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </li>
          );
        })}
        {shown.length === 0 ? <li className="px-2 py-3 text-small text-muted">No table matches.</li> : null}
      </ul>
    </nav>
  );
}

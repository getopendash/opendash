"use client";

import { Chip } from "@heroui/react";
import type { ThreadListing } from "@opendash/api";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { type ReactNode, useMemo } from "react";
import { whenGroup } from "@/lib/ask-filters";
import { ago } from "@/lib/format";
import { threadStatus } from "@/lib/thread-status";
import { StarButton } from "./star-button";

interface Row extends ThreadListing {
  now: number;
  /** The project's name, when the viewer can see the project. */
  projectName: string | null;
}

const TONE = { default: "default", running: "accent", warn: "warning", danger: "danger" } as const;

const col = dataColumns<Row>();
const columns = col.columns([
  // Grouped on, not shown: Today, Yesterday, Previous 7 days…
  col.accessor((t) => whenGroup(t.lastMessageAt ?? t.createdAt, t.now), { id: "when", header: "When" }),
  col.accessor("starred", {
    header: () => <span className="sr-only">Starred</span>,
    meta: { className: "w-11 pr-0" },
    cell: ({ row: { original: t } }) => <StarButton id={t.id} title={t.title} starred={t.starred} />,
  }),
  col.accessor("title", {
    header: "Question",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ row: { original: t } }) => (
      <div className="flex min-w-0 flex-col">
        <span className="truncate">{t.title}</span>
        <span className="truncate text-small text-muted-tertiary">
          <span className="font-mono">{t.sourceName}</span>
          {t.channel === "slack" ? " · From Slack" : null}
        </span>
      </div>
    ),
  }),
  col.accessor((t) => t.projectName ?? "", {
    id: "project",
    header: "Project",
    meta: { className: "hidden whitespace-nowrap @4xl/page:table-cell" },
    cell: ({ row: { original: t } }) =>
      t.projectName ? (
        <Chip size="sm" variant="soft">
          {t.projectName}
        </Chip>
      ) : (
        <span className="text-muted-tertiary">—</span>
      ),
  }),
  col.accessor((t) => threadStatus(t).label, {
    id: "status",
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: t } }) => {
      const s = threadStatus(t);
      return (
        <Chip size="sm" variant="soft" color={TONE[s.tone]}>
          {s.label}
        </Chip>
      );
    },
  }),
  col.accessor((t) => (t.mine ? "You" : (t.author ?? "Someone in your team")), {
    id: "asked",
    header: "Asked by",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
  }),
  col.accessor((t) => t.lastMessageAt ?? t.createdAt, {
    id: "updated",
    header: "Updated",
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ row: { original: t } }) => (
      <span className="text-muted">{ago(t.lastMessageAt ?? t.createdAt, t.now)}</span>
    ),
  }),
]);

/** A page of the conversations the viewer can see, newest first, grouped by day; each row opens it. */
export function ThreadsTable({
  threads,
  projects,
  now,
  footer,
}: {
  threads: ThreadListing[];
  projects: { id: string; name: string }[];
  now: number;
  footer: ReactNode;
}) {
  const data = useMemo(() => {
    const names = new Map(projects.map((p) => [p.id, p.name]));
    return threads.map((t) => ({ ...t, now, projectName: t.projectId ? (names.get(t.projectId) ?? null) : null }));
  }, [threads, projects, now]);
  const table = useDataTable({
    columns,
    data,
    getRowId: (t) => t.id,
    groupedColumnMode: "remove",
    initialState: { grouping: ["when"], expanded: true },
  });
  return <DataTable table={table} label="Conversations" rowHref={(t) => `/ask/${t.id}`} footer={footer} />;
}

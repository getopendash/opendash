"use client";

import { Button, Chip, toast } from "@heroui/react";
import type { ContextSummary } from "@opendash/core";
import { DataTable, dataColumns, StatusBadge, useDataTable } from "@opendash/ui";
import { Pin, ShieldCheck, Sigma, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useTransition } from "react";
import { approveContextAction } from "@/app/(app)/knowledge/context-actions";
import { shortDate } from "@/lib/format";

/** A term's or guide's status: verified, proposed by the starter pack, or a draft (of the next version, if one's out). */
export const ContextStatus = ({ c }: { c: Pick<ContextSummary, "status" | "version" | "releasedVersion"> }) =>
  c.status === "verified" ? (
    <StatusBadge status="verified" />
  ) : c.status === "proposed" ? (
    <Chip size="sm" variant="soft" color="accent" className="gap-1">
      <Sparkles className="size-3" aria-hidden />
      Proposed
    </Chip>
  ) : (
    <Chip size="sm" variant="soft">
      {c.releasedVersion ? `Draft of v${c.version}` : "Draft"}
    </Chip>
  );

/** What a term maps to in the data: a column condition, or a verified metric. */
export function MapsTo({ m }: { m: ContextSummary["mapsTo"] }) {
  if (!m) return <span className="text-muted-tertiary">—</span>;
  if (m.metric) {
    return (
      <Chip size="sm" variant="soft" color="accent" className="gap-1">
        <Sigma className="size-3" aria-hidden />
        {m.metric}
      </Chip>
    );
  }
  if (m.column) {
    const column = m.column.split(".").slice(1).join(".");
    const values = m.values ?? [];
    return (
      <code className="rounded-md border border-border bg-surface-secondary px-1.5 py-0.5 font-mono text-small">
        {values.length === 1
          ? `${column} = '${values[0]}'`
          : values.length
            ? `${column} in (${values.map((v) => `'${v}'`).join(", ")})`
            : column}
      </code>
    );
  }
  return <span className="text-small text-muted">{m.note}</span>;
}

const terms = dataColumns<ContextSummary>();
const termColumns = terms.columns([
  terms.accessor("title", {
    header: "Term",
    meta: { rowHeader: true },
    cell: ({ row: { original: t } }) => (
      <div className="flex min-w-0 flex-col">
        <span className="font-medium">{t.title}</span>
        {t.synonyms.length ? (
          <span className="truncate text-small text-muted-tertiary">Also: {t.synonyms.join(", ")}</span>
        ) : null}
      </div>
    ),
  }),
  terms.accessor("summary", {
    header: "Means",
    meta: { className: "w-full" },
    cell: ({ getValue }) => <span className="line-clamp-2 text-muted">{getValue()}</span>,
  }),
  terms.accessor((t) => t.mapsTo?.column ?? t.mapsTo?.metric ?? "", {
    id: "maps",
    header: "Maps to",
    meta: { className: "hidden whitespace-nowrap @4xl/page:table-cell" },
    cell: ({ row: { original: t } }) => <MapsTo m={t.mapsTo} />,
  }),
  terms.accessor("status", {
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: t } }) => <ContextStatus c={t} />,
  }),
  terms.accessor("updatedAt", {
    header: "Updated",
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ getValue }) => <span className="text-muted">{shortDate(getValue())}</span>,
  }),
]);

const guides = dataColumns<ContextSummary & { sources: Record<string, string> }>();
const guideColumns = guides.columns([
  guides.accessor("title", {
    header: "Guide",
    // max-w-0 lets the column take what's left and its text truncate, however long a guide's title or first line.
    meta: { rowHeader: true, className: "w-full max-w-0" },
    cell: ({ row: { original: g } }) => (
      <div className="flex min-w-0 flex-col">
        <span className="flex min-w-0 items-center gap-1.5 font-medium">
          <span className="truncate">{g.title}</span>
          {g.pinned ? <Pin className="size-3.5 shrink-0 text-accent" aria-label="Pinned" /> : null}
        </span>
        <span className="truncate text-small text-muted-tertiary">
          {g.fromCorrection ? "From a correction on an answer · " : ""}
          {g.summary}
        </span>
      </div>
    ),
  }),
  guides.accessor((g) => g.table ?? g.connectionId ?? "", {
    id: "applies",
    header: "Applies to",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ row: { original: g } }) =>
      g.table ? (
        <code className="font-mono text-small">{g.table}</code>
      ) : g.connectionId ? (
        <span className="font-mono text-small">{g.sources[g.connectionId] ?? "a source"}</span>
      ) : (
        <span className="text-muted">Whole workspace</span>
      ),
  }),
  guides.accessor("status", {
    header: "Status",
    meta: { className: "whitespace-nowrap" },
    cell: ({ row: { original: g } }) => <ContextStatus c={g} />,
  }),
  guides.accessor("updatedAt", {
    header: "Updated",
    meta: { align: "end", className: "whitespace-nowrap" },
    cell: ({ getValue }) => <span className="text-muted">{shortDate(getValue())}</span>,
  }),
]);

/** The glossary. */
export function TermsTable({ items }: { items: ContextSummary[] }) {
  const table = useDataTable({ columns: termColumns, data: items, getRowId: (t) => t.id });
  const proposed = items.filter((t) => t.status === "proposed").length;
  const drafts = items.filter((t) => t.status !== "verified" && t.status !== "proposed").length;
  const footer = [
    `${items.length} ${items.length === 1 ? "term" : "terms"}`,
    proposed ? `${proposed} proposed` : "",
    drafts ? `${drafts} ${drafts === 1 ? "draft" : "drafts"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return <DataTable table={table} label="Glossary" rowHref={(t) => `/knowledge/glossary/${t.id}`} footer={footer} />;
}

/** The guides. */
export function GuidesTable({ items, sources }: { items: ContextSummary[]; sources: Record<string, string> }) {
  const data = useMemo(() => items.map((g) => ({ ...g, sources })), [items, sources]);
  const table = useDataTable({ columns: guideColumns, data, getRowId: (g) => g.id });
  return (
    <DataTable
      table={table}
      label="Guides"
      rowHref={(g) => `/knowledge/guides/${g.id}`}
      footer={`${items.length} ${items.length === 1 ? "guide" : "guides"} · ${items.filter((g) => g.pinned).length} pinned`}
    />
  );
}

/** "Approve N proposed": the starter glossary's terms, each at the version shown. */
export function ApproveProposed({ items }: { items: ContextSummary[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const proposed = items.filter((t) => t.status === "proposed");
  if (!proposed.length) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      isPending={pending}
      onPress={() =>
        start(async () => {
          const r = await approveContextAction(proposed.map((t) => ({ id: t.id, version: t.version })));
          if ("message" in r) toast.danger(r.message);
          else toast.success(`Approved ${r.approved} ${r.approved === 1 ? "term" : "terms"}.`);
          router.refresh();
        })
      }
    >
      <ShieldCheck className="size-3.5" aria-hidden />
      Approve {proposed.length} proposed
    </Button>
  );
}

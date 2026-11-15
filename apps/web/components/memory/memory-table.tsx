"use client";

import { Button, toast } from "@heroui/react";
import type { Memory } from "@opendash/core";
import { DataTable, dataColumns, useDataTable } from "@opendash/ui";
import { Bookmark, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { forgetAction } from "@/app/(app)/knowledge/memory/actions";
import { shortDate } from "@/lib/format";

type Row = Memory & { thread: { id: string; title: string } | null };

function Forget({ id }: { id: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      isPending={pending}
      onPress={() =>
        start(async () => {
          const r = await forgetAction([id]);
          if (!r.forgotten) toast.danger("It was already forgotten.");
          router.refresh();
        })
      }
    >
      <Trash2 className="size-3.5" aria-hidden />
      Forget
    </Button>
  );
}

const c = dataColumns<Row>();
const columns = c.columns([
  c.accessor("fact", {
    header: "Remembered",
    meta: { rowHeader: true, className: "w-full" },
    cell: ({ getValue }) => (
      <span className="flex items-center gap-2.5">
        <Bookmark className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
        {getValue()}
      </span>
    ),
  }),
  c.accessor("createdAt", {
    header: "Saved",
    meta: { className: "hidden whitespace-nowrap @2xl/page:table-cell" },
    cell: ({ row: { original: m } }) => (
      <span className="text-small text-muted">
        {shortDate(m.createdAt)}
        {m.thread ? (
          <>
            {" · in "}
            <Link href={`/ask/${m.thread.id}`} className="text-link hover:underline">
              “{m.thread.title}”
            </Link>
          </>
        ) : null}
      </span>
    ),
  }),
  c.display({
    id: "forget",
    header: () => <span className="sr-only">Actions</span>,
    meta: { align: "end" },
    cell: ({ row: { original: m } }) => <Forget id={m.id} />,
  }),
]);

/** Your memories. */
export function MemoryTable({ items, kept, given }: { items: Row[]; kept: number; given: number }) {
  const table = useDataTable({ columns, data: items, getRowId: (m) => m.id });
  return (
    <DataTable
      table={table}
      label="Your memory"
      footer={`${items.length} of ${kept} · the newest ${given} go with each of your questions`}
    />
  );
}

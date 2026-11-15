"use client";

import { useQuery } from "@tanstack/react-query";
import { LayoutDashboard } from "lucide-react";
import Link from "next/link";
import { apiQueries } from "@/lib/api";

/**
 * The dashboards a conversation built, read from the dashboards themselves, so they stay listed however the
 * run that built them ended: its owner sees each with its draft, a reader the ones shared with them. A change to one is
 * asked here.
 */
export function BuiltHere({ threadId }: { threadId: string }) {
  const built = useQuery(apiQueries.dashboards.list.queryOptions({ input: { threadId } }));
  const list = built.data ?? [];
  if (!list.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-small">
      <span className="text-muted-tertiary">Built here</span>
      {list.map((d) => (
        <Link
          key={d.id}
          href={`/dashboards/${d.id}${d.draft ? "?draft=1" : ""}`}
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2 py-1 hover:bg-default"
        >
          <LayoutDashboard className="size-3.5 text-muted" aria-hidden />
          <span className="max-w-48 truncate">{d.title}</span>
          <span className="text-muted-tertiary">
            {d.draft ? (d.currentVersion ? `v${d.currentVersion} · draft` : "draft") : `v${d.currentVersion}`}
          </span>
        </Link>
      ))}
    </div>
  );
}

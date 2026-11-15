"use client";

import { Button, buttonVariants, toast } from "@heroui/react";
import type { WatchedRow } from "@opendash/core";
import { Pair } from "@opendash/ui";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { watchMetricAction } from "@/app/(app)/routines/actions";
import { TopBar } from "@/components/shell/top-bar";
import { checkLine, whenLine } from "@/lib/routine-words";
import { InsightsTabs } from "./insights-tabs";

/**
 * Insights → Watching: every metric a routine watches, how its check went, and the routines that watch it
 * (those the viewer may see, by name). Each metric is checked once a period, however many routines watch it.
 */
export function WatchingView({
  rows,
  openCount,
  tz,
  canManage,
}: {
  rows: WatchedRow[];
  openCount: number;
  tz: string;
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const stop = async (metricId: string, title: string) => {
    setPending(metricId);
    const r = await watchMetricAction(metricId, false);
    setPending(null);
    if (!r.ok) toast.danger(r.message);
    else toast.success(`Watching doesn't check ${title} any more.`);
    router.refresh();
  };
  return (
    <>
      <TopBar
        crumbs={[{ label: "Insights", href: "/insights" }, { label: "Watching" }]}
        action={
          <Link href="/routines/new" className={buttonVariants({ size: "sm", variant: "outline" })}>
            <Plus className="size-3.5" aria-hidden />
            New routine
          </Link>
        }
      />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Insights</h1>
            <p className="max-w-reading text-body text-muted">
              The metrics routines watch. Each is checked once its week or month closes, once, however many routines
              watch it. No AI is involved unless a routine investigates.
            </p>
          </div>
          <InsightsTabs tab="watching" openCount={openCount} watched={rows.length} />
          {rows.length ? (
            <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
              {rows.map((r) => {
                const line = checkLine(r, tz);
                const inWatching = r.watchers.some((w) => w.watching);
                return (
                  <li
                    key={r.metric.id}
                    className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 border-b border-border px-4 py-3 last:border-b-0"
                  >
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="text-body">{r.metric.title}</span>
                      <span className="text-small text-muted">
                        {r.grain === "month" ? "Monthly" : r.grain === "week" ? "Weekly" : "Not checked"} ·{" "}
                        {r.connectionName}
                        {r.openInsights ? (
                          <>
                            {" · "}
                            <Link href="/insights" className="text-link hover:underline">
                              {r.openInsights} open
                            </Link>
                          </>
                        ) : null}
                      </span>
                      <span className={`text-small ${line.problem ? "text-danger" : "text-muted"}`}>
                        {line.text}
                        {r.nextCheckAt ? ` · next ${whenLine(r.nextCheckAt, tz)}` : ""}
                      </span>
                    </span>
                    <span className="flex min-w-0 flex-col items-start gap-1.5 @2xl/page:items-end">
                      <span className="flex flex-wrap gap-1.5 @2xl/page:justify-end">
                        {r.watchers.map((w) => (
                          <Link
                            key={w.id}
                            href={`/routines/${w.id}`}
                            className="max-w-64 truncate rounded-md bg-accent-soft px-1.5 py-0.5 text-small text-accent-soft-foreground hover:bg-accent-soft-hover"
                          >
                            {w.label}
                          </Link>
                        ))}
                        {r.others ? (
                          <span className="rounded-md bg-surface-secondary px-1.5 py-0.5 text-small text-muted">
                            {r.others === 1 ? "1 personal routine" : `${r.others} personal routines`}
                          </span>
                        ) : null}
                      </span>
                      {canManage && inWatching ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          isPending={pending === r.metric.id}
                          onPress={() => void stop(r.metric.id, r.metric.title)}
                        >
                          Stop watching
                        </Button>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
              <Pair size={64} state="idle" />
              <p className="text-lead">Nothing is watched yet</p>
              <p className="max-w-reading text-body text-muted">
                {canManage
                  ? "Watch a metric from its dashboard tile, or make a routine that tells someone when it's unusual or crosses a line."
                  : "Make a routine that tells you when a metric is unusual or crosses a line. Your admins choose what the workspace watches."}
              </p>
              <Link href="/routines/new" className={buttonVariants({ size: "sm" })}>
                <Plus className="size-3.5" aria-hidden />
                New routine
              </Link>
            </div>
          )}
          {rows.length ? (
            <p className="text-small text-muted-tertiary">
              A week or month is first checked at 06:00, where the workspace is, the morning after it closes. Stop
              watching takes a metric off the workspace's Watching only; other routines keep theirs.
            </p>
          ) : null}
        </div>
      </div>
    </>
  );
}

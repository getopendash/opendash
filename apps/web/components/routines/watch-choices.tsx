"use client";

import { Button, buttonVariants, toast } from "@heroui/react";
import Link from "next/link";
import { useState } from "react";
import { watchMetricAction } from "@/app/(app)/routines/actions";
import { answerOf } from "@/lib/action-answer";

/** Who watches a metric: routines by name, the workspace's Watching marked, and how many more. */
export interface MetricWatch {
  watchers: { id: string; label: string; watching: boolean }[];
  others: number;
}

/**
 * What watching a verified metric offers, wherever it's offered (a dashboard's tile, an answer in Ask):
 * owners and admins keep it in Insights with one tap (the workspace's Watching); anyone sets up a routine that tells
 * them; the routines already watching it are listed (private ones counted, never named).
 */
export function WatchChoices({
  metric,
  watch,
  canManage,
  onChanged,
}: {
  metric: { id: string; title: string };
  watch: MetricWatch | undefined;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const watchers = watch?.watchers ?? [];
  const kept = watchers.some((w) => w.watching);
  const keep = async (on: boolean) => {
    setPending(true);
    const r = await answerOf(() => watchMetricAction(metric.id, on));
    setPending(false);
    if (!r.ok) toast.danger(r.message);
    else
      toast.success(on ? `${metric.title} is kept in Insights: checked as each period closes.` : "Stopped watching.");
    onChanged();
  };
  return (
    <div className="flex flex-col gap-3">
      {canManage ? (
        <div className="flex items-start justify-between gap-3">
          <span className="flex flex-col gap-0.5">
            <span className="text-body">{kept ? "Kept in Insights" : "Keep it in Insights"}</span>
            <span className="text-small text-muted">
              Checked once each period closes. What's unusual shows in Insights; nobody's told.
            </span>
          </span>
          <Button size="sm" variant={kept ? "ghost" : "primary"} isPending={pending} onPress={() => void keep(!kept)}>
            {kept ? "Stop" : "Keep"}
          </Button>
        </div>
      ) : null}
      {watchers.filter((w) => !w.watching).length || watch?.others ? (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <span className="text-small font-medium text-muted">Also watched by</span>
          {watchers
            .filter((w) => !w.watching)
            .map((w) => (
              <Link key={w.id} href={`/routines/${w.id}`} className="truncate text-small text-link hover:underline">
                {w.label}
              </Link>
            ))}
          {watch?.others ? (
            <span className="text-small text-muted">
              {watch.others === 1 ? "1 personal routine" : `${watch.others} personal routines`}
            </span>
          ) : null}
        </div>
      ) : null}
      <Link
        href={`/routines/new?metric=${metric.id}`}
        className={`${buttonVariants({ size: "sm", variant: "outline" })} justify-center`}
      >
        Set up an alert…
      </Link>
      <span className="text-small text-muted-tertiary">
        Tell you or the team when it crosses a line or is unusual: a routine.
      </span>
    </div>
  );
}

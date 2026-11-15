"use client";

import { buttonVariants } from "@heroui/react";
import type { InsightView, InvestigationView } from "@opendash/core";
import { Pair } from "@opendash/ui";
import { Plus, Radar } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/shell/top-bar";
import { InsightCard, type TraceTarget } from "./insight-card";
import { InsightTrace } from "./insight-trace";
import { InsightsTabs } from "./insights-tabs";

/** Q1: the insights feed, open or closed, with a figure's trace beside it. */
export function InsightsView({
  insights,
  investigations,
  closed,
  openCount,
  watched,
  canAsk,
  canManage,
  now,
}: {
  insights: InsightView[];
  /** Each insight's investigation, by insight. */
  investigations: Record<string, InvestigationView>;
  closed: boolean;
  openCount: number;
  /** How many metrics routines watch. */
  watched: number;
  canAsk: boolean;
  canManage: boolean;
  now: number;
}) {
  const [trace, setTrace] = useState<TraceTarget | null>(null);
  const router = useRouter();
  // While an investigation is under way, the feed looks again every few seconds for its write-up.
  const working = Object.values(investigations).some((v) => v.status === "queued" || v.status === "running");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => router.refresh(), 5_000);
    return () => clearInterval(t);
  }, [working, router]);
  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          crumbs={[{ label: "Insights" }]}
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
              <p className="text-body text-muted">
                What OpenDash noticed in your verified metrics. Every number opens the query behind it.
              </p>
            </div>
            <InsightsTabs tab={closed ? "closed" : "open"} openCount={openCount} watched={watched} />
            {insights.length ? (
              <div className="flex flex-col gap-3">
                {insights.map((i) => (
                  <InsightCard
                    key={i.id}
                    insight={i}
                    {...(investigations[i.id] ? { investigation: investigations[i.id] } : {})}
                    now={now}
                    canAsk={canAsk}
                    canDismiss={canManage || i.mine}
                    traced={trace?.insight.id === i.id ? trace : null}
                    onTrace={setTrace}
                  />
                ))}
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border px-6 py-14 text-center">
                {/* Pair: asleep while what's watched is usual, waiting while nothing is watched. */}
                {closed ? (
                  <Radar className="size-6 text-muted" aria-hidden />
                ) : (
                  <Pair size={64} state={watched ? "sleeping" : "idle"} />
                )}
                <p className="text-lead">
                  {closed ? "Nothing closed yet" : watched ? "Nothing unusual" : "Nothing is watched yet"}
                </p>
                <p className="max-w-reading text-body text-muted">
                  {closed
                    ? "Insights someone dismissed, and late data that landed, show here."
                    : watched
                      ? "Each watched metric's last week or month was judged, and nothing was outside its usual range."
                      : canManage
                        ? "Watch a metric from its dashboard tile, or make a routine that tells someone when it's unusual. Once each week or month closes, it's judged against its own history."
                        : "Make a routine that tells you when a metric is unusual. What OpenDash finds shows here."}
                </p>
                {!closed && !watched ? (
                  <Link href="/routines/new" className={buttonVariants({ size: "sm" })}>
                    <Plus className="size-3.5" aria-hidden />
                    New routine
                  </Link>
                ) : null}
              </div>
            )}
          </div>
        </div>
      </div>
      {trace ? (
        <div className="enter-slide absolute inset-0 z-40 flex bg-surface @5xl/page:static @5xl/page:z-auto">
          <InsightTrace target={trace} onClose={() => setTrace(null)} />
        </div>
      ) : null}
    </div>
  );
}

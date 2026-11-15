import type { InsightView } from "@opendash/core";
import { MessageSquare } from "lucide-react";
import Link from "next/link";
import { AskBeside } from "@/components/panel/ask-beside";
import { investigateQuestion } from "@/lib/insight-words";

const dot = (i: InsightView) =>
  i.kind === "data_quality" || i.severity >= 2 ? (i.severity >= 3 ? "bg-danger" : "bg-warning") : "bg-muted-tertiary";

/** What sits beside the value: the band, the projection and goal, or the change lately against before. */
function figureNote(i: InsightView): string {
  if (i.claims) return `expected ${i.claims.expected.display}`;
  if (i.goalRisk) return `${i.goalRisk.projected.display} projected · goal ${i.goalRisk.goal.target.display}`;
  if (i.trend) return `${i.trend.recent.display} lately · ${i.trend.before.display} before`;
  return "";
}

/** Home's What changed, the most severe open insights first; each opens the feed or an investigation. */
export function WhatChanged({ insights, canAsk }: { insights: InsightView[]; canAsk: boolean }) {
  return (
    <section className="flex flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <h2 className="flex items-baseline gap-2 text-heading">
          What changed
          <span className="text-small font-normal text-muted-tertiary">from what's watched · last whole month</span>
        </h2>
        <Link href="/insights" className="text-small text-link hover:underline">
          All insights
        </Link>
      </header>
      <ul className="flex flex-col overflow-hidden rounded-2xl border border-border bg-surface">
        {insights.map((i) => (
          <li key={i.id} className="flex min-h-10 items-center gap-2.5 border-b border-border px-3.5 last:border-b-0">
            <span aria-hidden className={`size-1.75 shrink-0 rounded-full ${dot(i)}`} />
            <Link href="/insights" className="min-w-0 flex-1 truncate py-2 text-body font-medium hover:underline">
              {i.title}
            </Link>
            {i.claims || i.goalRisk || i.trend ? (
              <span className="hidden shrink-0 items-baseline gap-2 @xl/page:flex">
                <span className="text-body font-semibold tabular-nums">
                  {(i.claims ?? i.goalRisk ?? i.trend)?.value.display}
                </span>
                <span className="text-small text-muted-tertiary">{figureNote(i)}</span>
              </span>
            ) : null}
            {(i.claims || i.goalRisk || i.trend) && canAsk ? (
              <AskBeside text={investigateQuestion(i.title)} connectionId={i.connectionId} variant="ghost">
                <MessageSquare className="size-3.5" aria-hidden />
                Ask about it
              </AskBeside>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}

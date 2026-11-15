import { askableSources, keyMetrics, listReports, listThreads } from "@opendash/core";
import { type TenantTx, withTenant } from "@opendash/db";
import { FlaskConical, GitPullRequestArrow } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { Composer } from "@/components/home/composer";
import { Goals } from "@/components/home/goals";
import { Greeting } from "@/components/home/greeting";
import { figuresOf, KeyMetrics } from "@/components/home/key-metrics";
import { MyTasks } from "@/components/home/my-tasks";
import { Recent } from "@/components/home/recent";
import { SetupChecklist } from "@/components/home/setup-checklist";
import { Suggestions } from "@/components/home/suggestions";
import { TrendCard } from "@/components/home/trend-card";
import { WhatChanged } from "@/components/home/what-changed";
import { HomePair, WritingProvider } from "@/components/home/writing";
import { TopBar } from "@/components/shell/top-bar";
import { requireTenant } from "@/lib/auth";
import { goalRow } from "@/lib/goal-rows";
import { goalsFor } from "@/lib/goals";
import { insightsFor } from "@/lib/insights";
import { canVerify } from "@/lib/knowledge";
import { canAsk } from "@/lib/roles";
import { setupProgress } from "@/lib/setup";
import { tasksFor } from "@/lib/tasks";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Home · OpenDash" };

const today = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric" });
const short = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });

/**
 * Home. First run: the composer and the setup checklist. Once there are verified metrics: their latest months as
 * tiles, the first over a year, the recent conversations, and for reviewers what waits for them.
 */
export default async function HomePage() {
  const [ws, viewer] = await Promise.all([currentWorkspace(), requireTenant()]);
  const viewing = { orgId: viewer.ctx.orgId, userId: viewer.user.id };
  const reviewer = canVerify(viewer.role);
  const asks = canAsk(viewer.role);
  const [{ sources, metrics, threads, reports }, goalList, changed, mine] = await Promise.all([
    withTenant(viewer.ctx, async (tx: TenantTx) => ({
      sources: await askableSources(tx, viewer.ctx.orgId),
      metrics: await keyMetrics(tx, viewer.ctx.orgId),
      threads: await listThreads({ withTenant: (_org, fn) => fn(tx) }, viewing, { limit: 5 }),
      reports: reviewer ? (await listReports(tx, viewing, { limit: 50 })).length : 0,
    })),
    goalsFor(viewer.ctx.orgId),
    insightsFor({ orgId: viewer.ctx.orgId, userId: viewer.user.id }, "open", 3),
    tasksFor(viewing, { status: "open", mine: true, limit: 5 }),
  ]);
  const firstName = ws.user.name.split(" ")[0] || "there";
  const progress = setupProgress(ws);
  const now = Date.now();
  // Goals whose metric is still verified; a removed one shows in Settings, not here.
  const goals = goalList.filter((g) => g.metric).map((g) => goalRow(g, now));

  if (!metrics.length) {
    return (
      <>
        <TopBar crumbs={[{ label: "Home" }]} />
        <div className="flex-1 overflow-y-auto px-6 pt-24 pb-16">
          <WritingProvider>
            <div className="mx-auto flex max-w-reading flex-col gap-7">
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-3">
                  <HomePair />
                  <Greeting name={firstName} />
                </div>
                {asks ? (
                  <p className="text-lead text-muted">
                    Ask about {ws.org.name} in plain language. Every number in an answer is checked and links to the
                    query behind it.
                  </p>
                ) : (
                  <p className="text-lead text-muted">
                    Your team's shared conversations are in{" "}
                    <Link href="/ask" className="text-link hover:underline">
                      Ask
                    </Link>
                    . Every number in them is checked and links to the query behind it.
                  </p>
                )}
              </div>
              {asks ? <Composer org={ws.org.name} hasData={ws.sources > 0} sources={sources} /> : null}
              {reviewer ? <SetupChecklist progress={progress} /> : null}
            </div>
          </WritingProvider>
        </div>
      </>
    );
  }

  const [lead] = metrics;
  const sample = sources.some((s) => s.sample);
  const leadFigures = lead ? figuresOf(lead) : null;
  const waiting = [
    ws.definitions.proposed ? `${ws.definitions.proposed} definitions to review` : null,
    reports ? `${reports} ${reports === 1 ? "report" : "reports"} on answers` : null,
  ].filter(Boolean);
  return (
    <>
      <TopBar crumbs={[{ label: "Home" }]} />
      <div className="flex-1 overflow-y-auto px-8 pt-6 pb-16">
        <WritingProvider>
          <div className="flex flex-col gap-7">
            {sample ? (
              <div className="flex items-center gap-2 rounded-xl bg-accent-soft px-3.5 py-2 text-body text-accent-soft-foreground">
                <FlaskConical className="size-4 shrink-0" aria-hidden />
                <span>You're exploring sample data</span>
                <span aria-hidden>·</span>
                <Link href="/data/sources/new" className="font-medium hover:underline">
                  Connect your own data
                </Link>
              </div>
            ) : null}
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <HomePair />
                <Greeting name={firstName} />
              </div>
              <p className="text-body text-muted">
                {today.format(new Date(now))} · {metrics.length} verified {metrics.length === 1 ? "metric" : "metrics"}{" "}
                from {[...new Set(metrics.map((m) => m.connectionName))].join(", ")}
              </p>
            </div>
            {asks ? (
              <div className="flex flex-col gap-2.5">
                <Composer org={ws.org.name} hasData={ws.sources > 0} sources={sources} />
                <Suggestions
                  metrics={metrics}
                  {...(goals[0] ? { goal: { metric: goals[0].metric, target: goals[0].target } } : {})}
                />
              </div>
            ) : null}
            {reviewer && waiting.length ? (
              <Link
                href={ws.definitions.proposed ? "/knowledge/proposals" : "/knowledge/feedback"}
                className="flex w-fit items-center gap-2 text-body text-link hover:underline"
              >
                <GitPullRequestArrow className="size-4" aria-hidden />
                Waiting for you: {waiting.join(" · ")}
              </Link>
            ) : null}
            {goals.length ? <Goals goals={goals} /> : null}
            {changed.length ? <WhatChanged insights={changed} canAsk={asks} /> : null}
            {mine.length ? <MyTasks tasks={mine} /> : null}
            <section className="flex flex-col gap-3">
              <header className="flex items-baseline justify-between gap-3">
                <h2 className="flex items-baseline gap-2 text-heading">
                  Key metrics
                  <span className="text-small font-normal text-muted-tertiary">
                    {lead?.sample.period ? short.format(new Date(`${lead.sample.period}T00:00:00Z`)) : ""} · verified
                  </span>
                </h2>
                <Link href="/knowledge/metrics" className="text-small text-link hover:underline">
                  All metrics
                </Link>
              </header>
              <KeyMetrics metrics={metrics} now={now} />
            </section>
            <div className="flex flex-col gap-4 @5xl/page:flex-row">
              {lead ? (
                <TrendCard
                  metric={lead}
                  value={leadFigures?.latest?.display ?? "—"}
                  change={
                    leadFigures?.change && leadFigures.previous
                      ? `${leadFigures.change.pct >= 0 ? "up" : "down"} ${leadFigures.change.display} vs ${leadFigures.previous.label.split(" ")[0]}`
                      : null
                  }
                  displays={(leadFigures?.points ?? []).map((p) => p.display)}
                />
              ) : null}
              <Recent threads={threads} now={now} />
            </div>
          </div>
        </WritingProvider>
      </div>
    </>
  );
}

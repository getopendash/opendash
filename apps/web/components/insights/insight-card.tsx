"use client";

import { Button, buttonVariants, Chip, Dropdown, Label, toast } from "@heroui/react";
import type { DismissReason, InsightView, InvestigationView } from "@opendash/core";
import { Sparkline, TracedNumber } from "@opendash/ui";
import { Database, ListChecks, MessageSquare, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { dismissInsightAction } from "@/app/(app)/insights/actions";
import { investigateInsightAction } from "@/app/(app)/insights/investigate-actions";
import type { TracedRef } from "@/components/ask/answer-text";
import { AskBeside } from "@/components/panel/ask-beside";
import {
  DISMISS_LABELS,
  foundLine,
  investigateQuestion,
  periodLabel,
  resolvedLine,
  severityChip,
} from "@/lib/insight-words";
import { CreateTaskDialog } from "./create-task-dialog";
import { InvestigationBlock } from "./investigation";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const month = (period: string) => MONTH.format(new Date(`${period.slice(0, 10)}T00:00:00Z`));
const DUE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const SHORT = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const shortMonth = (period: string) => SHORT.format(new Date(`${period.slice(0, 10)}T00:00:00Z`));

export type TraceTarget =
  | { insight: InsightView; which: "value" | "previous" }
  /** A figure of its investigation's write-up: a reference to the Investigator's own query cells. */
  | { insight: InsightView; which: "investigation"; ref: TracedRef; key: string };

/**
 * One insight in the feed: what moved, its value (a query cell, opening its trace) against the
 * band it was expected in, its investigation (the Investigator), and its actions: Investigate, Ask about it,
 * Create task, Dismiss (owners and admins), or the source.
 */
export function InsightCard({
  insight: i,
  investigation,
  now,
  canAsk,
  canDismiss,
  traced,
  onTrace,
}: {
  insight: InsightView;
  investigation?: InvestigationView;
  now: number;
  canAsk: boolean;
  canDismiss: boolean;
  traced: TraceTarget | null;
  onTrace: (t: TraceTarget) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [investigating, setInvestigating] = useState(false);
  const which = traced?.which ?? null;
  const [creating, setCreating] = useState(false);
  const chip = severityChip(i);
  const c = i.claims;
  const g = i.goalRisk;
  const t = i.trend;
  const l = i.threshold;
  // Has a metric to investigate and move (not a source's late data).
  const measured = Boolean(c || g || t || l);
  const open = i.status === "new" || i.status === "seen";
  // Investigate starts one when there's none, or the last was held (the budget) or failed.
  const canInvestigate =
    measured &&
    open &&
    canAsk &&
    (!investigation || investigation.status === "held" || investigation.status === "failed");
  const investigate = async () => {
    setInvestigating(true);
    const r = await investigateInsightAction(i.id);
    setInvestigating(false);
    if (!r.ok) toast.danger(r.message);
    else if (r.status === "held") toast.warning("Not investigated: this month's background budget is spent.");
    else toast.success("Investigating it: its findings show on the card.");
    router.refresh();
  };
  const dismiss = async (reason: DismissReason) => {
    setPending(true);
    const r = await dismissInsightAction(i.id, reason);
    setPending(false);
    if (!r.ok) toast.danger(r.message);
    else toast.success("Dismissed for everyone.");
    router.refresh();
  };
  return (
    <article className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="soft" color={chip.tone}>
          {chip.label}
        </Chip>
        <span className="text-small text-muted">
          {c
            ? `Anomaly · ${c.metric.title}`
            : g
              ? `Goal · ${g.metric.title}`
              : t
                ? `Trend · ${t.metric.title}`
                : l
                  ? `Line · ${l.metric.title}`
                  : "Data quality"}{" "}
          · {i.connectionName}
          {i.mine ? " · Only you" : ""}
        </span>
        <span className="ms-auto text-small text-muted-tertiary">{foundLine(i, now)}</span>
      </header>
      <h2 className="text-lead font-medium">{i.title}</h2>
      {c ? (
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-number-lg">
              <TracedNumber
                display={c.value.display}
                selected={which === "value"}
                onPress={() => onTrace({ insight: i, which: "value" })}
              />
            </span>
            <span className="text-small text-muted-tertiary">{periodLabel(c.value.period, c.grain)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{c.expected.display}</span>
            <span className="text-small text-muted-tertiary">
              expected, from the {c.expected.periods} {c.grain}s before
            </span>
          </div>
          {c.previous ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-lead font-medium">
                <TracedNumber
                  display={c.previous.display}
                  selected={which === "previous"}
                  onPress={() => onTrace({ insight: i, which: "previous" })}
                />
              </span>
              <span className="text-small text-muted-tertiary">{periodLabel(c.previous.period, c.grain)}</span>
            </div>
          ) : null}
          {i.series.length > 1 ? (
            <Sparkline
              values={i.series.map((p) => p.value)}
              tone={c.good === null ? "accent" : c.good ? "success" : "danger"}
              className="ms-auto h-9 w-28"
            />
          ) : null}
        </div>
      ) : null}
      {l ? (
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-number-lg">
              <TracedNumber
                display={l.value.display}
                selected={which === "value"}
                onPress={() => onTrace({ insight: i, which: "value" })}
              />
            </span>
            <span className="text-small text-muted-tertiary">{periodLabel(l.value.period, l.grain)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{l.line.display}</span>
            <span className="text-small text-muted-tertiary">the line, watched for going {l.line.direction} it</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">
              {l.periods} {l.periods === 1 ? l.grain : `${l.grain}s`}
            </span>
            <span className="text-small text-muted-tertiary">since {periodLabel(l.since, l.grain)}</span>
          </div>
          {i.series.length > 1 ? (
            <Sparkline values={i.series.map((p) => p.value)} tone="accent" className="ms-auto h-9 w-28" />
          ) : null}
        </div>
      ) : null}
      {g ? (
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-number-lg">
              <TracedNumber
                display={g.value.display}
                selected={which === "value"}
                onPress={() => onTrace({ insight: i, which: "value" })}
              />
            </span>
            <span className="text-small text-muted-tertiary">{month(g.value.period)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{g.projected.display}</span>
            <span className="text-small text-muted-tertiary">projected for {month(g.projected.month)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{g.goal.target.display}</span>
            <span className="text-small text-muted-tertiary">
              the goal for {DUE.format(new Date(`${g.goal.due}T00:00:00Z`))}
            </span>
          </div>
        </div>
      ) : null}
      {t ? (
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-number-lg">
              <TracedNumber
                display={t.value.display}
                selected={which === "value"}
                onPress={() => onTrace({ insight: i, which: "value" })}
              />
            </span>
            <span className="text-small text-muted-tertiary">{month(t.value.period)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{t.before.display}</span>
            <span className="text-small text-muted-tertiary">the {t.months.before} months before</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{t.recent.display}</span>
            <span className="text-small text-muted-tertiary">
              {shortMonth(t.since)} to {shortMonth(t.value.period)}
            </span>
          </div>
          {i.series.length > 1 ? (
            <Sparkline
              values={i.series.map((p) => p.value)}
              tone={t.good === null ? "accent" : t.good ? "success" : "danger"}
              className="ms-auto h-9 w-28"
            />
          ) : null}
        </div>
      ) : null}
      <p className="text-body text-muted">
        {i.summary}
        {(c ?? t)?.good === true ? " Good news for this metric." : ""}
      </p>
      {investigation ? (
        <InvestigationBlock
          investigation={investigation}
          now={now}
          selected={traced?.which === "investigation" ? traced.key : null}
          onTrace={(ref, key) => onTrace({ insight: i, which: "investigation", ref, key })}
        />
      ) : null}
      <footer className="flex flex-wrap items-center gap-2">
        {canInvestigate ? (
          <Button size="sm" variant="secondary" isPending={investigating} onPress={() => void investigate()}>
            <Sparkles className="size-3.5" aria-hidden />
            Investigate
          </Button>
        ) : null}
        {measured && canAsk ? (
          <AskBeside text={investigateQuestion(i.title)} connectionId={i.connectionId} variant="ghost">
            <MessageSquare className="size-3.5" aria-hidden />
            Ask about it
          </AskBeside>
        ) : null}
        {measured && canAsk && open ? (
          <Button size="sm" variant="ghost" onPress={() => setCreating(true)}>
            <ListChecks className="size-3.5" aria-hidden />
            Create task
          </Button>
        ) : null}
        {i.tasks ? (
          <Link href="/tasks" className="text-small text-link hover:underline">
            {i.tasks === 1 ? "1 task" : `${i.tasks} tasks`}
          </Link>
        ) : null}
        {i.kind === "data_quality" ? (
          <Link href={`/data/sources/${i.connectionId}`} className={buttonVariants({ size: "sm", variant: "ghost" })}>
            <Database className="size-3.5" aria-hidden />
            Open source
          </Link>
        ) : null}
        {open && canDismiss ? (
          <Dropdown>
            <Button size="sm" variant="ghost" isPending={pending}>
              <X className="size-3.5" aria-hidden />
              Dismiss
            </Button>
            <Dropdown.Popover placement="bottom start" className="min-w-48">
              <Dropdown.Menu aria-label="Why dismiss it" onAction={(key) => void dismiss(key as DismissReason)}>
                {(Object.keys(DISMISS_LABELS) as DismissReason[]).map((r) => (
                  <Dropdown.Item key={r} id={r} textValue={DISMISS_LABELS[r]}>
                    <Label>{DISMISS_LABELS[r]}</Label>
                  </Dropdown.Item>
                ))}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>
        ) : null}
        {!open ? (
          <span className="text-small text-muted-tertiary">
            {i.status === "dismissed"
              ? `Dismissed: ${i.dismissReason ? DISMISS_LABELS[i.dismissReason].toLowerCase() : "no reason"}`
              : resolvedLine(i.kind)}
          </span>
        ) : null}
      </footer>
      {measured && creating ? (
        <CreateTaskDialog
          insight={i}
          isOpen={creating}
          onOpenChange={setCreating}
          today={new Date(now).toISOString().slice(0, 10)}
        />
      ) : null}
    </article>
  );
}

"use client";

import { Button, Chip, toast } from "@heroui/react";
import type { TaskView } from "@opendash/core";
import { TracedNumber } from "@opendash/ui";
import { Check, Play, Radar, Target, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { setTaskStatusAction } from "@/app/(app)/tasks/actions";
import { deltaLabel, expectationLine, monthLabel, outcomeNote, taskChip } from "@/lib/task-words";

const DUE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * A task: what to do, the insight it came from, which way it should move its metric, and its actions; done,
 * its outcome: the horizon's last month (a query cell, opening its trace) against the projection from its trend.
 */
export function TaskCard({
  task: t,
  canChange,
  traced,
  onTrace,
}: {
  task: TaskView;
  /** Its owner, or an owner or admin. */
  canChange: boolean;
  traced: boolean;
  onTrace: (t: TaskView) => void;
}) {
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  const chip = taskChip(t);
  const o = t.outcome;
  const set = async (status: "in_progress" | "done" | "dismissed") => {
    setPending(status);
    const r = await setTaskStatusAction(t.id, status);
    setPending(null);
    if (!r.ok) toast.danger(r.message);
    else if (status === "done") toast.success("Done. Its outcome is checked once the months after it close.");
    router.refresh();
  };
  const open = t.status === "accepted" || t.status === "in_progress";
  return (
    <article className="flex flex-col gap-2.5 rounded-2xl border border-border bg-surface p-4">
      <header className="flex flex-wrap items-center gap-2">
        <Chip size="sm" variant="soft" color={chip.tone}>
          {chip.label}
        </Chip>
        <span className="text-small text-muted">
          {t.metric?.title ?? "No metric"}
          {t.mine ? " · yours" : ""}
          {t.doneAt ? ` · done ${DUE.format(new Date(t.doneAt))}` : ""}
        </span>
        {t.dueAt && open ? (
          <span className="ms-auto text-small text-muted-tertiary">
            Due {DUE.format(new Date(`${t.dueAt}T00:00:00Z`))}
          </span>
        ) : null}
      </header>
      <h2 className="text-lead font-medium">{t.title}</h2>
      {t.insight && open ? (
        <Link
          href="/insights"
          className="flex items-center gap-2 rounded-xl bg-surface-secondary px-2.5 py-2 text-small hover:bg-default"
        >
          <Radar className="size-3.5 shrink-0 text-muted-tertiary" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium">{t.insight.title}</span>
          {t.insight.value ? (
            <span className="shrink-0 text-muted-tertiary">
              <span className="font-semibold text-foreground tabular-nums">{t.insight.value}</span>
              {t.insight.note ? ` · ${t.insight.note}` : ""}
            </span>
          ) : null}
        </Link>
      ) : null}
      {open ? (
        <span className="flex items-center gap-1.5 text-small text-muted">
          <Target className="size-3.5 text-muted-tertiary" aria-hidden />
          {expectationLine(t)}
        </span>
      ) : null}
      {o?.observed && o.projected && o.delta !== null ? (
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <div className="flex flex-col gap-0.5">
            <span className="text-number-lg">
              <TracedNumber display={o.observed.display} selected={traced} onPress={() => onTrace(t)} />
            </span>
            <span className="text-small text-muted-tertiary">{monthLabel(o.observed.period)}</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{o.projected.display}</span>
            <span className="text-small text-muted-tertiary">projected from its trend before the task</span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-lead font-medium tabular-nums">{deltaLabel(o.delta)}</span>
            <span className="text-small text-muted-tertiary">against the projection</span>
          </div>
        </div>
      ) : null}
      {t.status === "done" ? <p className="text-small text-muted">{outcomeNote(t, o)}</p> : null}
      {open && canChange ? (
        <footer className="flex flex-wrap items-center gap-2">
          {t.status === "accepted" ? (
            <Button
              size="sm"
              variant="secondary"
              isPending={pending === "in_progress"}
              onPress={() => set("in_progress")}
            >
              <Play className="size-3.5" aria-hidden />
              Start
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={t.status === "accepted" ? "ghost" : "secondary"}
            isPending={pending === "done"}
            onPress={() => set("done")}
          >
            <Check className="size-3.5" aria-hidden />
            Mark done
          </Button>
          <Button size="sm" variant="ghost" isPending={pending === "dismissed"} onPress={() => set("dismissed")}>
            <X className="size-3.5" aria-hidden />
            Dismiss
          </Button>
        </footer>
      ) : null}
    </article>
  );
}

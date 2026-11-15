"use client";

import { Button, Skeleton } from "@heroui/react";
import { RunTimeline, type TimelineRow } from "@opendash/ui";
import { useQuery } from "@tanstack/react-query";
import {
  Bot,
  CircleCheck,
  CircleMinus,
  CircleX,
  LoaderCircle,
  type LucideIcon,
  Sparkles,
  Workflow,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { apiQueries } from "@/lib/api";
import { duration, type RowState, type TimelineModelRow, timelineOf } from "@/lib/run-timeline";

const ACTIVE = new Set(["queued", "running", "cancelling"]);
const STATUS: Record<string, string> = {
  queued: "Waiting to start",
  running: "Working",
  cancelling: "Stopping",
  succeeded: "Done",
  cancelled: "Stopped",
  failed: "Failed",
};
const STATE_ICON: Record<RowState, LucideIcon> = {
  working: LoaderCircle,
  done: CircleCheck,
  failed: CircleX,
  stopped: CircleMinus,
};
const thousands = (n: number) => (n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n));

function iconOf(row: TimelineModelRow) {
  if (row.kind === "run") return <Workflow className="size-3.5" aria-hidden />;
  if (row.kind === "step") return <Sparkles className="size-3.5 text-accent" aria-hidden />;
  const Icon = STATE_ICON[row.state];
  return (
    <Icon
      className={`size-3.5 ${row.state === "working" ? "animate-spin text-accent" : row.state === "done" ? "text-success" : row.state === "failed" ? "text-danger" : "text-muted-tertiary"}`}
      aria-hidden
    />
  );
}

/**
 * A run's trace: its totals, a timeline of its model and tool calls with its drafters side by side and
 * each new attempt marked, and what a chosen row did. Read from the run's own records, again every 2 s while it works.
 */
export function RunTrace({ runId, live = true }: { runId: string; live?: boolean }) {
  // Read again every 2 s while the run works and the trace is in view (a closed panel keeps it, reading nothing).
  const trace = useQuery({
    ...apiQueries.runs.trace.queryOptions({ input: { runId } }),
    refetchInterval: (q) => (live && q.state.data && ACTIVE.has(q.state.data.trace.run.status) ? 2_000 : false),
  });
  const [now, setNow] = useState(() => Date.now());
  const working = Boolean(trace.data && ACTIVE.has(trace.data.trace.run.status));
  useEffect(() => {
    if (!working || !live) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [working, live]);
  const model = useMemo(() => (trace.data ? timelineOf(trace.data, now) : null), [trace.data, now]);
  const [chosen, setChosen] = useState<string | null>(null);

  // A read that failed after one that worked keeps what was shown; only a trace never read says it can't be.
  if (trace.error && !trace.data) {
    return <p className="p-4 text-body text-muted">This run's trace isn't yours to see, or the run is gone.</p>;
  }
  if (!trace.data || !model) return <Skeleton className="m-4 h-64 rounded-2xl" />;
  const { totals } = trace.data;
  const run = trace.data.trace.run;
  // The run's own row is chosen until another is: its attempts.
  // Chosen by hand, else the first drafter, else the first model call, else the run itself (its attempts).
  const selected =
    model.rows.find((r) => r.id === chosen) ??
    model.rows.find((r) => r.kind === "helper") ??
    model.rows.find((r) => r.kind === "step") ??
    model.rows[0];
  const rows: TimelineRow[] = model.rows.map((r) => ({
    id: r.id,
    label: r.label,
    level: r.level,
    time: r.time,
    icon: iconOf(r),
    segments: r.segments,
  }));
  const cached = totals.inputTokens ? Math.round((totals.cachedInputTokens / totals.inputTokens) * 100) : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <dl className="flex flex-wrap gap-x-6 gap-y-2 border-separator border-b px-4 py-3">
        {[
          ["Status", STATUS[run.status] ?? run.status, run.attempt > 1 ? `attempt ${run.attempt}` : "one attempt"],
          ["Time", duration(totals.ms), totals.helpers ? `${totals.helpers} helpers` : "no helpers"],
          ["Model calls", String(totals.modelCalls), run.profile],
          ["Tokens", thousands(totals.inputTokens + totals.outputTokens), `${cached}% of input cached`],
          [
            "Cost",
            `$${totals.costUsd.toFixed(2)}`,
            working ? "so far" : totals.helpers ? "helpers included" : "all of it",
          ],
        ].map(([label, value, sub]) => (
          <div key={label} className="flex flex-col">
            <dt className="text-small text-muted-tertiary">{label}</dt>
            <dd
              className={`text-body font-semibold tabular-nums ${label === "Status" && working ? "text-accent" : ""}`}
            >
              {value}
            </dd>
            <dd className="text-small text-muted">{sub}</dd>
          </div>
        ))}
      </dl>
      {trace.data.redacted ? (
        <p className="border-separator border-b px-4 py-2 text-small text-muted">
          Its asker's memory went into this run, so you see what it did and when, not what it wrote.
        </p>
      ) : null}
      <div className="flex flex-col gap-2 border-separator border-b px-4 py-3">
        <RunTimeline
          rows={rows}
          ticks={model.ticks}
          marks={model.marks}
          selected={selected?.id ?? null}
          onSelect={setChosen}
        />
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1 text-small text-muted">
          {[
            ["bg-accent", "Model call"],
            ["bg-muted-tertiary", "Tool call"],
            ["bg-default", "Waiting for a turn"],
            ["bg-accent-soft ring-1 ring-accent", "Under way"],
          ].map(([swatch, label]) => (
            <li key={label} className="flex items-center gap-1.5">
              <span className={`h-2 w-3.5 rounded-sm ${swatch}`} aria-hidden />
              {label}
            </li>
          ))}
          {model.marks.length ? (
            <li className="flex items-center gap-1.5">
              <span className="h-3 w-px bg-warning" aria-hidden />A new attempt
            </li>
          ) : null}
        </ul>
        {model.attempts.map((a) => (
          <p key={a} className="text-small text-muted-tertiary">
            {a} Work under way was picked up where it stopped.
          </p>
        ))}
      </div>
      {selected ? (
        <section className="flex flex-col gap-2 px-4 py-3" aria-label={`What ${selected.label} did`}>
          <header className="flex items-center gap-2">
            {selected.kind === "helper" ? <Bot className="size-3.5 text-muted" aria-hidden /> : null}
            <h3 className="min-w-0 flex-1 truncate text-body font-medium">{selected.label}</h3>
            <span className="text-small text-muted-tertiary">{selected.time}</span>
          </header>
          {selected.detail.length ? (
            <table className="w-full text-small">
              <tbody>
                {selected.detail.map((line) => (
                  <tr key={line.key} className="border-separator border-b last:border-b-0">
                    <td className={`py-1.5 pe-3 ${line.failed ? "text-danger" : ""}`}>{line.label}</td>
                    <td className="py-1.5 pe-3 text-end text-muted tabular-nums">{line.time}</td>
                    <td className="py-1.5 pe-3 text-end text-muted tabular-nums">{line.tokens ?? ""}</td>
                    <td className="py-1.5 text-end text-muted tabular-nums">{line.cost ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-small text-muted">Nothing recorded yet.</p>
          )}
          <p className="text-small text-muted-tertiary">
            Read from the run's own records, so an old run has the same trace. Its working notes stay in its
            conversation.
          </p>
        </section>
      ) : null}
    </div>
  );
}

/** The trace beside a conversation on the Ask page, where the panel steps aside (the Sources panel's place). */
export function TraceAside({ runId, onClose }: { runId: string; onClose: () => void }) {
  return (
    <aside
      aria-label="Trace"
      className="flex h-full w-full flex-col border-border @5xl/page:w-inspector @5xl/page:border-l @7xl/page:w-inspector-wide"
    >
      <header className="flex h-12 shrink-0 items-center justify-between border-separator border-b px-4">
        <h2 className="text-body font-semibold">Trace</h2>
        <Button isIconOnly size="sm" variant="ghost" aria-label="Close the trace" onPress={onClose}>
          <X className="text-muted" />
        </Button>
      </header>
      <RunTrace runId={runId} />
    </aside>
  );
}

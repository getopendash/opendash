import type { RunTrace, TracedCall, TracedStep, TraceView } from "@opendash/core";

/** What a row is, for its icon: the run, one of its model calls, a helper (a drafter) and how it stands. */
export type RowKind = "run" | "step" | "helper";
export type RowState = "working" | "done" | "failed" | "stopped";

/** One line of what a chosen row did: a model call (its tokens and cost) or a tool call (its time and result). */
export interface DetailLine {
  key: string;
  label: string;
  /** "3.9s"; "…" while it works. */
  time: string;
  /** A model call's: "12.4k in · 64% cached · 0.6k out". */
  tokens?: string;
  /** A model call's: "$0.012". */
  cost?: string;
  failed?: boolean;
}

export interface TimelineModelRow {
  id: string;
  kind: RowKind;
  state: RowState;
  label: string;
  level: 0 | 1 | 2;
  time: string;
  segments: { from: number; to: number; kind: "model" | "tool" | "wait" | "running" | "span" }[];
  detail: DetailLine[];
}

export interface TimelineModel {
  rows: TimelineModelRow[];
  ticks: string[];
  /** Where each attempt after the first began, as fractions of the timeline. */
  marks: number[];
  /** "Attempt 2 began at 0:52 (the worker restarted)", for each. */
  attempts: string[];
}

const ACTIVE = new Set(["queued", "running", "cancelling"]);

/** "0.4s", "6.1s", "2m 35s", "1h 02m". */
export function duration(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(Math.round(s % 60)).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** "0:52": where on the timeline something happened. */
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

const thousands = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const usd = (n: number | null) => (n === null ? undefined : n < 0.001 ? "<$0.001" : `$${n.toFixed(3)}`);
const at = (iso: string | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/** What a model call's tool calls were, in a few words: "sql_query", "draft_tables × 4", "sql_check, sql_query". */
function stepLabel(step: TracedStep): string {
  if (!step.calls.length) return "Model call";
  const names = [...new Set(step.calls.map((c) => c.tool))];
  if (names.length === 1) return step.calls.length > 1 ? `${names[0]} × ${step.calls.length}` : (names[0] as string);
  return names.join(", ");
}

function modelLine(step: TracedStep, ms: number): DetailLine {
  const u = step.usage;
  const input = u.inputTokens ?? 0;
  const cached = u.cachedInputTokens ?? 0;
  return {
    key: `m-${step.seq}`,
    label: step.model ?? "Model call",
    time: duration(ms),
    tokens: `${thousands(input)} in${input && cached ? ` · ${Math.round((cached / input) * 100)}% cached` : ""} · ${thousands(u.outputTokens ?? 0)} out`,
    ...(usd(step.costUsd) ? { cost: usd(step.costUsd) as string } : {}),
  };
}

function callLine(c: TracedCall, i: number, seq: number): DetailLine {
  const said = [
    c.tool,
    c.alias ? `${c.alias}${c.rows !== undefined ? ` · ${c.rows} rows` : ""}` : null,
    c.tables?.length ? c.tables.join(", ") : null,
    c.repaired ? `repaired: ${c.repaired}` : null,
    c.error ? c.error : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return {
    key: `c-${seq}-${i}`,
    label: said,
    time: c.ms !== null ? duration(c.ms) : c.status === "started" ? "…" : "",
    ...(c.status === "failed" || c.error ? { failed: true } : {}),
  };
}

function stateOf(status: string): RowState {
  if (ACTIVE.has(status)) return "working";
  if (status === "succeeded") return "done";
  if (status === "cancelled") return "stopped";
  return "failed";
}

/**
 * A run's trace as its timeline draws it: the run, each of its model calls with its tool calls, and each
 * drafter a call ran as a lane under it, waiting for its turn and then working. A model call's time is from what ended
 * before it (the attempt's start, or the call before it) to its message: nothing else records its start.
 */
export function timelineOf(view: TraceView, now = Date.now()): TimelineModel {
  const t = view.trace;
  const starts = t.attempts.map((a) => at(a.started)).filter((x) => !Number.isNaN(x));
  const start = starts[0] ?? at(t.run.queuedAt);
  const end = t.run.finishedAt ? at(t.run.finishedAt) : now;
  const span = Math.max(1, end - start);
  const f = (ms: number) => Math.min(1, Math.max(0, (ms - start) / span));
  const rows: TimelineModelRow[] = [
    {
      id: "run",
      kind: "run",
      state: stateOf(t.run.status),
      label: view.title,
      level: 0,
      time: duration(end - start),
      segments: [{ from: 0, to: 1, kind: "span" }],
      detail: t.attempts.map((a) => ({
        key: `a-${a.attempt}`,
        label: `Attempt ${a.attempt}${a.reason ? ` · ${a.reason}` : ""}`,
        time: a.started ? clock(at(a.started) - start) : "",
      })),
    },
  ];

  /** One run's model calls (and its drafters' lanes), from `from` on. Returns when its last one ended. */
  const lay = (run: RunTrace, level: 1 | 2, rowsOut: TimelineModelRow[], idPrefix: string): number => {
    const runStarts = run.attempts.map((a) => at(a.started)).filter((x) => !Number.isNaN(x));
    let prev = runStarts[0] ?? at(run.run.queuedAt);
    for (const step of run.steps) {
      const done = at(step.at);
      const attemptStart = Math.max(...runStarts.filter((s) => s <= done), Number.NEGATIVE_INFINITY);
      const from = Math.max(prev, attemptStart);
      const segments: TimelineModelRow["segments"] = [{ from: f(from), to: f(done), kind: "model" }];
      let last = done;
      for (const c of step.calls) {
        const a = at(c.startedAt);
        const z = at(c.finishedAt);
        if (!Number.isNaN(a)) {
          const stop = Number.isNaN(z) ? (ACTIVE.has(run.run.status) ? now : a) : z;
          segments.push({ from: f(a), to: f(stop), kind: "tool" });
          last = Math.max(last, stop);
        }
      }
      rowsOut.push({
        id: `${idPrefix}s${step.seq}`,
        kind: "step",
        state: step.calls.some((c) => c.status === "failed") ? "failed" : "done",
        label: stepLabel(step),
        level,
        time: duration(last - from),
        segments,
        detail: [modelLine(step, done - from), ...step.calls.map((c, i) => callLine(c, i, step.seq))],
      });
      // A drafter a call ran is a lane under it (a drafter's own model calls fold into its lane).
      if (level === 1) {
        for (const c of step.calls) if (c.child) rowsOut.push(helperRow(c, c.child, `${idPrefix}s${step.seq}-`));
      }
      prev = last;
    }
    return prev;
  };

  /** A drafter's lane: waiting for its turn, then its model and tool calls, then working on to now while it does. */
  const helperRow = (call: TracedCall, child: RunTrace, idPrefix: string): TimelineModelRow => {
    const queued = at(child.run.queuedAt);
    const childStarts = child.attempts.map((a) => at(a.started)).filter((x) => !Number.isNaN(x));
    const began = childStarts[0] ?? (ACTIVE.has(child.run.status) ? now : queued);
    const inner: TimelineModelRow[] = [];
    const last = lay(child, 2, inner, `${idPrefix}${child.run.id}-`);
    const working = ACTIVE.has(child.run.status);
    const finished = child.run.finishedAt ? at(child.run.finishedAt) : working ? now : last;
    const segments: TimelineModelRow["segments"] = [
      ...(began - queued > 500 ? [{ from: f(queued), to: f(began), kind: "wait" as const }] : []),
      ...inner.flatMap((r) => r.segments),
      ...(working ? [{ from: f(Math.max(last, began)), to: f(now), kind: "running" as const }] : []),
    ];
    return {
      id: `helper-${child.run.id}`,
      kind: "helper",
      state: stateOf(child.run.status),
      label: call.tables?.length ? call.tables.join(", ") : `${child.run.profile} ${child.run.id.slice(0, 8)}`,
      level: 2,
      time: duration(finished - queued),
      segments,
      detail: inner.flatMap((r) => r.detail),
    };
  };

  lay(t, 1, rows, "");
  const later = t.attempts.slice(1).filter((a) => a.started);
  return {
    rows,
    ticks: [0, 0.25, 0.5, 0.75, 1].map((x) => duration(span * x)),
    marks: later.map((a) => f(at(a.started))),
    attempts: later.map((a) => {
      const before = t.attempts[a.attempt - 2];
      return `Attempt ${a.attempt} began at ${clock(at(a.started) - start)}${before?.reason ? `, after attempt ${before.attempt} ended: ${before.reason}` : ""}.`;
    }),
  };
}

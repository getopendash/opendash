/**
 * A run as its trace shows it, from what's kept as long as its conversation: the run, how each attempt
 * ended, what its latest attempt was sent (each layer's hash and size), and each model call with its usage, price and
 * tool calls. Read by the operator's trace command as the system role, never by members. A memory's text isn't here:
 * none is stored.
 */
import { type SystemTx, sql, type TenantTx } from "@opendash/db";
import { costOf } from "../usage/prices";
import type { ModelUsage } from "./ledger";
import { PROMPT_LAYERS, type RunPrompt } from "./prompt";

export interface TracedCall {
  tool: string;
  status: string;
  ms: number | null;
  /** When it ran (a timeline's bar): unset for a call cut off before its row was written. */
  startedAt?: string;
  finishedAt?: string;
  /** A query's alias and rows, from the query it ran. */
  alias?: string;
  title?: string;
  rows?: number;
  error?: string;
  /** An answer's verdict from the gate, and what it sent back. */
  accepted?: boolean;
  problems?: string[];
  /** What code repaired in the call's input before it ran. */
  repaired?: string;
  /** The tables a draft_tables call handed out: its drafter's lane is named by them. */
  tables?: string[];
  /** The child run it ran (a drafter, for draft_tables), traced in turn under the first call that ran it. */
  child?: RunTrace;
  /** A later call that found the same child: its id, traced (and counted) once, under the first. */
  reusedChild?: string;
}

export interface TracedStep {
  seq: number;
  at: string;
  model: string | null;
  usage: ModelUsage;
  costUsd: number | null;
  stopReason: string | null;
  calls: TracedCall[];
}

export interface RunTrace {
  run: {
    id: string;
    orgId: string;
    threadId: string;
    profile: string;
    model: string;
    trigger: string;
    status: string;
    attempt: number;
    error: string | null;
    outcome: string | null;
    queuedAt: string;
    finishedAt: string | null;
  };
  /** Every attempt the run claimed; one that crashed recorded no end. */
  attempts: { attempt: number; started?: string; ended?: string; reason: string }[];
  prompt: (RunPrompt & { sizes: Partial<Record<(typeof PROMPT_LAYERS)[number], number>> }) | null;
  steps: TracedStep[];
  /** What the asker sent while it worked, read before the step after it. */
  followUps: { seq: number; text: string }[];
}

type Part = { type?: string; toolCallId?: string; input?: unknown };

const ACTIVE = new Set(["queued", "running", "cancelling"]);

/** The error a tool's result says it had (a query's `{ kind, message }`, another's text), if any. */
function failure(result: Record<string, unknown>): string | undefined {
  const e = result.error as string | { kind?: string; message?: string } | undefined;
  if (!e) return undefined;
  return typeof e === "string" ? e : [e.kind, e.message].filter(Boolean).join(": ");
}

/** As the operator's command reads it (the system role), or a member's view of it (a tenant). */
export async function traceRun(tx: SystemTx | TenantTx, runId: string): Promise<RunTrace | null> {
  const [run] = await tx.execute<{
    org_id: string;
    thread_id: string;
    profile: string;
    model: string;
    trigger: string;
    status: string;
    attempt: number;
    error: string | null;
    outcome: { kind?: string } | null;
    queued_at: string;
    finished_at: string | null;
    prompt: RunPrompt | null;
    attempts: { attempt: number; started: string; ended: string; reason: string }[];
    attempt_started_at: string | null;
  }>(sql`
    select org_id, thread_id, profile, model, trigger, status, attempt, error, outcome, queued_at, finished_at, prompt,
      attempts, attempt_started_at
    from app.run where id = ${runId}`);
  if (!run) return null;
  const org = run.org_id;
  const messages = await tx.execute<{
    seq: number;
    at: string;
    model: string | null;
    usage: ModelUsage | null;
    stop: string | null;
    content: { content?: Part[] };
  }>(sql`
      select seq, created_at as at, model, usage, stop_reason as stop, content from app.message
      where org_id = ${org} and run_id = ${runId} and role = 'assistant' order by seq`);
  const calls = await tx.execute<{
    call_id: string;
    tool: string;
    status: string;
    ms: number | null;
    started_at: string | null;
    finished_at: string | null;
    error: string | null;
    args: Record<string, unknown> | null;
    result: Record<string, unknown> | null;
    alias: string | null;
    title: string | null;
    rows: number | null;
  }>(sql`
      select c.call_id, c.tool, c.status, c.error, c.result, c.args, c.started_at, c.finished_at,
        (extract(epoch from c.finished_at - c.started_at) * 1000)::int as ms, q.alias, q.title, q.rows
      from app.tool_call c
      left join app.query_run q on q.org_id = c.org_id and q.id = c.query_run_id
      where c.org_id = ${org} and c.run_id = ${runId}`);
  const sizes = await tx.execute<{ sha256: string; chars: number }>(sql`
    select sha256, length(text) as chars from app.prompt_text
    where org_id = ${org} and sha256 in (${sql.join(
      PROMPT_LAYERS.map((l) => sql`${run.prompt?.[l] ?? ""}`),
      sql`, `,
    )})`);
  const followUps = await tx.execute<{ seq: number; text: string }>(sql`
    select seq, coalesce(text, '') as text from app.message
    where org_id = ${org} and run_id = ${runId} and role = 'user' and seq is not null order by seq`);
  const byCall = new Map(calls.map((c) => [c.call_id, c]));
  // Its children, each traced under the call that gave it its task: draft_tables with the same tables.
  const kids = await tx.execute<{ id: string; task: { tables?: string[] } | null }>(sql`
    select id, task from app.run where org_id = ${org} and parent_run_id = ${runId} order by queued_at`);
  const taskOf = (tables: unknown) =>
    Array.isArray(tables) ? JSON.stringify([...new Set(tables.map((t) => String(t).trim().toLowerCase()))].sort()) : "";
  const childOf = new Map(kids.map((k) => [taskOf(k.task?.tables), k.id]));
  // A call's tables as its message has them: a call interrupted before its row was written has no args there.
  const inputs = new Map(
    messages.flatMap((m) =>
      (m.content.content ?? []).flatMap((p) =>
        p.type === "tool-call" && p.toolCallId ? [[p.toolCallId, p.input as { tables?: unknown } | undefined]] : [],
      ),
    ) as [string, { tables?: unknown } | undefined][],
  );
  const tablesOf = (c: (typeof calls)[number]) => inputs.get(c.call_id)?.tables ?? c.args?.tables;
  const childTraces = new Map<string, RunTrace | null>();
  for (const c of calls) {
    const id = c.tool === "draft_tables" ? childOf.get(taskOf(tablesOf(c))) : undefined;
    if (id && !childTraces.has(id)) childTraces.set(id, await traceRun(tx, id));
  }
  // The calls are traced in the order they ran: the first to find a child shows it, a later one points to it.
  const shown = new Set<string>();
  const childPart = (c: (typeof calls)[number]): Partial<TracedCall> => {
    const id = c.tool === "draft_tables" ? childOf.get(taskOf(tablesOf(c))) : undefined;
    const child = id ? childTraces.get(id) : undefined;
    if (!id || !child) return {};
    if (shown.has(id)) return { reusedChild: id };
    shown.add(id);
    return { child };
  };
  const traced = (id: string): TracedCall[] => {
    const c = byCall.get(id);
    if (!c) return [];
    const r = c.result ?? {};
    return [
      {
        tool: c.tool,
        status: c.status,
        ms: c.ms,
        ...(c.started_at ? { startedAt: new Date(c.started_at).toISOString() } : {}),
        ...(c.finished_at ? { finishedAt: new Date(c.finished_at).toISOString() } : {}),
        ...(c.alias ? { alias: c.alias, title: c.title ?? "", rows: c.rows ?? 0 } : {}),
        // A call can succeed and still say it failed: a refused or failed query's error is in its result.
        ...(c.error || failure(r) ? { error: c.error ?? failure(r) } : {}),
        ...(typeof r.accepted === "boolean" ? { accepted: r.accepted, problems: (r.problems as string[]) ?? [] } : {}),
        ...(typeof r.repaired === "string" ? { repaired: r.repaired } : {}),
        ...(c.tool === "draft_tables" && Array.isArray(tablesOf(c))
          ? { tables: (tablesOf(c) as unknown[]).map((x) => String(x)) }
          : {}),
        ...childPart(c),
      },
    ];
  };
  const steps = messages.map((m) => {
    const u = m.usage ?? {};
    const read = u.cachedInputTokens ?? 0;
    const written = u.cacheWriteTokens ?? 0;
    return {
      seq: m.seq,
      // As ISO text, milliseconds kept: a timeline lays it beside the calls' times.
      at: new Date(m.at).toISOString(),
      model: m.model,
      usage: u,
      costUsd: costOf(m.model ?? run.model, {
        noCacheTokens: u.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - read - written),
        cacheReadTokens: read,
        cacheWriteTokens: written,
        outputTokens: u.outputTokens ?? 0,
      }),
      stopReason: m.stop,
      calls: (m.content.content ?? []).flatMap((p) =>
        p.type === "tool-call" && p.toolCallId ? traced(p.toolCallId) : [],
      ),
    };
  });
  const ends = new Map(run.attempts.map((a) => [a.attempt, a]));
  const length = new Map(sizes.map((s) => [s.sha256, Number(s.chars)]));
  return {
    run: {
      id: runId,
      orgId: org,
      threadId: run.thread_id,
      profile: run.profile,
      model: run.model,
      trigger: run.trigger,
      status: run.status,
      attempt: run.attempt,
      error: run.error,
      outcome: run.outcome?.kind ?? null,
      queuedAt: new Date(run.queued_at).toISOString(),
      finishedAt: run.finished_at ? new Date(run.finished_at).toISOString() : null,
    },
    // Older runs kept neither; on newer ones, an attempt without an end is one whose worker stopped.
    attempts: Array.from({ length: run.attempt }, (_, i) => {
      const ended = ends.get(i + 1);
      if (ended) return ended;
      // The attempt under way has no end yet: its start is the run's (an attempt's end is kept only when it ends).
      if (i + 1 === run.attempt && ACTIVE.has(run.status) && run.attempt_started_at) {
        return { attempt: i + 1, started: new Date(run.attempt_started_at).toISOString(), reason: "under way" };
      }
      return {
        attempt: i + 1,
        reason:
          run.prompt || run.attempts.length
            ? "no end recorded (the worker stopped)"
            : "not recorded (a run from before 2026-10-15)",
      };
    }),
    prompt: run.prompt
      ? {
          ...run.prompt,
          sizes: Object.fromEntries(
            PROMPT_LAYERS.flatMap((l) => {
              const hash = run.prompt?.[l];
              return hash && length.has(hash) ? [[l, length.get(hash) as number]] : [];
            }),
          ),
        }
      : null,
    steps,
    followUps: followUps.map((f) => ({ seq: f.seq, text: f.text })),
  };
}

/** A stored layer's text by its hash, for the trace's full view. */
export async function promptLayerText(tx: SystemTx, orgId: string, sha256: string): Promise<string | null> {
  const [row] = await tx.execute<{ text: string }>(sql`
    select text from app.prompt_text where org_id = ${orgId} and sha256 = ${sha256}`);
  return row?.text ?? null;
}

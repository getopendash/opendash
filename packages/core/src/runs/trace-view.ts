/**
 * The run trace in the product: a member's view of a run's trace, read from the durable tables (a month-old
 * run has the same one), with its totals, and the workspace's recent runs for its owners and admins (Activity).
 * - A run is seen as its conversation is: its asker, and whoever it's shared with. A run given its asker's memory
 *   shows another reader its structure only (which tool, its status, times, counts, costs), as its events do.
 * - Background work (drafting, investigations, reviews, evals) is nobody's conversation: its owners and admins see it.
 * - A drafter is seen as its lead is: the check is on the root run's thread, never the drafter's own.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { othersPrivateWork, threadReadableBy } from "../projects/access";
import { BACKGROUND_CHANNELS, draftWorkIn, type LedgerDeps, readAsAskerBefore, type Viewer } from "./ledger";
import { type RunTrace, type TracedCall, traceRun } from "./trace";

const BACKGROUND = BACKGROUND_CHANNELS;

/** Who asks: a person (their own and what's shared with them), and whether they run the workspace (an owner, admin). */
export type TraceViewer = Viewer & { manages: boolean };

export interface TraceTotals {
  /** From the first attempt's start (or its queueing) to its end, or now while it works. */
  ms: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  /** Input read from the cache, over all calls. */
  cachedInputTokens: number;
  costUsd: number;
  /** Its child runs (a drafting batch's helpers), each counted once. */
  helpers: number;
}

export interface TraceView {
  trace: RunTrace;
  totals: TraceTotals;
  /** Structure only: a reader who isn't its asker, of a run given the asker's memory. */
  redacted: boolean;
  /** The conversation's title, or the background work's ("Drafting 8 tables on warehouse"). */
  title: string;
}

/** A run and its children, added up as the trace command does: each child once, under the call that ran it. */
export function traceTotals(trace: RunTrace, now = Date.now()): TraceTotals {
  const totals: TraceTotals = {
    ms: 0,
    modelCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    helpers: 0,
  };
  const add = (t: RunTrace) => {
    for (const s of t.steps) {
      totals.modelCalls += 1;
      totals.inputTokens += s.usage.inputTokens ?? 0;
      totals.outputTokens += s.usage.outputTokens ?? 0;
      totals.cachedInputTokens += s.usage.cachedInputTokens ?? 0;
      totals.costUsd += s.costUsd ?? 0;
      for (const c of s.calls) {
        if (c.child) {
          totals.helpers += 1;
          add(c.child);
        }
      }
    }
  };
  add(trace);
  const started = trace.attempts.find((a) => a.started)?.started ?? trace.run.queuedAt;
  const ended = trace.run.finishedAt ? Date.parse(trace.run.finishedAt) : now;
  totals.ms = Math.max(0, ended - Date.parse(started));
  return totals;
}

/** What a reader who isn't the asker sees of a call, as of an event: which tool, its status, times and counts. */
function structureOnly(trace: RunTrace): RunTrace {
  const call = (c: TracedCall): TracedCall => ({
    tool: c.tool,
    status: c.status,
    ms: c.ms,
    ...(c.startedAt ? { startedAt: c.startedAt } : {}),
    ...(c.finishedAt ? { finishedAt: c.finishedAt } : {}),
    ...(c.alias ? { alias: c.alias, rows: c.rows ?? 0 } : {}),
    ...(typeof c.accepted === "boolean" ? { accepted: c.accepted } : {}),
    ...(c.tables ? { tables: c.tables } : {}),
    ...(c.child ? { child: structureOnly(c.child) } : {}),
    ...(c.reusedChild ? { reusedChild: c.reusedChild } : {}),
  });
  return {
    ...trace,
    run: { ...trace.run, error: trace.run.error ? "It stopped with an error." : null },
    prompt: null,
    steps: trace.steps.map((s) => ({ ...s, calls: s.calls.map(call) })),
    followUps: trace.followUps.map((f) => ({ seq: f.seq, text: "" })),
  };
}

/** The run a run belongs to: itself, or its lead's lead. */
async function rootOf(tx: TenantTx, orgId: string, runId: string) {
  const [root] = await tx.execute<{
    id: string;
    channel: string;
    title: string;
    author: string | null;
  }>(sql`
    with recursive up as (
      select id, parent_run_id, thread_id, 0 as depth from app.run where org_id = ${orgId} and id = ${runId}
      union all
      select r.id, r.parent_run_id, r.thread_id, up.depth + 1 from app.run r
      join up on r.org_id = ${orgId} and r.id = up.parent_run_id
      where up.depth < 8
    )
    select up.id, t.channel, t.title, t.created_by as author
    from up join app.thread t on t.org_id = ${orgId} and t.id = up.thread_id
    where up.parent_run_id is null
    limit 1`);
  return root ?? null;
}

/**
 * A run's trace for a member, or null when it doesn't exist or isn't theirs to see. Its children are nested;
 * its totals add them up.
 */
export async function traceFor(deps: LedgerDeps, viewer: TraceViewer, runId: string): Promise<TraceView | null> {
  if (!isUuid(runId)) return null;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const root = await rootOf(tx, viewer.orgId, runId);
    if (!root) return null;
    const [seen] = await tx.execute<{ yes: boolean }>(sql`
      select true as yes from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${viewer.orgId} and r.id = ${root.id}
        and (${threadReadableBy(viewer.userId)}
          or (${viewer.manages} and t.channel in (${sql.join(
            BACKGROUND.map((c) => sql`${c}`),
            sql`, `,
          )}) and not ${othersPrivateWork(viewer.userId)}))`);
    if (!seen) return null;
    const trace = await traceRun(tx, runId);
    if (!trace) return null;
    // Another reader of a conversation whose run was given its asker's memory, read a service as them, or worked on
    // their dashboard draft: structure only.
    let redacted = false;
    if (root.author !== viewer.userId && !BACKGROUND.includes(root.channel as (typeof BACKGROUND)[number])) {
      // Or one that read a service as its asker (their own MCP connection).
      const [given] = await tx.execute<{ yes: boolean }>(sql`
        select true as yes from app.run_event
        where org_id = ${viewer.orgId} and run_id = ${runId} and type = 'context'
          and data->'items' @> '[{"kind": "memory"}]'::jsonb
        union all
        ${readAsAskerBefore(viewer.orgId, runId)}
        union all
        ${draftWorkIn(viewer.orgId, runId)}
        limit 1`);
      const [prompted] = await tx.execute<{ memories: number | null }>(sql`
        select (prompt->>'memories')::int as memories from app.run
        where org_id = ${viewer.orgId} and id = ${runId}`);
      // Nothing recorded (a run from before its prompt was kept, its events gone): structure only, to be safe.
      const unrecorded = !given && (prompted?.memories ?? null) === null;
      redacted = Boolean(given) || (prompted?.memories ?? 0) > 0 || unrecorded;
    }
    const shown = redacted ? structureOnly(trace) : trace;
    return { trace: shown, totals: traceTotals(trace), redacted, title: root.title };
  });
}

/** What one call did, for the chat's step that opens to it: every call is shown. */
export interface CallDetail {
  tool: string;
  status: string;
  /** Its input as the model sent it (a query's title and SQL, a service's arguments, a save's edits). */
  input: unknown;
  /** What came back, as the model read it; cut to a size a step can show. */
  output: unknown;
  error: string | null;
  /** For a query: the SQL that ran (a metric's as compiled), its columns and first rows. */
  query?: { sql: string; columns: string[]; rows: unknown[][]; total: number | null };
}

/** The most of a call's input or output a step shows: past it, cut and said so. */
const DETAIL_CHARS = 40_000;
const cut = (v: unknown): unknown => {
  const text = JSON.stringify(v ?? null);
  return text.length <= DETAIL_CHARS ? v : { cut: true, start: `${text.slice(0, DETAIL_CHARS)}…` };
};
/** A text the call carries (its SQL, its error), cut the same way: no part of the answer goes past the cap. */
const cutText = (t: string | null): string | null =>
  t === null || t.length <= DETAIL_CHARS ? t : `${t.slice(0, DETAIL_CHARS)}…`;
/** A query's first rows, at most the cap together: one wide row of long values can't carry the whole answer. */
const cutRows = (rows: unknown[][]): { rows: unknown[][]; cut: boolean } => {
  const kept: unknown[][] = [];
  let size = 0;
  for (const r of rows.slice(0, 20)) {
    size += JSON.stringify(r).length;
    if (size > DETAIL_CHARS) return { rows: kept, cut: true };
    kept.push(r);
  }
  return { rows: kept, cut: false };
};

/**
 * One call of a run, in full, for the person who asked: never another reader of the conversation, whatever it
 * read (their memory, their own service login, their draft, values only they may see). Null otherwise. Personal
 * columns never reached the call's result in the first place (the gateway keeps them out for everyone).
 */
export async function callDetail(
  deps: LedgerDeps,
  viewer: TraceViewer,
  runId: string,
  callId: string,
): Promise<CallDetail | null> {
  if (!isUuid(runId) || !callId || callId.length > 200) return null;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const root = await rootOf(tx, viewer.orgId, runId);
    // A person, the one who asked: never an API key (no user) or a conversation with no author.
    if (!viewer.userId || !root?.author || root.author !== viewer.userId) return null;
    const [c] = await tx.execute<{
      tool: string;
      status: string;
      args: unknown;
      result: unknown;
      error: string | null;
      query_run_id: string | null;
    }>(sql`
      select tool, status, args, result, error, query_run_id from app.tool_call
      where org_id = ${viewer.orgId} and run_id = ${runId} and call_id = ${callId}
      order by started_at desc limit 1`);
    if (!c) return null;
    const [q] = c.query_run_id
      ? await tx.execute<{
          sql: string;
          schema: { name: string }[] | null;
          preview: unknown[][] | null;
          rows: number | null;
        }>(sql`
          select compiled_sql as sql, result_schema as schema, preview, rows from app.query_run
          where org_id = ${viewer.orgId} and id = ${c.query_run_id}`)
      : [];
    const shown = cutRows(q?.preview ?? []);
    return {
      tool: c.tool,
      status: c.status,
      input: cut(c.args),
      output: cut(c.result),
      error: cutText(c.error),
      ...(q
        ? {
            query: {
              sql: cutText(q.sql) ?? "",
              columns: (q.schema ?? []).map((x) => x.name),
              rows: shown.rows,
              total: q.rows,
            },
          }
        : {}),
    };
  });
}

/** A run as Activity lists it: what it was, who asked, how it went, its time and cost (its helpers included). */
export interface RecentRun {
  runId: string;
  threadId: string;
  title: string;
  profile: string;
  /** Background work, or someone's conversation. */
  background: boolean;
  askedBy: string | null;
  status: string;
  queuedAt: string;
  finishedAt: string | null;
  costUsd: number;
  helpers: number;
}

/**
 * The workspace's recent runs for its owners and admins (Activity): background work, and the conversations
 * they can read (their own, and those shared with them). Someone else's private conversation isn't listed: it's theirs.
 * Lead runs only; a drafter is counted on its lead.
 */
export async function recentRuns(
  deps: LedgerDeps,
  viewer: TraceViewer,
  options: { limit?: number; before?: string; background?: boolean } = {},
): Promise<RecentRun[]> {
  if (!viewer.manages) return [];
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  return deps.withTenant(viewer.orgId, async (tx) => {
    const rows = await tx.execute<{
      id: string;
      thread_id: string;
      title: string;
      profile: string;
      channel: string;
      asked_by: string | null;
      status: string;
      queued_at: string;
      finished_at: string | null;
      cost: number | null;
      helpers: number;
    }>(sql`
      select r.id, r.thread_id, t.title, r.profile, t.channel, r.status, r.queued_at, r.finished_at,
        (select m.author_id from app.message m where m.org_id = r.org_id and m.id = r.input_message_id) as asked_by,
        -- What it spent, its drafters included, as the run's own rows keep it (runSpent reads the same).
        coalesce((r.usage->>'costUsd')::float8, 0) + coalesce((select sum((k.usage->>'costUsd')::float8)
          from app.run k where k.org_id = r.org_id and k.parent_run_id = r.id), 0) as cost,
        (select count(*) from app.run k where k.org_id = r.org_id and k.parent_run_id = r.id)::int as helpers
      from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${viewer.orgId} and r.parent_run_id is null and t.channel <> 'eval'
        and ((t.channel in (${sql.join(
          BACKGROUND.map((c) => sql`${c}`),
          sql`, `,
        )}) and not ${othersPrivateWork(viewer.userId)}) or ${threadReadableBy(viewer.userId)})
        ${
          options.background
            ? sql`and t.channel in (${sql.join(
                BACKGROUND.map((c) => sql`${c}`),
                sql`, `,
              )})`
            : sql``
        }
        ${options.before ? sql`and r.queued_at < ${options.before}::timestamptz` : sql``}
      order by r.queued_at desc
      limit ${limit}`);
    return rows.map((r) => ({
      runId: r.id,
      threadId: r.thread_id,
      title: r.title,
      profile: r.profile,
      background: BACKGROUND.includes(r.channel as (typeof BACKGROUND)[number]),
      askedBy: r.asked_by,
      status: r.status,
      queuedAt: new Date(r.queued_at).toISOString(),
      finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      costUsd: Number(r.cost ?? 0),
      helpers: Number(r.helpers),
    }));
  });
}

/**
 * Reading conversations for the Ask UI and the API: threads, their turns (each question with the run that
 * answered it), the query behind a number, and stopping a run. Everything is scoped to what the viewer may
 * see: their own threads, and the org's shared ones (visibleTo).
 */

import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { catalogModel, LEVELS, type Level, levelFor } from "../ai/catalog";
import { isProviderKind, KINDS, type ProviderKind } from "../ai/kinds";
import type { Attachment, AttachmentKind } from "../context/attachments";
import { dashboardEditableBy, dashboardReadableBy, othersPrivateWork } from "../projects/access";
import {
  appendEvent,
  type LedgerDeps,
  LISTED_CHANNELS,
  passOnFollowUps,
  type RunOutcome,
  type Viewer,
  visibleTo,
} from "./ledger";
import { threadStarredBy } from "./stars";

export type RunStatus = "queued" | "running" | "cancelling" | "succeeded" | "failed" | "cancelled";

/** How a conversation stands, from its latest run: the list's Status column and filter. */
export const THREAD_STATES = [
  "answered",
  "needs_input",
  "cannot_answer",
  "working",
  "interrupted",
  "stopped",
  "none",
] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export interface ThreadSummary {
  id: string;
  title: string;
  connectionId: string;
  sourceName: string;
  /** The source can still be asked about (not removed or disabled). */
  sourceUsable: boolean;
  createdAt: string;
  lastMessageAt: string | null;
  mine: boolean;
  /** Who started it (null for an API key's); a name comes from the auth side, which core can't read. */
  createdBy: string | null;
  /** private (its author only), project (its project's people) or org (everyone in the organization can read it). */
  visibility: "private" | "project" | "org";
  /** The project it's in, if any. */
  projectId: string | null;
  /** The folder of its project it's in. */
  folderId: string | null;
  /** Where it was asked: in OpenDash, or in Slack (the same conversation, another way in). */
  channel: "web" | "slack";
  /** The viewer starred it (theirs alone). */
  starred: boolean;
  /** How it stands, from the latest run. */
  state: ThreadState;
  /** The latest run: how the conversation stands (answered, partial, needs input, couldn't answer, running). */
  latest: {
    runId: string;
    status: RunStatus;
    outcome: RunOutcome["kind"] | null;
    answer: "answered" | "cannot_answer" | null;
  } | null;
}

export interface RunView {
  id: string;
  status: RunStatus;
  attempt: number;
  outcome: RunOutcome | null;
  error: string | null;
  usage: Record<string, number>;
  /**
   * The model it ran on, the provider it ran on (a kind, its name and who it bills) and how long it thought
   *; `ownKey`: the organization's own credentials paid for it.
   */
  model: {
    id: string;
    label: string;
    ownKey: boolean;
    provider: ProviderKind;
    providerLabel: string;
    billedTo: string;
    reasoning: Level;
    reasoningLabel: string;
  };
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  lastEventSeq: number;
}

/** Something the asker attached to a question, as its chip shows it; `title` is null once it's gone or hidden. */
export interface AttachmentChip {
  kind: AttachmentKind;
  id: string;
  title: string | null;
}

/**
 * A message sent while the turn's answer was worked on: `queued` until the run reads it at its next step,
 * then `read`; `next` when it waits for the next run instead (it has attachments), where it's that run's question.
 */
export interface FollowUp {
  id: string;
  text: string;
  createdAt: string;
  state: "queued" | "next" | "read";
}

export interface ThreadTurn {
  message: { id: string; text: string; createdAt: string; attachments: AttachmentChip[] };
  run: RunView | null;
  followUps: FollowUp[];
}

/** A run's provider; older runs ran on OpenDash. */
const providerOf = (p: string | null): ProviderKind => (isProviderKind(p) ? p : "opendash");

const iso = (v: string | Date | null) => (v ? new Date(v).toISOString() : null);

type ThreadRow = {
  id: string;
  title: string;
  connection_id: string;
  source_name: string;
  source_usable: boolean;
  created_at: string;
  last_message_at: string | null;
  mine: boolean;
  visibility: string;
  project_id: string | null;
  folder_id: string | null;
  channel: string;
  starred: boolean;
  created_by: string | null;
  run_id: string | null;
  run_status: RunStatus | null;
  outcome_kind: RunOutcome["kind"] | null;
  answer_status: "answered" | "cannot_answer" | null;
  state: ThreadState;
};

// The latest run's state, the same reading the Ask UI gives it (lib/thread-status.ts labels these).
const runState = sql`case
  when status in ('queued', 'running', 'cancelling') then 'working'
  when status = 'cancelled' then 'stopped'
  when status = 'failed' then 'interrupted'
  -- A paused run waits for the person's Continue, as a question back does.
  when outcome->>'kind' in ('clarify', 'paused') then 'needs_input'
  when outcome->>'kind' = 'no_answer' or (outcome->>'kind' = 'answer' and outcome->>'status' = 'cannot_answer')
    then 'cannot_answer'
  else 'answered' end`;

const threadSelect = (viewer: Viewer) => sql`
  select t.id, t.title, t.connection_id, c.name as source_name,
         (c.deleted_at is null and c.status <> 'disabled') as source_usable,
         t.created_at, t.last_message_at, (t.created_by is not distinct from ${viewer.userId}) as mine,
         t.visibility, t.project_id, t.folder_id, t.channel, t.created_by, ${threadStarredBy(viewer.userId)} as starred,
         r.id as run_id, r.status as run_status, r.outcome->>'kind' as outcome_kind, r.outcome->>'status' as answer_status,
         coalesce(r.state, 'none') as state
  from app.thread t
  join app.connection c on c.org_id = t.org_id and c.id = t.connection_id
  left join lateral (
    select id, status, outcome, ${runState} as state from app.run
    where org_id = t.org_id and thread_id = t.id and parent_run_id is null order by queued_at desc limit 1
  ) r on true`;

const summary = (r: ThreadRow): ThreadSummary => ({
  id: r.id,
  title: r.title,
  connectionId: r.connection_id,
  sourceName: r.source_name,
  sourceUsable: r.source_usable,
  createdAt: iso(r.created_at) as string,
  lastMessageAt: iso(r.last_message_at),
  mine: r.mine,
  createdBy: r.created_by,
  visibility: r.visibility === "org" ? "org" : r.visibility === "project" ? "project" : "private",
  projectId: r.project_id,
  folderId: r.folder_id,
  channel: r.channel === "slack" ? "slack" : "web",
  starred: r.starred,
  state: r.state,
  latest: r.run_id
    ? { runId: r.run_id, status: r.run_status as RunStatus, outcome: r.outcome_kind, answer: r.answer_status }
    : null,
});

/** The conversation list's filters. Each narrows what the viewer may already read. */
export interface ThreadFilters {
  /**
   * all: everything readable; mine: started by the viewer; shared: others' conversations shared with them; starred:
   * the ones they starred.
   */
  scope?: "all" | "mine" | "shared" | "starred";
  projectId?: string;
  state?: ThreadState;
  /** Words that must each appear in its title, a question or an answer (any case, any part of a word). */
  q?: string;
  /** Conversations where a question attached this (a definition's "Earlier about this"). */
  attached?: { kind: string; id: string };
}

/** A search's words as ILIKE patterns, the longest (most selective) first; none for a blank search. */
export function searchPatterns(q: string | undefined): string[] {
  const words = [...new Set((q ?? "").toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
  return words
    .map((w) => `%${w.slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    .sort((a, b) => b.length - a.length);
}

/** One page of the viewer's threads and the org's shared ones, newest activity first, and how many match. */
export async function listThreadPage(
  deps: LedgerDeps,
  viewer: Viewer,
  options: ThreadFilters & { limit?: number; offset?: number } = {},
): Promise<{ threads: ThreadSummary[]; total: number }> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const patterns = searchPatterns(options.q);
  const rows = await deps.withTenant(viewer.orgId, (tx) =>
    tx.execute<ThreadRow & { total: number }>(sql`
      select s.*, count(*) over ()::int as total from (
        ${threadSelect(viewer)}
        where t.org_id = ${viewer.orgId} and t.deleted_at is null and t.channel in ${LISTED_CHANNELS}
          and ${visibleTo(viewer.userId)}
          ${options.scope === "mine" ? sql`and t.created_by is not distinct from ${viewer.userId}` : sql``}
          ${options.scope === "shared" ? sql`and t.created_by is distinct from ${viewer.userId}` : sql``}
          ${options.scope === "starred" ? sql`and ${threadStarredBy(viewer.userId)}` : sql``}
          ${options.projectId ? sql`and t.project_id = ${options.projectId}` : sql``}
          ${options.state ? sql`and coalesce(r.state, 'none') = ${options.state}` : sql``}
          ${
            options.attached
              ? sql`and (exists (
                  select 1 from app.message am
                  where am.org_id = t.org_id and am.thread_id = t.id and am.role = 'user' and am.status = 'complete'
                    and am.attachments @> ${JSON.stringify([{ kind: options.attached.kind, id: options.attached.id }])}::jsonb)
                  -- An App's own conversation, the one it was built in, is about it too: without it, the panel
                  -- beside an App would show no history.
                  ${
                    options.attached.kind === "dashboard"
                      ? sql`or t.id = (select d.thread_id from app.dashboard d
                          where d.org_id = t.org_id and d.id::text = ${options.attached.id} and d.deleted_at is null)`
                      : sql``
                  })`
              : sql``
          }
          ${
            patterns.length
              ? sql`and t.id in (select app.search_threads(array[${sql.join(
                  patterns.map((p) => sql`${p}`),
                  sql`, `,
                )}]::text[]))`
              : sql``
          }
      ) s
      order by coalesce(s.last_message_at, s.created_at) desc, s.id desc limit ${limit} offset ${offset}`),
  );
  return { threads: rows.map(summary), total: rows[0]?.total ?? 0 };
}

/** The viewer's threads and the org's shared ones, newest activity first. */
export async function listThreads(
  deps: LedgerDeps,
  viewer: Viewer,
  options: ThreadFilters & { limit?: number } = {},
): Promise<ThreadSummary[]> {
  return (await listThreadPage(deps, viewer, options)).threads;
}

/** Whether this person has asked a question in this org (the setup checklist's "Ask your first question"). */
export async function hasAsked(tx: TenantTx, viewer: Viewer): Promise<boolean> {
  const [row] = await tx.execute<{ asked: boolean }>(sql`
    select exists (
      select 1 from app.message
      where org_id = ${viewer.orgId} and role = 'user' and author_id = ${viewer.userId}
    ) as asked`);
  return row?.asked ?? false;
}

/** The titles of what the viewer can still read among these attachments, by id. */
async function attachmentTitles(tx: TenantTx, viewer: Viewer, list: Attachment[]): Promise<Map<string, string>> {
  const ids = [...new Set(list.map((a) => a.id).filter(isUuid))];
  if (!ids.length) return new Map();
  const inList = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await tx.execute<{ id: string; title: string }>(sql`
    select i.id, i.title from app.context_item i
    where i.org_id = ${viewer.orgId} and i.id in (${inList}) and i.deleted_at is null and i.scope = 'org'
    union all
    -- A dashboard attached: its title while the viewer can open it.
    select d.id, d.title from app.dashboard d
    where d.org_id = ${viewer.orgId} and d.id in (${inList}) and d.deleted_at is null
      and ${dashboardReadableBy(viewer.userId)} and (d.current_version > 0 or ${dashboardEditableBy(viewer.userId)})`);

  return new Map(rows.map((r) => [r.id, r.title]));
}

/** A thread and its turns in order, or null when it doesn't exist or isn't visible. */
export async function getThread(
  deps: LedgerDeps,
  viewer: Viewer,
  threadId: string,
): Promise<{ thread: ThreadSummary; turns: ThreadTurn[] } | null> {
  if (!isUuid(threadId)) return null;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const [t] = await tx.execute<ThreadRow>(sql`
      ${threadSelect(viewer)}
      where t.org_id = ${viewer.orgId} and t.id = ${threadId} and t.deleted_at is null and ${visibleTo(viewer.userId)}`);
    if (!t) return null;
    const rows = await tx.execute<{
      message_id: string;
      text: string | null;
      created_at: string;
      attachments: Attachment[];
      mine: boolean;
      joined_to: string | null;
      queued: boolean;
      waits: boolean;
      run_id: string | null;
      status: RunStatus | null;
      attempt: number | null;
      outcome: RunOutcome | null;
      error: string | null;
      usage: (Record<string, number> & { keySource?: string }) | null;
      model: string | null;
      provider: string | null;
      reasoning: Level | null;
      queued_at: string | null;
      started_at: string | null;
      finished_at: string | null;
      last_event_seq: number | null;
    }>(sql`
      select m.id as message_id, m.text, m.created_at,
        -- Chips only: an image's bytes, a file's text and an App's code around a selected piece stay with the message,
        -- for runs.
        (select coalesce(jsonb_agg(a - 'data' - 'text' - 'snippet'), '[]'::jsonb)
          from jsonb_array_elements(m.attachments) a) as attachments,
        m.author_id is not distinct from ${viewer.userId}::uuid as mine,
        m.run_id as joined_to,
             m.status = 'queued' as queued, m.attachments <> '[]'::jsonb as waits,
             r.id as run_id, r.status, r.attempt, r.outcome, r.error, r.usage,
             r.model, r.provider, r.reasoning, r.queued_at, r.started_at, r.finished_at, r.last_event_seq
      from app.message m
      left join app.run r on r.org_id = m.org_id and r.input_message_id = m.id and r.parent_run_id is null
      where m.org_id = ${viewer.orgId} and m.thread_id = ${threadId} and m.role = 'user'
        and m.kind in ('normal', 'queued_input')
      order by m.seq nulls last, m.created_at, m.id`);
    const titles = await attachmentTitles(
      tx,
      viewer,
      rows.flatMap((r) => r.attachments ?? []),
    );
    // A follow-up goes with the run it was sent to: it's no run's question.
    const followUps = new Map<string, FollowUp[]>();
    for (const r of rows) {
      if (r.run_id || !r.joined_to) continue;
      const list = followUps.get(r.joined_to) ?? [];
      list.push({
        id: r.message_id,
        text: r.text ?? "",
        createdAt: iso(r.created_at) as string,
        state: !r.queued ? "read" : r.waits ? "next" : "queued",
      });
      followUps.set(r.joined_to, list);
    }
    return {
      thread: summary(t),
      turns: rows
        .filter((r) => r.run_id || !r.joined_to)
        .map((r) => ({
          message: {
            id: r.message_id,
            text: r.text ?? "",
            createdAt: iso(r.created_at) as string,
            // A chip is a kind, an id and a title: a file's text stays on the message, for runs only.
            attachments: (r.attachments ?? []).map((a) => ({
              kind: a.kind,
              id: a.id,
              title:
                a.kind === "file" || a.kind === "image"
                  ? (a.name ?? null)
                  : a.kind === "app_element"
                    ? // A piece of the asker's App, in its words: theirs, like the draft it came from (another
                      // reader of a shared conversation sees that something was selected, not what).
                      r.mine
                      ? (a.name ?? null)
                      : null
                    : (titles.get(a.id) ?? null),
            })),
          },
          run: r.run_id
            ? {
                id: r.run_id,
                status: r.status as RunStatus,
                attempt: r.attempt ?? 0,
                outcome: r.outcome,
                error: r.error,
                usage: r.usage ?? {},
                model: {
                  id: r.model ?? "",
                  label: catalogModel(r.model ?? "")?.label ?? r.model ?? "",
                  ownKey: r.usage?.keySource === "org",
                  provider: providerOf(r.provider),
                  providerLabel: KINDS[providerOf(r.provider)].label,
                  billedTo: KINDS[providerOf(r.provider)].billedTo,
                  reasoning: levelFor(r.model ?? "", r.reasoning),
                  reasoningLabel: LEVELS.find((l) => l.id === levelFor(r.model ?? "", r.reasoning))?.label ?? "High",
                },
                queuedAt: iso(r.queued_at) as string,
                startedAt: iso(r.started_at),
                finishedAt: iso(r.finished_at),
                lastEventSeq: r.last_event_seq ?? 0,
              }
            : null,
          followUps: r.run_id ? (followUps.get(r.run_id) ?? []) : [],
        })),
    };
  });
}

export interface QueryCard {
  id: string;
  alias: string | null;
  title: string | null;
  /** The source it ran on: a conversation can read several. */
  source: { id: string; name: string; dialect: string };
  /** The SQL that ran (the dialect's canonical text), and its parameters. */
  sql: string;
  /** The same statement as written (comments, line breaks), when what ran is the dialect's one-line form of it. */
  writtenSql: string | null;
  params: { name: string; value: unknown }[] | null;
  path: string;
  status: string;
  error: { kind?: string; message?: string } | null;
  columns: { name: string; type: string }[];
  /** At most the gateway's preview rows (100). */
  preview: unknown[][];
  rows: number | null;
  truncated: boolean;
  durationMs: number | null;
  createdAt: string;
  /**
   * For a metric query: the definitions it compiled from, at the version it read them, with how they stand now
   * (the query card's "Definitions used", the value trace's Definition row). Empty for SQL.
   */
  definitions: {
    id: string;
    kind: "dataset" | "metric";
    slug: string;
    title: string;
    version: number;
    status: string;
    verifiedBy: string | null;
  }[];
  /** For a metric query: the spec it asked (metrics, dimensions, filters, time). */
  metricQuery: unknown | null;
  /**
   * What its checks found worth a look: no rows, empty measures, a join that multiplied rows, a period that isn't over,
   * a value that isn't one of its column's. Empty when they all passed.
   */
  warnings: string[];
}

/**
 * The query behind a number (its query card and value trace): only one a run of a thread the viewer can see asked
 * for, one a dashboard or report they can read shows, or a metric check's or task's (the organization's). Its preview is
 * what the gate read, so the cell an answer cites is in it.
 */
export async function getQueryCard(deps: LedgerDeps, viewer: Viewer, queryRunId: string): Promise<QueryCard | null> {
  if (!isUuid(queryRunId)) return null;
  const [q] = await deps.withTenant(viewer.orgId, (tx) =>
    tx.execute<{
      id: string;
      alias: string | null;
      title: string | null;
      compiled_sql: string;
      written_sql: string | null;
      params: QueryCard["params"];
      path: string;
      status: string;
      error: QueryCard["error"];
      result_schema: QueryCard["columns"] | null;
      preview: unknown[][] | null;
      rows: number | null;
      truncated: boolean;
      sanity: { check?: string; status?: string; message?: string }[] | null;
      duration_ms: number | null;
      created_at: string;
      semantic: { query: unknown; definitions: { id: string; version: number }[] } | null;
      connection_id: string;
      source_name: string | null;
      source_dialect: string | null;
    }>(sql`
      select q.id, q.alias, q.title, q.compiled_sql, q.written_sql, q.params, q.path, q.status, q.error, q.result_schema, q.preview,
             q.rows, q.truncated, q.sanity, q.duration_ms, q.created_at, q.semantic,
             q.connection_id, coalesce(c.name, ms.name) as source_name, c.dialect as source_dialect
      from app.query_run q
      left join app.connection c on c.org_id = q.org_id and c.id = q.connection_id
      left join app.mcp_server ms on ms.org_id = q.org_id and ms.id = q.connection_id and q.path = 'mcp'
      where q.org_id = ${viewer.orgId} and q.id = ${queryRunId} and (
        -- An answer's query: visible with its conversation.
        (q.requester_type = 'run' and exists (
          select 1 from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
          where r.org_id = q.org_id and r.id = q.requester_id and ${visibleTo(viewer.userId)}))
        -- A dashboard's query: visible with its dashboard.
        or (q.requester_type = 'dashboard' and exists (
          select 1 from app.dashboard d where d.org_id = q.org_id and d.id = q.requester_id and d.deleted_at is null
            and ${dashboardReadableBy(viewer.userId)})
          -- A service's read: only the person it read as (or everyone, read with the workspace's account).
          and (q.path <> 'mcp' or q.semantic->'mcp'->>'reader' in ('org', ${viewer.userId ?? ""})))
        -- A metric check's query: its metric is the organization's, and so are its insights; a check
        -- nothing watches any more keeps its traces.
        or (q.requester_type = 'check' and exists (
          select 1 from app.metric_check k where k.org_id = q.org_id and k.id = q.requester_id))
        -- A task's outcome check: tasks are the organization's, like the insights they come from.
        or (q.requester_type = 'task' and exists (
          select 1 from app.todo t where t.org_id = q.org_id and t.id = q.requester_id))
        -- An insight's investigation: the organization's, like the insight it explains; a private
        -- finding's, its owner's alone.
        or (q.requester_type = 'run' and exists (
          select 1 from app.investigation v
          join app.run ir on ir.org_id = v.org_id and ir.id = v.run_id
          join app.thread t on t.org_id = ir.org_id and t.id = ir.thread_id
          where v.org_id = q.org_id and v.run_id = q.requester_id and not ${othersPrivateWork(viewer.userId)})))`),
  );
  if (!q) return null;
  const used = q.semantic?.definitions ?? [];
  const items = used.length
    ? await deps.withTenant(viewer.orgId, (tx) =>
        tx.execute<{
          id: string;
          kind: "dataset" | "metric";
          slug: string;
          title: string;
          status: string;
          verified_by: string | null;
        }>(sql`
          select id, kind, slug, title, status, verified_by from app.context_item
          where org_id = ${viewer.orgId} and id in (${sql.join(
            used.map((d) => sql`${d.id}::uuid`),
            sql`, `,
          )})`),
      )
    : [];
  return {
    id: q.id,
    alias: q.alias,
    title: q.title,
    source: { id: q.connection_id, name: q.source_name ?? "a removed source", dialect: q.source_dialect ?? "" },
    sql: q.compiled_sql,
    writtenSql: q.written_sql,
    params: q.params,
    path: q.path,
    status: q.status,
    error: q.error,
    columns: q.result_schema ?? [],
    preview: q.preview ?? [],
    rows: q.rows,
    truncated: q.truncated,
    durationMs: q.duration_ms,
    createdAt: iso(q.created_at) as string,
    definitions: used.flatMap((d) => {
      const item = items.find((i) => i.id === d.id);
      return item
        ? [
            {
              id: item.id,
              kind: item.kind,
              slug: item.slug,
              title: item.title,
              version: d.version,
              status: item.status,
              verifiedBy: item.verified_by,
            },
          ]
        : [];
    }),
    metricQuery: q.semantic?.query ?? null,
    // A truncated result says so on its own line.
    warnings: (q.sanity ?? []).flatMap((c) =>
      c.status === "warn" && c.check !== "truncated" && c.message ? [c.message] : [],
    ),
  };
}

/**
 * Shares a conversation with the organization (everyone in it can read it, its questions, answers and the queries
 * behind each number), with its project's people (a conversation in a project), or makes it private again. Only its
 * author decides; false when it isn't theirs, doesn't exist, or (for `project`) isn't in a project.
 */
export async function shareThread(
  deps: LedgerDeps,
  viewer: Viewer,
  threadId: string,
  visibility: "private" | "project" | "org",
): Promise<boolean> {
  if (!isUuid(threadId) || !viewer.userId) return false;
  const rows = await deps.withTenant(viewer.orgId, (tx) =>
    tx.execute(sql`
      update app.thread set visibility = ${visibility}
      where org_id = ${viewer.orgId} and id = ${threadId} and created_by = ${viewer.userId} and deleted_at is null
        and (${visibility} <> 'project' or project_id is not null)
      returning id`),
  );
  return rows.length > 0;
}

/**
 * Stop: a run that hasn't started is cancelled at once; a running one is marked cancelling and stops before its
 * next model call (the agent checks between steps). False when there's nothing to stop.
 */
export async function requestStop(
  deps: LedgerDeps & { boss?: PgBoss | null },
  viewer: Viewer,
  runId: string,
): Promise<boolean> {
  if (!isUuid(runId)) return false;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const [r] = await tx.execute<{ status: RunStatus; attempt: number }>(sql`
      select r.status, r.attempt from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${viewer.orgId} and r.id = ${runId} and ${visibleTo(viewer.userId)}
        and t.created_by is not distinct from ${viewer.userId}
      for update of r`);
    // Only the conversation's author stops its runs (a shared one is read by others, not driven by them).
    if (!r || (r.status !== "queued" && r.status !== "running")) return false;
    if (r.status === "queued") {
      const outcome: RunOutcome = { kind: "no_answer", reason: "Stopped." };
      await tx.execute(sql`
        update app.run set status = 'cancelled', cancel_requested_at = now(), finished_at = now(),
          outcome = ${JSON.stringify(outcome)}::jsonb
        where org_id = ${viewer.orgId} and id = ${runId}`);
      await appendEvent(tx, { orgId: viewer.orgId, id: runId, attempt: r.attempt }, "run_end", {
        status: "cancelled",
        outcome: "no_answer",
      });
      // Stop, then type: what was typed is the next question. A running run passes it on as it ends.
      await passOnFollowUps(tx, deps.boss, { orgId: viewer.orgId, id: runId });
      return true;
    }
    await tx.execute(sql`
      update app.run set status = 'cancelling', cancel_requested_at = now() where org_id = ${viewer.orgId} and id = ${runId}`);
    return true;
  });
}

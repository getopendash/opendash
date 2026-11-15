/**
 * The run ledger: submit, claim, and every write a run makes, each
 * one short transaction. The Postgres transcript is canonical, so an attempt can die anywhere and the next one rebuilds
 * exactly what the model saw.
 *
 * Every write during a run is fenced: it locks the run row and checks `attempt` and `status` first, so an attempt
 * pg-boss has given up on (a zombie) matches nothing, writes nothing, and stops.
 */

import { isUuid, type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { type Level, levelFor } from "../ai/catalog";
import { isProviderKind, type ProviderKind } from "../ai/kinds";
import type { ResolvedChart } from "../answer/chart";
import type { AnswerSegment, AnswerSegments, CheckedCrossCheck } from "../answer/gate";
import { BUDGETS } from "../budgets";
import { type Attachment, checkAttachments, skillCommand } from "../context/attachments";
import type { ContextUse } from "../context/items";
import { enqueue, enqueueOnce } from "../jobs/boss";
import { type AgentRunJob, agentInteractiveQueue, type SlackReplyJob, slackReplyQueue } from "../jobs/queues";
import type { McpCardOutcome } from "../mcp/cards";
import { othersPrivateWork, threadReadableBy } from "../projects/access";
import { assertCanAddToProject } from "../projects/projects";
import type { ComposerOutcome } from "../routines/compose";
import { checkSpend, SpendLimitReached } from "../usage/limits";
import { costOf } from "../usage/prices";
import { BACKGROUND_PROFILES, BACKGROUND_TRIGGERS } from "./background";
import type { ClarifyOutcome } from "./clarify";
import { blocksSent, PROMPT_LAYERS, type RunPrompt, type SentPrompt, sha256, withBlockOn } from "./prompt";

export interface LedgerDeps {
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}

/** The attempt this process holds. Every write carries it. */
export interface RunRef {
  orgId: string;
  id: string;
  attempt: number;
}

export interface ClaimedRun extends RunRef {
  threadId: string;
  connectionId: string;
  model: string;
  /** The provider it runs on (a kind) and how long it thinks. */
  provider: ProviderKind;
  reasoning: Level;
  /**
   * What the asker wrote in this run: its question, then each follow-up it read, so the gate lets an answer
   * repeat their numbers and the memory tools hear what they asked. A follow-up read later in the attempt is added.
   */
  question: string;
  /** The run that started this one, for a child run (a drafter, its Modeler); null otherwise. */
  parentRunId: string | null;
  /** Who asked: their memory is the run's (null for evals and background runs, which get none). */
  askedBy: string | null;
  /** The asker may try a skill's draft on this run (an owner or admin when they asked). */
  canTryDrafts: boolean;
  cancelRequested: boolean;
  /** Background work's (an investigation, a routine's): its spend is the background budget's, not the questions'. */
  background: boolean;
  /** Which agent runs it: the analyst, or the Investigator (profiles). */
  profile: string;
  /** What asked: a person (user, slack, api), an eval, or background work (insight, routine, proposal). */
  trigger: string;
  /** A learning's test: the unreleased term this run alone is given. Null on every other run. */
  candidate: { itemId: string; version: number } | null;
}

// The runs that are background work (their own module, so the spend limits can read them without a cycle).
export { BACKGROUND_PROFILES, BACKGROUND_TRIGGERS };

/** The attempt was taken over (or the run ended elsewhere): stop without writing anything more. */
export class FenceLost extends Error {
  override name = "FenceLost";
  constructor() {
    super("This attempt no longer owns the run.");
  }
}

export class RunActive extends Error {
  override name = "RunActive";
  constructor() {
    super("A question is already being answered in this conversation. Wait for it, or stop it first.");
  }
}

/**
 * Who may see a thread (alias t): its author, everyone in the org once it's shared with the org, or the project's
 * people once it's shared with its project (projects/access.ts). Callers without a user (the API, evals, `pnpm ask`)
 * see only threads without a creator. Not-found and not-allowed look the same, so a thread's existence isn't revealed
 * (TenantResourceResolver).
 */
export const visibleTo = (userId: string | null) => threadReadableBy(userId);

/** Threads that are work OpenDash does, not anyone's conversation: their owners and admins follow them. */
export const BACKGROUND_CHANNELS = ["insight", "routine", "modeler", "curator", "eval"] as const;

/**
 * The conversations people have, listed and starred: asked in OpenDash or in Slack (the same conversation
 * another way in). Evals, insights, routines and the Modeler's work are threads too, never listed with them.
 */
export const LISTED_CHANNELS = sql`('web', 'slack')`;

/** A run's thread (alias `t`) the person may follow: theirs or shared with them, or background work when they manage. */
export const runReadableBy = (userId: string | null, manages = false) =>
  manages
    ? sql`((${visibleTo(userId)} or t.channel in (${sql.join(
        BACKGROUND_CHANNELS.map((c) => sql`${c}`),
        sql`, `,
      )})) and not ${othersPrivateWork(userId)})`
    : visibleTo(userId);

/** Something the person can see but isn't theirs to change (a shared conversation's follow-ups, its sharing). */
export class NotYours extends Error {
  override name = "NotYours";
}

export class NotFound extends Error {
  override name = "NotFound";
}

/** jsonb can't hold U+0000; strip it from every string before writing (a known failure class). */
export const toJsonb = (value: unknown) =>
  JSON.stringify(value, (_key, v) => (typeof v === "string" ? v.replaceAll("\u0000", "") : v));

/** The next message number in a thread, from its counter. */
export async function nextMessageSeq(tx: TenantTx, orgId: string, threadId: string): Promise<number> {
  const [row] = await tx.execute<{ seq: number }>(sql`
    update app.thread set msg_seq = msg_seq + 1, last_message_at = now()
    where org_id = ${orgId} and id = ${threadId} returning msg_seq as seq`);
  if (!row) throw new Error("The conversation doesn't exist.");
  return row.seq;
}

/** The channel a run's new events are announced on: `runId:seq`, ids only (Streaming). */
export const RUN_EVENTS_CHANNEL = "run_events";

/**
 * Appends one event to the run's stream, numbered in order, and announces it on RUN_EVENTS_CHANNEL (delivered when the
 * transaction commits, so a listener never reads ahead of it). Call inside a fenced transaction.
 */
export async function appendEvent(tx: TenantTx, run: RunRef, type: string, data: Record<string, unknown> = {}) {
  const [row] = await tx.execute<{ seq: number }>(sql`
    update app.run set last_event_seq = last_event_seq + 1
    where org_id = ${run.orgId} and id = ${run.id} returning last_event_seq as seq`);
  const seq = row?.seq ?? 0;
  await tx.execute(sql`
    insert into app.run_event (id, org_id, run_id, attempt, seq, type, data)
    values (${uuidv7()}, ${run.orgId}, ${run.id}, ${run.attempt}, ${seq}, ${type}, ${toJsonb(data)}::jsonb)`);
  await tx.execute(sql`select pg_notify(${RUN_EVENTS_CHANNEL}, ${`${run.id}:${seq}`})`);
  return seq;
}

/** Runs `fn` in a transaction that holds the run row, only while this attempt still owns it. */
export async function fenced<T>(deps: LedgerDeps, run: RunRef, fn: (tx: TenantTx) => Promise<T>): Promise<T> {
  return deps.withTenant(run.orgId, async (tx) => {
    // FOR NO KEY UPDATE, not FOR SHARE: fenced writes go on to update the row (event seq, usage), and two share
    // locks upgrading at once would deadlock.
    const [owned] = await tx.execute<{ id: string }>(sql`
      select id from app.run
      where org_id = ${run.orgId} and id = ${run.id} and attempt = ${run.attempt} and status in ('running', 'cancelling')
      for no key update`);
    if (!owned) throw new FenceLost();
    return fn(tx);
  });
}

/** Whether someone asked this run to stop; checked by the agent before each model call. */
export async function stopRequested(deps: LedgerDeps, run: RunRef): Promise<boolean> {
  return fenced(deps, run, async (tx) => {
    // A child run stops with its parent: a Stop on the lead reaches its drafters at their next step.
    const [r] = await tx.execute<{ stop: boolean }>(sql`
      select r.cancel_requested_at is not null or coalesce(p.cancel_requested_at is not null, false) as stop
      from app.run r
      left join app.run p on p.org_id = r.org_id and p.id = r.parent_run_id
      where r.org_id = ${run.orgId} and r.id = ${run.id}`);
    return r?.stop === true;
  });
}

export interface SubmitInput {
  orgId: string;
  userId: string | null;
  /**
   * The source the question starts from: a new conversation's, or, on a follow-up, the one it switches to.
   * Absent on a follow-up, it starts where the conversation is.
   */
  connectionId?: string;
  /** Continue a conversation, or start one. */
  threadId?: string;
  text: string;
  clientMsgId?: string;
  channel: "web" | "api" | "eval" | "slack";
  model: string;
  /** The provider the model runs on (a kind), and how long it thinks; OpenDash and Auto when not given. */
  provider?: ProviderKind;
  reasoning?: Level;
  /** What the asker attached: checked here, against the conversation's source. */
  attachments?: Attachment[];
  /** The asker is an owner or admin, who may try a skill's draft (a skill's Try now). From the caller. */
  canTryDrafts?: boolean;
  /**
   * Start the conversation in this project, shared with its people: the asker must be one of its editors
   * or managers. `orgRole` is the asker's, from the caller.
   */
  project?: { id: string; orgRole: string };
  /**
   * More to write in the same transaction once the question is in (for Slack: which Slack thread it came from, and the
   * job that replies there), so none of it exists without the question, or the question without it. Not for a
   * follow-up queued on a run: that run's reply covers it.
   */
  afterSubmit?: (tx: TenantTx, submitted: { threadId: string; runId: string; messageId: string }) => Promise<void>;
}

export interface Submitted {
  threadId: string;
  runId: string;
  messageId: string;
  /** Sent while the conversation's answer was being worked on: queued on that run. */
  queued: boolean;
}

/** A run started from a follow-up between this submit's look and its own run: it tries once more, and queues. */
const STARTED_MEANWHILE = Symbol("a run started meanwhile");

/**
 * Submit: the user's message, a queued run and (with a queue) its job, in one transaction, so none exists without the
 * others. A repeated client_msg_id returns the first submit instead of asking twice. While the conversation's answer is
 * being worked on, the message is queued on that run instead: it reads it at its next step, or it's the
 * next run's question.
 */
export async function submitQuestion(
  deps: LedgerDeps & { boss: PgBoss | null },
  input: SubmitInput,
): Promise<Submitted> {
  try {
    return await submitOnce(deps, input, false);
  } catch (error) {
    if (error !== STARTED_MEANWHILE) throw error;
    return submitOnce(deps, input, true);
  }
}

async function submitOnce(
  deps: LedgerDeps & { boss: PgBoss | null },
  input: SubmitInput,
  retried: boolean,
): Promise<Submitted> {
  const raw = input.text.trim();
  if (!raw) throw new Error("Ask a question.");
  const provider = input.provider ?? "opendash";
  // None chosen: the model's own default level.
  const reasoning = levelFor(input.model, input.reasoning);
  return deps.withTenant(input.orgId, async (tx) => {
    // "/skill:<name> question": the question, with that skill attached.
    const command = await skillCommand(tx, input.orgId, raw);
    const text = command?.text ?? raw;
    const asked = command ? [...(input.attachments ?? []), command.skill] : (input.attachments ?? []);
    let threadId = input.threadId;
    let connectionId = input.connectionId ?? "";
    // The answer being worked on, if any: a follow-up joins it. Its row is locked before the thread's, the
    // order its own writes take them in. An eval's questions each stand alone.
    const [active] =
      threadId && input.channel !== "eval"
        ? await tx.execute<{ id: string; profile: string; trigger: string }>(sql`
            select id, profile, trigger from app.run
            where org_id = ${input.orgId} and thread_id = ${threadId} and parent_run_id is null
              and status in ('queued', 'running', 'cancelling')
            for update`)
        : [];
    if (threadId) {
      const [t] = await tx.execute<{ id: string; usable: boolean; mine: boolean; connection_id: string }>(sql`
        select t.id, t.connection_id, (c.deleted_at is null and c.status <> 'disabled') as usable,
          t.created_by is not distinct from ${input.userId} as mine
        from app.thread t
        join app.connection c on c.org_id = t.org_id and c.id = t.connection_id
        where t.org_id = ${input.orgId} and t.id = ${threadId} and t.deleted_at is null and ${visibleTo(input.userId)}
        for update of t`);
      if (!t) throw new NotFound("That conversation doesn't exist.");
      // A shared conversation is for reading: only its author adds to it.
      if (!t.mine) throw new NotYours("Only the person who started this conversation can add to it.");
      // Only an answer reads a follow-up: background work (an investigation, a review, a drafting batch) doesn't. And a
      // follow-up can't move the conversation to another source while the answer on this one is worked on.
      const switching = Boolean(input.connectionId && input.connectionId !== t.connection_id);
      // Nor one sent another way (the API, into an answer asked on the web): a follow-up read after the answer ends
      // starts a run with the answer's trigger, which decides what it may use (memoryRoom), so it waits for it to end.
      const elsewhere = active && active.trigger !== (input.channel === "web" ? "user" : input.channel);
      if (active && (active.profile !== "analyst" || switching || elsewhere)) throw new RunActive();
      if (input.connectionId && input.connectionId !== t.connection_id) {
        // A follow-up can start from another source: the conversation goes on from there. Sample data and
        // the organization's own stay apart: the conversation's earlier results would be cited across the line.
        const [c] = await tx.execute<{ id: string; sample: boolean; was_sample: boolean }>(sql`
          select c.id, coalesce((c.config->>'sample')::boolean, false) as sample,
            coalesce((w.config->>'sample')::boolean, false) as was_sample
          from app.connection c
          join app.connection w on w.org_id = c.org_id and w.id = ${t.connection_id}
          where c.org_id = ${input.orgId} and c.id = ${input.connectionId} and c.deleted_at is null
            and c.status not in ('disabled', 'error')`);
        if (!c) throw new NotFound("That source doesn't exist, was removed, or failed its last check.");
        if (c.sample !== c.was_sample) {
          throw new NotYours(
            c.sample
              ? "This conversation is about your own data: ask about the sample data in a new conversation."
              : "This conversation is about sample data: ask about your own data in a new conversation.",
          );
        }
        await tx.execute(sql`
          update app.thread set connection_id = ${input.connectionId} where org_id = ${input.orgId} and id = ${threadId}`);
        connectionId = input.connectionId;
      } else {
        // A follow-up from the thread's source needs it: removed or disabled, it says so instead of failing later.
        if (!t.usable) {
          throw new NotFound("This conversation's source was removed or disabled. Pick another source to go on.");
        }
        connectionId = t.connection_id;
      }
      if (input.clientMsgId) {
        // A follow-up's run is the one it was queued on, or the one it started.
        const [dup] = await tx.execute<{ id: string; run_id: string; queued: boolean }>(sql`
          select m.id, coalesce(r.id, m.run_id) as run_id, (m.kind = 'queued_input' and m.status = 'queued') as queued
          from app.message m
          left join app.run r on r.org_id = m.org_id and r.input_message_id = m.id
          where m.org_id = ${input.orgId} and m.thread_id = ${threadId} and m.client_msg_id = ${input.clientMsgId}`);
        if (dup?.run_id) return { threadId, runId: dup.run_id, messageId: dup.id, queued: dup.queued };
      }
    } else {
      const [c] = input.connectionId
        ? await tx.execute<{ id: string }>(sql`
            select id from app.connection
            where org_id = ${input.orgId} and id = ${input.connectionId} and deleted_at is null and status <> 'disabled'`)
        : [];
      if (!c) throw new NotFound("That source doesn't exist or was removed.");
      if (input.project) {
        if (!input.userId) throw new NotYours("Only a person starts a conversation in a project.");
        await assertCanAddToProject(
          tx,
          { orgId: input.orgId, userId: input.userId, orgRole: input.project.orgRole },
          input.project.id,
        );
      }
      threadId = uuidv7();
      await tx.execute(sql`
        insert into app.thread (org_id, id, connection_id, created_by, title, channel, project_id, visibility)
        values (${input.orgId}, ${threadId}, ${connectionId}, ${input.userId},
          ${text.length > 80 ? `${text.slice(0, 79)}…` : text}, ${input.channel}, ${input.project?.id ?? null},
          ${input.project ? "project" : "private"})`);
    }
    // A spend limit reached refuses the question; one already running finishes.
    await checkSpend(tx, input.orgId);
    const attachments = asked.length
      ? await checkAttachments(tx, { orgId: input.orgId, userId: input.userId }, connectionId, asked, {
          canTryDrafts: input.canTryDrafts ?? false,
        })
      : [];
    if (active) {
      // Queued on the answer being worked on, with no place in the transcript until it's read; the model it was sent
      // with is the next run's, if it comes to that.
      const messageId = uuidv7();
      await tx.execute(sql`
        insert into app.message (org_id, id, thread_id, run_id, role, kind, status, author_id, client_msg_id, content,
          text, attachments, model, provider, reasoning)
        values (${input.orgId}, ${messageId}, ${threadId}, ${active.id}, 'user', 'queued_input', 'queued',
          ${input.userId}, ${input.clientMsgId ?? null}, ${toJsonb({ role: "user", content: text })}::jsonb, ${text},
          ${JSON.stringify(attachments)}::jsonb, ${input.model}, ${provider}, ${reasoning})`);
      return { threadId, runId: active.id, messageId, queued: true };
    }
    const seq = await nextMessageSeq(tx, input.orgId, threadId);
    const messageId = uuidv7();
    await tx.execute(sql`
      insert into app.message (org_id, id, thread_id, seq, role, author_id, client_msg_id, content, text, attachments)
      values (${input.orgId}, ${messageId}, ${threadId}, ${seq}, 'user', ${input.userId}, ${input.clientMsgId ?? null},
        ${toJsonb({ role: "user", content: text })}::jsonb, ${text}, ${JSON.stringify(attachments)}::jsonb)`);
    const runId = uuidv7();
    const [created] = await tx.execute<{ id: string }>(sql`
      insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, provider, reasoning,
        can_try_drafts)
      values (${input.orgId}, ${runId}, ${threadId}, ${connectionId}, ${input.channel === "web" ? "user" : input.channel},
        ${messageId}, ${input.model}, ${provider}, ${reasoning}, ${input.canTryDrafts ?? false})
      on conflict (org_id, thread_id) where parent_run_id is null and status in ('queued', 'running', 'cancelling')
      do nothing returning id`);
    // A run this submit's look missed (another submit's, or one a follow-up started as the last answer ended): once
    // more, and it queues there.
    if (!created) throw input.channel !== "eval" && !retried ? STARTED_MEANWHILE : new RunActive();
    if (deps.boss) {
      await enqueue<AgentRunJob>(
        deps.boss,
        tx,
        agentInteractiveQueue,
        { orgId: input.orgId, runId },
        { singletonKey: runId },
      );
    }
    await input.afterSubmit?.(tx, { threadId, runId, messageId });
    return { threadId, runId, messageId, queued: false };
  });
}

/** The triggers of a question a person asked (the web, the API, Slack): it's answered only while they may ask. */
const ASKED_BY_PERSON: readonly string[] = ["user", "api", "slack"];

/**
 * Claim: this attempt takes the run (attempt + 1). A running run is taken over without asking, because pg-boss hands
 * a job out again only after giving up on the previous attempt. Null when the run already ended, or when its asker
 * may no longer ask (it ends then, saying why).
 */
export async function claimRun(
  deps: LedgerDeps & { boss?: PgBoss | null },
  job: AgentRunJob,
  workerId: string,
  /**
   * A child run is claimed only by its parent's attempt that runs it, while that attempt still holds the
   * parent: a parent attempt that lost its fence can't take its child from the one that holds it now.
   */
  options: { parent?: { id: string; attempt: number } } = {},
): Promise<ClaimedRun | null> {
  const parent = options.parent ?? null;
  return deps.withTenant(job.orgId, async (tx) => {
    // The parent first, locked while the child is claimed (parent then child, as everywhere): a takeover of the
    // parent waits for this claim to commit, or this claim sees the attempt that took over, and refuses.
    if (parent) {
      const [holds] = await tx.execute<{ id: string }>(sql`
        select id from app.run
        where org_id = ${job.orgId} and id = ${parent.id} and attempt = ${parent.attempt}
          and status in ('running', 'cancelling')
        for share`);
      if (!holds) return null;
    }
    const [row] = await tx.execute<{
      attempt: number;
      thread_id: string;
      model: string;
      provider: string;
      reasoning: string;
      last_event_seq: number;
      cancel_requested_at: string | null;
      can_try_drafts: boolean;
      trigger: string;
      profile: string;
      parent_run_id: string | null;
      candidate: { itemId?: unknown; version?: unknown } | null;
    }>(sql`
      update app.run set status = 'running', attempt = attempt + 1, worker_id = ${workerId},
        attempt_started_at = now(), started_at = coalesce(started_at, now())
      where org_id = ${job.orgId} and id = ${job.runId} and status in ('queued', 'running', 'cancelling')
        and (${parent?.id ?? null}::uuid is null or parent_run_id = ${parent?.id ?? null}::uuid)
      returning attempt, thread_id, model, provider, reasoning, last_event_seq, cancel_requested_at, can_try_drafts,
        trigger, profile, parent_run_id, candidate`);
    if (!row) return null;
    // What the asker wrote in this run: its question, then the follow-ups it read.
    const [ctx] = await tx.execute<{ connection_id: string; text: string; author_id: string | null }>(sql`
      select coalesce(r.connection_id, t.connection_id) as connection_id, m.author_id,
        concat_ws(${FOLLOW_UP_SEP}, m.text, (
          select string_agg(f.text, ${FOLLOW_UP_SEP} order by f.seq) from app.message f
          where f.org_id = r.org_id and f.run_id = r.id and f.role = 'user' and f.seq is not null)) as text
      from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      join app.message m on m.org_id = r.org_id and m.id = r.input_message_id
      where r.org_id = ${job.orgId} and r.id = ${job.runId}`);
    // A question works only while its asker may ask: one who left, or can only read now, since it was
    // asked (or since its follow-up was queued) gets no answer, and nothing reads the source for them.
    const askedByPerson = ctx?.author_id && !row.parent_run_id && ASKED_BY_PERSON.includes(row.trigger);
    let role: string | null = null;
    if (askedByPerson) {
      const [m] = await tx.execute<{ role: string | null }>(
        sql`select app.member_role(${ctx.author_id}::uuid) as role`,
      );
      role = m?.role ?? null;
      if (!role || role === "viewer") {
        const reason = role
          ? "Its asker can only read in this workspace now, so it wasn't answered."
          : "Its asker is no longer a member of this workspace, so it wasn't answered.";
        await tx.execute(sql`
          update app.run set status = 'failed', error = ${reason}, finished_at = now(),
            outcome = ${toJsonb({ kind: "no_answer", reason })}::jsonb
          where org_id = ${job.orgId} and id = ${job.runId}`);
        await appendEvent(tx, { orgId: job.orgId, id: job.runId, attempt: row.attempt }, "run_end", {
          status: "failed",
          outcome: "no_answer",
        });
        // Drafters an earlier attempt started end with it: nothing would run them for an ended lead.
        await endChildren(tx, { orgId: job.orgId, id: job.runId });
        await passOnFollowUps(tx, deps.boss, { orgId: job.orgId, id: job.runId });
        return null;
      }
    }
    const run: ClaimedRun = {
      orgId: job.orgId,
      id: job.runId,
      attempt: row.attempt,
      threadId: row.thread_id,
      connectionId: ctx?.connection_id as string,
      model: row.model,
      provider: isProviderKind(row.provider) ? row.provider : "opendash",
      reasoning: levelFor(row.model, row.reasoning),
      question: ctx?.text ?? "",
      parentRunId: row.parent_run_id,
      askedBy: ctx?.author_id ?? null,
      // As the asker's role is now, not when it was asked: an admin made a member since tries no drafts.
      canTryDrafts: row.can_try_drafts && (!askedByPerson || role === "owner" || role === "admin"),
      cancelRequested: row.cancel_requested_at !== null,
      background:
        (BACKGROUND_TRIGGERS as readonly string[]).includes(row.trigger) ||
        (BACKGROUND_PROFILES as readonly string[]).includes(row.profile),
      profile: row.profile,
      trigger: row.trigger,
      // Only a learning's test carries one (the database refuses it on any other trigger).
      candidate:
        row.trigger === "proposal" &&
        typeof row.candidate?.itemId === "string" &&
        isUuid(row.candidate.itemId) &&
        Number.isInteger(row.candidate.version)
          ? { itemId: row.candidate.itemId, version: row.candidate.version as number }
          : null,
    };
    // Clients drop anything streamed after this seq by an earlier attempt.
    await appendEvent(tx, run, "attempt_started", { attempt: row.attempt, discardAfterSeq: row.last_event_seq });
    return run;
  });
}

/**
 * What the run has used so far, across its attempts, as the ledger recorded it: its model calls' cost, its finished
 * tool calls, the queries its query tools ran and those that failed (a failed check counts, as it does while the run
 * works), the deltas it streamed, and its earlier attempts: how long they worked and how many ended in a failure. A new
 * attempt starts from here, so a retry never gets a fresh allowance or a fresh clock.
 */
export async function runSpent(
  deps: LedgerDeps,
  run: RunRef,
): Promise<{
  costUsd: number;
  toolCalls: number;
  queries: number;
  failedQueries: number;
  deltas: number;
  /** The earlier attempts' working time: each from its first event to its last. */
  workedMs: number;
  /** Earlier attempts that ended in a failure: any not ended by a shutdown hand-off (a crash records no end). */
  failedAttempts: number;
  /** Its model calls so far: the step budget is the run's, not the attempt's. */
  modelCalls: number;
  /** Whether it was already nudged to finish (a nudge, not a report, is in its transcript): only a few steps are left. */
  nudged: boolean;
}> {
  return deps.withTenant(run.orgId, async (tx) => {
    const [row] = await tx.execute<{
      cost_usd: number;
      tool_calls: number;
      queries: number;
      failed_queries: number;
      deltas: number;
      model_calls: number;
      nudged: boolean;
    }>(sql`
      -- Its children's spend is its own too: a parent's dollars cover what it started.
      select coalesce((r.usage->>'costUsd')::float8, 0) + coalesce((select sum((k.usage->>'costUsd')::float8)
          from app.run k where k.org_id = r.org_id and k.parent_run_id = r.id), 0) as cost_usd,
        coalesce((r.usage->>'modelCalls')::int, 0) as model_calls,
        exists (select 1 from app.message n
          where n.org_id = r.org_id and n.run_id = r.id and n.role = 'system_note' and n.kind <> 'report') as nudged,
        (select count(*)::int from app.tool_call c
          where c.org_id = r.org_id and c.run_id = r.id and c.status in ('succeeded', 'failed')) as tool_calls,
        (select count(*)::int from app.run_event e
          where e.org_id = r.org_id and e.run_id = r.id and e.type = 'delta') as deltas,
        (count(q.id) filter (where q.mode = 'execute' and c.tool in ('sql_query', 'metric_query')))::int as queries,
        (count(q.id) filter (where q.status <> 'succeeded'))::int as failed_queries
      from app.run r
      left join app.tool_call c on c.org_id = r.org_id and c.run_id = r.id
        and c.tool in ('sql_query', 'metric_query', 'sql_check')
      left join app.query_run q on q.org_id = c.org_id and q.tool_call_id = c.id and q.requester_type = 'run'
        and q.requester_id = r.id
      where r.org_id = ${run.orgId} and r.id = ${run.id}
      group by r.org_id, r.id, r.usage`);
    const attempts = await tx.execute<{ ms: number; reason: string | null }>(sql`
      select extract(epoch from max(created_at) - min(created_at)) * 1000 as ms,
        max(data->>'reason') filter (where type = 'attempt_ended') as reason
      from app.run_event
      where org_id = ${run.orgId} and run_id = ${run.id} and attempt < ${run.attempt}
      group by attempt`);
    return {
      costUsd: Number(row?.cost_usd ?? 0),
      toolCalls: row?.tool_calls ?? 0,
      queries: row?.queries ?? 0,
      failedQueries: row?.failed_queries ?? 0,
      deltas: row?.deltas ?? 0,
      workedMs: Math.round(attempts.reduce((n, a) => n + Number(a.ms ?? 0), 0)),
      failedAttempts: attempts.filter((a) => a.reason !== "shutdown").length,
      modelCalls: row?.model_calls ?? 0,
      nudged: row?.nudged ?? false,
    };
  });
}

/**
 * Why an attempt ended, recorded as its last event (fenced: an attempt that lost the run can't write one): it
 * finished, was stopped, spent its budget or time, the model failed (and how), the job expired, or the worker shut
 * down and handed it off. A new attempt counts the earlier ones' failures from these. The run keeps them too, after
 * its events are dropped, for the trace; an attempt that crashed records none.
 */
export type AttemptEnd =
  | "finished"
  | "stopped"
  | "budget"
  | "paused"
  | "out_of_time"
  | "model_busy"
  | "model_stalled"
  | "model_too_long"
  | "model_refused"
  | "job_expired"
  | "shutdown"
  | "error";

export async function recordAttemptEnd(deps: LedgerDeps, run: RunRef, reason: AttemptEnd): Promise<void> {
  await fenced(deps, run, (tx) => endAttempt(tx, run, reason)).catch((error: unknown) => {
    // An attempt that lost the run writes nothing more: the attempt that owns it now records its own end.
    if (!(error instanceof FenceLost)) throw error;
  });
}

async function endAttempt(tx: TenantTx, run: RunRef, reason: AttemptEnd): Promise<void> {
  await appendEvent(tx, run, "attempt_ended", { attempt: run.attempt, reason });
  await tx.execute(sql`
    update app.run set attempts = attempts || jsonb_build_array(jsonb_build_object(
      'attempt', ${run.attempt}::int, 'started', attempt_started_at, 'ended', now(), 'reason', ${reason}::text))
    where org_id = ${run.orgId} and id = ${run.id}`);
}

export interface ModelUsage {
  /** All input tokens: uncached, read from the cache and written to it. */
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  /** Read from the cache. */
  cachedInputTokens?: number;
  /** Written to the cache (priced above plain input). */
  cacheWriteTokens?: number;
  /** Neither; when the provider doesn't say, input less what was read and written. */
  noCacheTokens?: number;
  /**
   * The cache gave back less than the call before left in it: the tokens lost, and why when known
   * (a fold rewrote earlier messages, or the cache expired while idle); "unexplained" is the one to look into.
   */
  cacheMiss?: { lostTokens: number; cause: "folded" | "idle" | "unexplained" };
}

/**
 * Model call end: the assistant message, before any of its tool calls run (the loop awaits this), with the call's
 * usage on the run and as a usage_event, in one transaction.
 */
export async function commitAssistantMessage(
  deps: LedgerDeps,
  run: ClaimedRun,
  call: {
    content: unknown[];
    text: string;
    reasoning: string;
    usage: ModelUsage;
    finishReason: string;
    /** The model's provider, and whose key paid: the organization's own, or the deployment's. */
    provider: string;
    keySource: "org" | "deployment";
  },
): Promise<string | null> {
  return fenced(deps, run, async (tx) => {
    // A call that produced nothing is billed but not stored: an empty assistant message can't be replayed.
    const id = call.content.length ? uuidv7() : null;
    const seq = id ? await nextMessageSeq(tx, run.orgId, run.threadId) : null;
    if (id)
      await tx.execute(sql`
      insert into app.message (org_id, id, thread_id, run_id, seq, role, content, text, usage, model, stop_reason)
      values (${run.orgId}, ${id}, ${run.threadId}, ${run.id}, ${seq}, 'assistant',
        ${toJsonb({ role: "assistant", content: call.content })}::jsonb, ${call.text || null},
        ${toJsonb(call.usage)}::jsonb, ${run.model}, ${call.finishReason})`);
    const u = call.usage;
    // Priced now, once, at today's price: the run's total and the usage_event hold the same rounded figure, so they
    // reconcile exactly, and a later price change doesn't rewrite this call.
    const read = u.cachedInputTokens ?? 0;
    const written = u.cacheWriteTokens ?? 0;
    const cost = costOf(run.model, {
      noCacheTokens: u.noCacheTokens ?? Math.max(0, (u.inputTokens ?? 0) - read - written),
      cacheReadTokens: read,
      cacheWriteTokens: written,
      outputTokens: u.outputTokens ?? 0,
    });
    await tx.execute(sql`
      update app.run set usage = jsonb_build_object(
        'inputTokens', coalesce((usage->>'inputTokens')::int, 0) + ${u.inputTokens ?? 0},
        'outputTokens', coalesce((usage->>'outputTokens')::int, 0) + ${u.outputTokens ?? 0},
        'reasoningTokens', coalesce((usage->>'reasoningTokens')::int, 0) + ${u.reasoningTokens ?? 0},
        'cachedInputTokens', coalesce((usage->>'cachedInputTokens')::int, 0) + ${read},
        'cacheWriteTokens', coalesce((usage->>'cacheWriteTokens')::int, 0) + ${written},
        'modelCalls', coalesce((usage->>'modelCalls')::int, 0) + 1,
        'keySource', ${call.keySource}::text,
        'costUsd', round(coalesce((usage->>'costUsd')::numeric, 0) + ${cost ?? 0}::numeric, 6),
        'unpricedCalls', coalesce((usage->>'unpricedCalls')::int, 0) + ${cost === null ? 1 : 0})
      where org_id = ${run.orgId} and id = ${run.id}`);
    await tx.execute(sql`
      insert into app.usage_event (id, org_id, kind, qty, unit, model, provider, key_source, cost_usd, source_type,
        source_id, user_id, background)
      values (${uuidv7()}, ${run.orgId}, 'llm_tokens', ${(u.inputTokens ?? 0) + (u.outputTokens ?? 0)}, 'tokens',
        ${run.model}, ${call.provider}, ${call.keySource}, ${cost}::numeric, 'run', ${run.id}, ${run.askedBy},
        ${run.background ?? false})`);
    const toolCalls = call.content
      .filter((p): p is { type: "tool-call"; toolCallId: string; toolName: string; input: unknown } =>
        Boolean(p && (p as { type?: string }).type === "tool-call"),
      )
      .map((p) => ({ callId: p.toolCallId, tool: p.toolName, input: p.input }));
    await appendEvent(tx, run, "assistant_message", {
      messageId: id,
      text: call.text,
      reasoning: call.reasoning,
      toolCalls,
    });
    return id;
  });
}

export type ToolCallRow =
  | { id: string; status: "started" }
  | { id: string; status: "succeeded"; result: unknown }
  | { id: string; status: "failed"; error: string };

/**
 * Tool start: the ledger row for this call. A call that already finished (delivered again after a retry) comes back
 * with its stored result, so it never runs twice.
 */
export async function startToolCall(
  deps: LedgerDeps,
  run: ClaimedRun,
  call: {
    callId: string;
    tool: string;
    /** What the call does: read, compute, internal or external; read when not said. */
    effect?: "read" | "compute" | "internal" | "external";
    args: unknown;
    messageId: string | null;
  },
): Promise<ToolCallRow> {
  return fenced(deps, run, async (tx) => {
    const [row] = await tx.execute<{ id: string; status: string; result: unknown; error: string | null }>(
      sql`
      insert into app.tool_call (org_id, id, run_id, message_id, call_id, tool, effect_class, args, attempt)
      values (${run.orgId}, ${uuidv7()}, ${run.id}, ${call.messageId}, ${call.callId}, ${call.tool},
        ${call.effect ?? "read"}, ${toJsonb(call.args ?? {})}::jsonb, ${run.attempt})
      on conflict (org_id, run_id, call_id) do update set
        attempt = excluded.attempt,
        status = case when app.tool_call.status in ('succeeded', 'failed') then app.tool_call.status else 'started' end
      returning id, status, result, error`,
    );
    if (!row) throw new Error("Couldn't record the tool call.");
    if (row.status === "succeeded") return { id: row.id, status: "succeeded", result: row.result };
    if (row.status === "failed") return { id: row.id, status: "failed", error: row.error ?? "The tool failed." };
    await appendEvent(tx, run, "tool_started", { callId: call.callId, tool: call.tool, input: call.args });
    return { id: row.id, status: "started" };
  });
}

/** A tool result as the AI SDK writes it into the transcript: json for objects, error-text for failures. */
export function toolResultMessage(
  callId: string,
  tool: string,
  outcome: { ok: true; value: unknown } | { ok: false; error: string },
) {
  return {
    role: "tool" as const,
    content: [
      {
        type: "tool-result" as const,
        toolCallId: callId,
        toolName: tool,
        output: outcome.ok
          ? { type: "json" as const, value: outcome.value }
          : { type: "error-text" as const, value: outcome.error },
      },
    ],
  };
}

/**
 * Tool end: the ledger row, the tool_result message and the event, in one transaction, so a call can't have
 * succeeded without its result being in the transcript.
 */
export async function finishToolCall(
  deps: LedgerDeps,
  run: ClaimedRun,
  call: {
    callId: string;
    tool: string;
    outcome: { ok: true; value: unknown } | { ok: false; error: string };
    queryRunId?: string | null;
    status?: "succeeded" | "failed" | "unknown";
    summary?: Record<string, unknown>;
  },
): Promise<void> {
  await fenced(deps, run, async (tx) => {
    const status = call.status ?? (call.outcome.ok ? "succeeded" : "failed");
    await tx.execute(sql`
      update app.tool_call set status = ${status}, finished_at = now(),
        result = ${call.outcome.ok ? toJsonb(call.outcome.value) : null}::jsonb,
        error = ${call.outcome.ok ? null : call.outcome.error}, query_run_id = ${call.queryRunId ?? null}
      where org_id = ${run.orgId} and run_id = ${run.id} and call_id = ${call.callId}`);
    const seq = await nextMessageSeq(tx, run.orgId, run.threadId);
    await tx.execute(sql`
      insert into app.message (org_id, id, thread_id, run_id, seq, role, content)
      values (${run.orgId}, ${uuidv7()}, ${run.threadId}, ${run.id}, ${seq}, 'tool_result',
        ${toJsonb(toolResultMessage(call.callId, call.tool, call.outcome))}::jsonb)`);
    await appendEvent(tx, run, "tool_result", {
      callId: call.callId,
      tool: call.tool,
      status,
      ...(call.outcome.ok ? {} : { error: call.outcome.error }),
      // The query behind a step, for the Sources panel: every query, cited or not.
      ...(call.queryRunId ? { queryRunId: call.queryRunId } : {}),
      ...call.summary,
    });
  });
}

/** Which profile a run is for (a background job's: the Investigator's or the Reviewer's), or null. */
export async function runProfileOf(tx: TenantTx, orgId: string, runId: string): Promise<string | null> {
  if (!isUuid(runId)) return null;
  const [r] = await tx.execute<{ profile: string }>(sql`
    select profile from app.run where org_id = ${orgId} and id = ${runId}`);
  return r?.profile ?? null;
}

/** Gives a successful query its conversation alias (q1, q2…), the name answers cite it by. */
export async function assignAlias(deps: LedgerDeps, run: ClaimedRun, queryRunId: string): Promise<string> {
  return fenced(deps, run, async (tx) => {
    const [row] = await tx.execute<{ n: number }>(sql`
      update app.thread set query_seq = query_seq + 1
      where org_id = ${run.orgId} and id = ${run.threadId} returning query_seq as n`);
    const alias = `q${row?.n ?? 1}`;
    await tx.execute(sql`
      update app.query_run set alias = ${alias} where org_id = ${run.orgId} and id = ${queryRunId}`);
    return alias;
  });
}

type Part = { type?: string; toolCallId?: string; toolName?: string };
type Message = { role: string; content: unknown };

const INTERRUPTED =
  "This call was interrupted before it finished (the worker restarted). Call it again if you still need it.";
const ENDED = "This call didn't finish: the run it belonged to ended first.";

/**
 * A note from OpenDash to the model (a nudge to finish), marked where the transcript is rebuilt from its row: its text
 * starts "(OpenDash)", but a person's question could too, and only the row says which it is. Providers ignore the mark.
 */
export const NOTE_MARK = { opendash: { note: true } } as const;

export const isNote = (m: { role: string; providerOptions?: unknown }): boolean =>
  m.role === "user" && (m.providerOptions as typeof NOTE_MARK | undefined)?.opendash?.note === true;

/**
 * A person's message a run read while it worked: part of the turn it joined, never that turn's question,
 * so the question keeps its block and the run's own steps stay one turn. Providers ignore the mark.
 */
export const FOLLOW_UP_MARK = { opendash: { followUp: true } } as const;

/** Between a run's question and each follow-up it read, in what the asker wrote in the run (ClaimedRun.question). */
export const FOLLOW_UP_SEP = "\n\n";

export const isFollowUp = (m: { role: string; providerOptions?: unknown }): boolean =>
  m.role === "user" && (m.providerOptions as typeof FOLLOW_UP_MARK | undefined)?.opendash?.followUp === true;

/**
 * Rebuild: the transcript from Postgres, in seq order, with consecutive tool results merged into one message. Any
 * tool call of this run left without a result (the attempt died between committing the call and finishing it) is
 * resolved first: the AI SDK refuses to call the model while one is unresolved. Reads are cheap and idempotent, so
 * the resolution tells the model the call was interrupted rather than re-running it behind its back. An earlier run's
 * call left without one (it was stopped, or failed, mid-call) is resolved in the transcript only: that run has ended,
 * and its record stays as it ended. Each earlier question carries the block it was sent with, so it reads
 * as it did then and the prompt cache holds; this run's own is prepared again by its attempt.
 */
export async function rebuildTranscript(deps: LedgerDeps, run: ClaimedRun): Promise<Message[]> {
  const load = () =>
    deps.withTenant(run.orgId, (tx) =>
      tx.execute<{ id: string; content: Message; run_id: string | null; role: string }>(sql`
        select id, content, run_id, role from app.message
        where org_id = ${run.orgId} and thread_id = ${run.threadId} and seq is not null and status = 'complete'
        order by seq`),
    );
  let rows = await load();
  const blocks = await deps.withTenant(run.orgId, (tx) => blocksSent(tx, run));
  const answered = new Set<string>();
  for (const r of rows) {
    if (r.content.role !== "tool") continue;
    for (const p of r.content.content as Part[]) if (p.toolCallId) answered.add(p.toolCallId);
  }
  const unresolved = rows
    .filter((r) => r.run_id === run.id && r.content.role === "assistant" && Array.isArray(r.content.content))
    .flatMap((r) =>
      (r.content.content as Part[]).filter((p) => p.type === "tool-call" && !answered.has(p.toolCallId ?? "")),
    );
  for (const p of unresolved) {
    await fenced(deps, run, async (tx) => {
      await tx.execute(sql`
        insert into app.tool_call (org_id, id, run_id, call_id, tool, args, attempt, status, error, finished_at)
        values (${run.orgId}, ${uuidv7()}, ${run.id}, ${p.toolCallId as string}, ${p.toolName as string}, '{}'::jsonb,
          ${run.attempt}, 'unknown', ${INTERRUPTED}, now())
        on conflict (org_id, run_id, call_id) do update set status = 'unknown', error = ${INTERRUPTED},
          finished_at = now()`);
      const seq = await nextMessageSeq(tx, run.orgId, run.threadId);
      await tx.execute(sql`
        insert into app.message (org_id, id, thread_id, run_id, seq, role, content)
        values (${run.orgId}, ${uuidv7()}, ${run.threadId}, ${run.id}, ${seq}, 'tool_result',
          ${toJsonb(toolResultMessage(p.toolCallId as string, p.toolName as string, { ok: false, error: INTERRUPTED }))}::jsonb)`);
      await appendEvent(tx, run, "tool_result", {
        callId: p.toolCallId,
        tool: p.toolName,
        status: "unknown",
        error: INTERRUPTED,
      });
    });
  }
  if (unresolved.length) rows = await load();
  // Each call's result goes right after the message that made it, wherever its row sits: a result written later (an
  // interrupted call resolved here, after a note from OpenDash) would otherwise land past the next message, and the
  // providers refuse a call whose result doesn't follow it.
  const results = new Map<string, unknown>();
  for (const r of rows) {
    if (r.content.role !== "tool") continue;
    for (const p of r.content.content as Part[]) if (p.toolCallId) results.set(p.toolCallId, p);
  }
  const messages: Message[] = [];
  for (const { id, content, run_id, role } of rows) {
    if (content.role === "tool") continue;
    const m = { ...content, content: Array.isArray(content.content) ? [...content.content] : content.content };
    messages.push({
      ...(role === "user" ? withBlockOn(m, blocks.get(id) ?? "") : m),
      ...(role === "system_note" ? { providerOptions: NOTE_MARK } : {}),
    });
    if (content.role !== "assistant" || !Array.isArray(content.content)) continue;
    const parts: unknown[] = [];
    for (const p of content.content as Part[]) {
      if (p.type !== "tool-call" || !p.toolCallId) continue;
      const result = results.get(p.toolCallId);
      if (result) parts.push(result);
      else if (run_id !== run.id) {
        parts.push(...toolResultMessage(p.toolCallId, p.toolName ?? "tool", { ok: false, error: ENDED }).content);
      }
    }
    if (parts.length) messages.push({ role: "tool", content: parts });
  }
  return messages;
}

/**
 * What a run streams while it works: its thinking, its answer's text and the queries being written, as a
 * `delta` event, fenced to the attempt. Shown live and never kept as the answer: the checked outcome replaces it.
 */
export async function recordDelta(deps: LedgerDeps, run: RunRef, data: Record<string, unknown>): Promise<void> {
  await fenced(deps, run, (tx) => appendEvent(tx, run, "delta", data).then(() => undefined));
}

/**
 * A note from OpenDash to the model, kept in the transcript so every attempt sees it: a nudge to finish, or, with
 * `kind: "report"`, a report that's never read as one (work picked up when the run resumed). With a `key`,
 * it's written once: a note with the same key in the thread is kept and this one isn't (false).
 */
export async function appendNote(
  deps: LedgerDeps,
  run: ClaimedRun,
  text: string,
  options: { kind?: "report"; key?: string } = {},
): Promise<boolean> {
  return fenced(deps, run, async (tx) => {
    const key = options.key ?? null;
    if (key) {
      const [had] = await tx.execute<{ id: string }>(sql`
        select id from app.message where org_id = ${run.orgId} and thread_id = ${run.threadId} and client_msg_id = ${key}`);
      if (had) return false;
    }
    const seq = await nextMessageSeq(tx, run.orgId, run.threadId);
    await tx.execute(sql`
      insert into app.message (org_id, id, thread_id, run_id, seq, role, kind, client_msg_id, content, text)
      values (${run.orgId}, ${uuidv7()}, ${run.threadId}, ${run.id}, ${seq}, 'system_note', ${options.kind ?? "normal"},
        ${key}, ${toJsonb({ role: "user", content: text })}::jsonb, ${text})`);
    await appendEvent(tx, run, "note", { text });
    return true;
  });
}

/**
 * A lead's drafter starting or ending, as an event on the lead's own stream, fenced to its attempt: what the
 * source's drafting card follows. The trace reads the drafter's own rows; these are only for following it.
 */
export async function recordChild(
  deps: LedgerDeps,
  run: RunRef,
  type: "child_started" | "child_ended",
  data: { runId: string; tables: string[]; status?: string; costUsd?: number },
): Promise<void> {
  await fenced(deps, run, (tx) => appendEvent(tx, run, type, data).then(() => undefined));
}

/**
 * What the attempt was given from the glossary and guides, as an event, so the outcome says which
 * versions the analyst read even if one is approved while it works.
 */
export async function recordContext(
  deps: LedgerDeps,
  run: ClaimedRun,
  items: ContextUse[],
  glossary = "",
  files = "",
): Promise<void> {
  await fenced(deps, run, (tx) =>
    appendEvent(tx, run, "context", { items, glossary, ...(files ? { files } : {}) }).then(() => undefined),
  );
}

/**
 * The attempt's prompt, stored before its first model call: each layer's text once by its hash
 * (runs/prompt.ts), and the hashes, the tools offered and what the conversation layer held on the run. A layer sent
 * again is renewed, row-locked, so the hourly clean-up (dropUnusedPrompts) can't take it from under this run.
 */
export async function recordPrompt(deps: LedgerDeps, run: RunRef, sent: SentPrompt): Promise<RunPrompt> {
  const texts = PROMPT_LAYERS.flatMap((layer) =>
    sent[layer] ? [{ layer, text: sent[layer], hash: sha256(sent[layer]) }] : [],
  );
  const prompt: RunPrompt = {
    attempt: run.attempt,
    ...Object.fromEntries(texts.map((t) => [t.layer, t.hash])),
    verified: sent.verified,
    tools: sent.tools,
    attached: sent.attached,
    memories: sent.memories,
  };
  await fenced(deps, run, async (tx) => {
    for (const t of texts) {
      await tx.execute(sql`
        insert into app.prompt_text (org_id, sha256, text) values (${run.orgId}, ${t.hash}, ${t.text})
        on conflict (org_id, sha256) do update set created_at = now()`);
    }
    await tx.execute(sql`
      update app.run set prompt = ${toJsonb(prompt)}::jsonb where org_id = ${run.orgId} and id = ${run.id}`);
  });
  return prompt;
}

/**
 * The last context the run recorded: its items, the glossary values the gate lets the answer echo, and the numbers in
 * the asker's files, which it may repeat as theirs.
 */
export async function recordedContext(
  deps: LedgerDeps,
  run: ClaimedRun,
): Promise<{ items: ContextUse[]; glossary: string; files: string }> {
  const [e] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ data: { items?: ContextUse[]; glossary?: string; files?: string } }>(sql`
      select data from app.run_event where org_id = ${run.orgId} and run_id = ${run.id} and type = 'context'
      order by seq desc limit 1`),
  );
  return { items: e?.data.items ?? [], glossary: e?.data.glossary ?? "", files: e?.data.files ?? "" };
}

/** Finished calls of one tool in this run, newest first: answers so far, or a clarify that ended the run. */
export async function finishedToolCalls(deps: LedgerDeps, run: ClaimedRun, tool: string) {
  return deps.withTenant(run.orgId, (tx) =>
    tx.execute<{ call_id: string; args: Record<string, unknown>; result: Record<string, unknown> | null }>(sql`
      select call_id, args, result from app.tool_call
      where org_id = ${run.orgId} and run_id = ${run.id} and tool = ${tool} and status = 'succeeded'
      order by finished_at desc`),
  );
}

/** Results this conversation can cite, by alias, for the answer gate. */
export async function citableResults(deps: LedgerDeps, run: ClaimedRun) {
  return deps.withTenant(run.orgId, (tx) =>
    tx.execute<{
      alias: string;
      id: string;
      result_schema: { name: string; type: string }[] | null;
      preview: unknown[][] | null;
      path: "metric" | "raw_sql";
    }>(sql`
      select q.alias, q.id, q.result_schema, q.preview, q.path from app.query_run q
      join app.run r on r.org_id = q.org_id and r.id = q.requester_id
      where q.org_id = ${run.orgId} and r.thread_id = ${run.threadId} and q.requester_type = 'run'
        and q.alias is not null and q.status = 'succeeded' and q.mode = 'execute'`),
  );
}

/**
 * One of this conversation's earlier results, by its alias, as the gateway kept it (its first rows, the ones an answer
 * can cite): read back when its rows were folded out of the model's view, without running it again. Only the
 * conversation's own runs' results; nothing is read from the source.
 */
export async function threadResult(deps: LedgerDeps, run: ClaimedRun, alias: string) {
  const [row] = await deps.withTenant(run.orgId, (tx) =>
    tx.execute<{
      alias: string;
      title: string | null;
      result_schema: { name: string; type: string }[] | null;
      preview: unknown[][] | null;
      rows: number | null;
      truncated: boolean;
    }>(sql`
      select q.alias, q.title, q.result_schema, q.preview, q.rows, q.truncated from app.query_run q
      join app.run r on r.org_id = q.org_id and r.id = q.requester_id
      where q.org_id = ${run.orgId} and r.thread_id = ${run.threadId} and q.requester_type = 'run'
        and q.alias = ${alias} and q.status = 'succeeded' and q.mode = 'execute'
      limit 1`),
  );
  return row ?? null;
}

/**
 * A person's run that paused: at its dollar ceiling, the end of a working slice, or its steps.
 * Everything it did is kept; the person's "Continue" is the next turn, which sees it all.
 */
export interface PausedOutcome {
  kind: "paused";
  /** Its ceiling, what's left under the workspace's monthly or daily limit, a slice's time, or its steps. */
  reason: "ceiling" | "limit" | "time" | "steps";
  spentUsd: number;
  ceilingUsd: number | null;
}

export type RunOutcome =
  | {
      kind: "answer";
      status: "answered" | "cannot_answer";
      verified: boolean;
      markdown: string;
      rendered: string;
      interpretation: string[];
      caveats: string[];
      citations: unknown[];
      values: unknown[];
      problems: string[];
      /** The answer, caveats and chips in pieces, for traced numbers (absent on older runs). */
      segments?: AnswerSegments;
      /** What the gate checked: numbers shown from references, claims, cross-checks. */
      checked?: { numbers: number; claims: number; crossChecks: number };
      /** Each cross-check with both cells and values (absent on older runs, and when there were none). */
      crossChecks?: CheckedCrossCheck[];
      /**
       * How its numbers were computed: metric when every query they cite came from verified definitions, unmodelled
       * otherwise (absent on older runs: unmodelled).
       */
      path?: "metric" | "unmodelled";
      /** Charts from the answer's query results, every point a cell (absent before charts existed). */
      charts?: ResolvedChart[];
      /** Up to three follow-ups it can answer, as the person would ask them: what it can do instead. */
      next?: string[];
      /** The glossary terms and guides the analyst was given or found, each at its version. */
      context?: ContextUse[];
    }
  | ClarifyOutcome
  | { kind: "no_answer"; reason: string }
  | PausedOutcome
  | InvestigationOutcome
  | ModelerOutcome
  | CuratorOutcome
  | ComposerOutcome
  | McpCardOutcome
  | DashboardPlanOutcome;

/**
 * The dashboard the analyst means to build or change: a card the person says "Build it" to, or replies to
 * change. Read from the run's finished `dashboard_plan` call.
 */
export interface DashboardPlanOutcome {
  kind: "dashboard_plan";
  /** The conversation's dashboard it changes; null for a new one. */
  dashboardId: string | null;
  title: string;
  /** What it's for, in a line. */
  purpose: string;
  /** What it reads: datasets, or tables its own SQL reads (absent on older plans). */
  datasets?: string[];
  /** What its data can't do yet, said before Build it. */
  notes?: string[];
  filters?: { id: string; kind: string; label: string }[];
  /** Its pages as tabs, or down a sidebar (absent on older plans: tabs). */
  nav?: string;
  /** Its pages and their sections, with the ids, kinds, widths and chart types the dashboard will have. */
  pages: {
    id?: string;
    title: string;
    /** Its sections, a list with the record beside it, or one record. */
    layout?: string;
    sections: {
      id?: string;
      kind: string;
      title: string;
      width?: string;
      /** A chart's kind: its type, or stacked, ranked, small multiples. */
      chart?: string;
      detail?: string;
      /** For a list: the changes each row can make in a service ("Move to Done in Jira"). */
      changes?: string[];
      /** A KPI's trend under it, and its target's meter. */
      trend?: boolean;
      target?: boolean;
    }[];
  }[];
  /** The sections that will be custom parts, by name. */
  custom: string[];
  /** What it took from a reference the person attached: pages, pieces as sections, look, and the data's fit. */
  reference?: {
    from: string[];
    pages: string;
    pieces: { piece: string; as: string }[];
    look?: string;
    data: { state: "have" | "instead" | "missing"; say: string }[];
  };
}

/**
 * The Curator's end: one term it learned from corrections, as fields code then validates, checks, tests
 * and keeps as a proposed version; or why there's nothing to learn. Settled into its proposal (`settleLearning`).
 */
export interface CuratorOutcome {
  kind: "curator";
  status: "proposed" | "discarded";
  learning?: {
    term: string;
    means: string;
    synonyms: string[];
    /** Where it lives in the data: schema.table.column, compared with `values` when there are some. */
    column?: string;
    values?: string[];
    /** The tables it must never be read as (schema.table). */
    not: string[];
    /** The words of a correction it was built from, as they were written: code checks they're someone's. */
    quote: string;
    /** A question its test asks: "How many paying accounts do we have?". */
    question: string;
  };
  reason?: string;
}

/**
 * The Modeler's end (Make this a metric, or Draft definitions): it proposed definitions that passed
 * their tests (and why), or said why it couldn't draft one; over a source's tables, what it left out and why. Its
 * proposal is settled from this (`settleProposal`).
 */
export interface ModelerOutcome {
  kind: "modeler";
  status: "proposed" | "cannot_draft";
  items: { kind: "dataset" | "metric"; slug: string; title: string }[];
  rationale?: string;
  reason?: string;
  leftOut?: { name: string; reason: string }[];
}

/** A text through the gate, as the UI shows it: plain, and in pieces for traced numbers. */
export interface GatedText {
  rendered: string;
  segments: AnswerSegment[];
}

/**
 * The Investigator's write-up of an insight: whether counting it again another way confirmed
 * the change, what moved, why (most likely first, each saying how much it explains), and what the data couldn't say.
 * Every figure is a reference the gate resolved to a cell of the investigation's own queries.
 */
export interface InvestigationOutcome {
  kind: "investigation";
  confirmed: boolean;
  verified: boolean;
  moved: GatedText;
  reasons: (GatedText & { weight: "explains" | "part" })[];
  unchecked: GatedText[];
  citations: unknown[];
  problems: string[];
}

/**
 * A child run's task, as its parent gave it: what it was asked to do, the same each time it's asked, so a
 * parent that asks again (after a crash, say) finds the child it started.
 */
export interface ChildTask {
  tables: string[];
}

const taskKey = (task: ChildTask) => ({ tables: [...new Set(task.tables.map((t) => t.trim().toLowerCase()))].sort() });

/**
 * A child run of `parent` for `task`: the one the parent started for it already, or a new one in a thread
 * of its own (nobody's conversation: channel `modeler`), its brief as the thread's message, on the parent's model and
 * source. Its transcript, claims and fence are its own; `parent_run_id` ties it back. The caller holds the parent's
 * fence, so a parent that lost its run starts nothing.
 */
/** The child `parent` started for `task`, if it started one. */
export async function findChildRun(
  tx: TenantTx,
  parent: { orgId: string; id: string },
  task: ChildTask,
): Promise<string | null> {
  const [r] = await tx.execute<{ id: string }>(sql`
    select id from app.run
    where org_id = ${parent.orgId} and parent_run_id = ${parent.id} and task = ${toJsonb(taskKey(task))}::jsonb`);
  return r?.id ?? null;
}

export async function childRun(
  tx: TenantTx,
  parent: { orgId: string; id: string },
  input: { profile: "drafter"; task: ChildTask; title: string; brief: () => Promise<string> },
): Promise<{ runId: string; created: boolean }> {
  const task = taskKey(input.task);
  const found = () => findChildRun(tx, parent, input.task);
  const existing = await found();
  if (existing) return { runId: existing, created: false };
  const [p] = await tx.execute<{
    thread_id: string;
    connection_id: string;
    created_by: string | null;
    model: string;
    provider: string;
    reasoning: string;
    trigger: string;
  }>(sql`
    select t.id as thread_id, coalesce(r.connection_id, t.connection_id) as connection_id, t.created_by, r.model,
      r.provider, r.reasoning, r.trigger
    from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where r.org_id = ${parent.orgId} and r.id = ${parent.id}`);
  if (!p) throw new Error("The parent run doesn't exist.");
  const brief = await input.brief();
  const threadId = uuidv7();
  const messageId = uuidv7();
  const runId = uuidv7();
  await tx.execute(sql`
    insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${parent.orgId}, ${threadId}, ${p.connection_id}, ${p.created_by}, ${input.title.slice(0, 80)},
      'modeler', 'private')`);
  await tx.execute(sql`
    insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
    values (${parent.orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, parent.orgId, threadId)}, 'user',
      ${p.created_by}, ${toJsonb({ role: "user", content: brief })}::jsonb, ${brief})`);
  const [created] = await tx.execute<{ id: string }>(sql`
    insert into app.run (org_id, id, thread_id, connection_id, trigger, profile, input_message_id, model, provider,
      reasoning, parent_run_id, task)
    values (${parent.orgId}, ${runId}, ${threadId}, ${p.connection_id}, ${p.trigger}, ${input.profile}, ${messageId},
      ${p.model}, ${p.provider}, ${p.reasoning}, ${parent.id}, ${toJsonb(task)}::jsonb)
    on conflict do nothing returning id`);
  return created ? { runId, created: true } : { runId: (await found()) as string, created: false };
}

/** A parent's children still under way when it ends, ended with it: none is left running with no one to run it. */
async function endChildren(tx: TenantTx, parent: { orgId: string; id: string }) {
  const ended = await tx.execute<{ id: string; attempt: number }>(sql`
    update app.run set status = 'failed', error = 'It ended with the run that started it.', finished_at = now(),
      outcome = ${toJsonb({ kind: "no_answer", reason: "It ended with the run that started it." })}::jsonb
    where org_id = ${parent.orgId} and parent_run_id = ${parent.id} and status in ('queued', 'running', 'cancelling')
    returning id, attempt`);
  for (const k of ended) {
    await appendEvent(tx, { orgId: parent.orgId, id: k.id, attempt: k.attempt }, "run_end", {
      status: "failed",
      outcome: "no_answer",
    });
  }
}

/**
 * A run that ended with follow-ups still queued: the first is the next run's question, in the transaction
 * that ended this one (its row locked), and the rest queue on that run. A Slack conversation's reply goes on to it.
 * The spend limit is checked again here: reached since they were sent, each is a question refused at once, with why,
 * so none runs and none is left waiting on an ended run. Returns the next run's id, or null.
 */
export async function passOnFollowUps(
  tx: TenantTx,
  boss: PgBoss | null | undefined,
  ended: { orgId: string; id: string },
): Promise<string | null> {
  // The run's reply in Slack, if it's unfinished (its job stopped meanwhile): taken up again now the run has ended
  //. One still at work on it keeps it, and nothing more is queued.
  if (boss) {
    const [unfinished] = await tx.execute<{ run_id: string }>(sql`
      select run_id from app.slack_reply where org_id = ${ended.orgId} and run_id = ${ended.id} and status = 'streaming'`);
    if (unfinished) {
      await enqueueOnce<SlackReplyJob>(
        boss,
        tx,
        slackReplyQueue,
        { orgId: ended.orgId, runId: ended.id },
        { singletonKey: ended.id },
      );
    }
  }
  const queued = await tx.execute<{
    id: string;
    thread_id: string;
    model: string | null;
    provider: string | null;
    reasoning: string | null;
  }>(sql`
    select id, thread_id, model, provider, reasoning from app.message
    where org_id = ${ended.orgId} and run_id = ${ended.id} and kind = 'queued_input' and status = 'queued'
    order by created_at, id
    for update`);
  if (!queued.length) return null;
  const [prev] = await tx.execute<{
    trigger: string;
    model: string;
    provider: string;
    reasoning: string;
    can_try_drafts: boolean;
    connection_id: string;
  }>(sql`
    select r.trigger, r.model, r.provider, r.reasoning, r.can_try_drafts, t.connection_id from app.run r
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where r.org_id = ${ended.orgId} and r.id = ${ended.id}`);
  if (!prev) return null;
  const refused = await checkSpend(tx, ended.orgId).then(
    () => null,
    (error: unknown) => {
      if (error instanceof SpendLimitReached) return error.message;
      throw error;
    },
  );
  /** The message as a question, its run (refused: ended at once), and its jobs; Slack replies on the first one only. */
  let replied = false;
  const ask = async (m: (typeof queued)[number]) => {
    const seq = await nextMessageSeq(tx, ended.orgId, m.thread_id);
    await tx.execute(sql`
      update app.message set seq = ${seq}, kind = 'normal', status = 'complete', run_id = null
      where org_id = ${ended.orgId} and id = ${m.id}`);
    const runId = uuidv7();
    const outcome: RunOutcome | null = refused ? { kind: "no_answer", reason: refused } : null;
    await tx.execute(sql`
      insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, provider, reasoning,
        can_try_drafts, status, error, outcome, finished_at)
      values (${ended.orgId}, ${runId}, ${m.thread_id}, ${prev.connection_id}, ${prev.trigger}, ${m.id},
        ${m.model ?? prev.model}, ${m.model ? (m.provider ?? "opendash") : prev.provider},
        ${m.model ? levelFor(m.model, m.reasoning) : prev.reasoning}, ${prev.can_try_drafts}, ${refused ? "failed" : "queued"},
        ${refused},
        ${outcome ? toJsonb(outcome) : null}::jsonb, ${refused ? sql`now()` : null})`);
    if (refused) {
      await appendEvent(tx, { orgId: ended.orgId, id: runId, attempt: 0 }, "run_end", {
        status: "failed",
        outcome: "no_answer",
      });
    }
    const [slack] = replied
      ? []
      : await tx.execute<{ run_id: string }>(sql`
          insert into app.slack_reply (org_id, run_id, team_id, slack_thread_id, slack_user_id, slack_message_ts)
          select org_id, ${runId}, team_id, slack_thread_id, slack_user_id, null from app.slack_reply
          where org_id = ${ended.orgId} and run_id = ${ended.id}
          on conflict do nothing returning run_id`);
    replied = true;
    if (boss && !refused) {
      await enqueue<AgentRunJob>(
        boss,
        tx,
        agentInteractiveQueue,
        { orgId: ended.orgId, runId },
        { singletonKey: runId },
      );
    }
    if (boss && slack) {
      await enqueue<SlackReplyJob>(boss, tx, slackReplyQueue, { orgId: ended.orgId, runId }, { singletonKey: runId });
    }
    return runId;
  };
  if (refused) {
    for (const m of queued) await ask(m);
    return null;
  }
  const [first, ...rest] = queued;
  if (!first) return null;
  const runId = await ask(first);
  if (rest.length) {
    await tx.execute(sql`
      update app.message set run_id = ${runId}
      where org_id = ${ended.orgId} and id in (${sql.join(
        rest.map((m) => sql`${m.id}::uuid`),
        sql`, `,
      )})`);
  }
  return runId;
}

/**
 * Finalize: the run's outcome and terminal status, and the run_end event, in one transaction; with a follow-up still
 * queued, the next run starts in it too.
 */
export async function finalizeRun(
  deps: LedgerDeps & { boss?: PgBoss | null },
  run: ClaimedRun,
  status: "succeeded" | "failed" | "cancelled",
  outcome: RunOutcome,
  error: string | null = null,
  /** Why the attempt that finalizes ended, recorded in the same transaction as the run's end. */
  attemptEnd?: AttemptEnd,
): Promise<void> {
  await fenced(deps, run, async (tx) => {
    if (attemptEnd) await endAttempt(tx, run, attemptEnd);
    await tx.execute(sql`
      update app.run set status = ${status}, outcome = ${toJsonb(outcome)}::jsonb, error = ${error},
        finished_at = now()
      where org_id = ${run.orgId} and id = ${run.id}`);
    await appendEvent(tx, run, "run_end", { status, outcome: outcome.kind });
    await endChildren(tx, run);
    await passOnFollowUps(tx, deps.boss, run);
    // The verified queries this answer followed guided one more answer: counted here, with the run's end, once.
    const followed =
      outcome.kind === "answer"
        ? (outcome.context ?? []).filter((c) => c.kind === "verified_query" && c.followed).map((c) => c.id)
        : [];
    if (followed.length) {
      await tx.execute(sql`
        update app.context_item set usage_count = usage_count + 1
        where org_id = ${run.orgId} and kind = 'verified_query' and id in (${sql.join(
          followed.map((id) => sql`${id}::uuid`),
          sql`, `,
        )})`);
    }
  });
}

/**
 * Dead-letter handler: the job is gone for good, so the run fails with a plain reason. Not fenced by attempt (no
 * attempt is running), only by status: an ended run stays as it is.
 */
export async function failRunFromQueue(
  deps: LedgerDeps & { boss?: PgBoss | null },
  job: AgentRunJob,
  reason: string,
  /** Only while it's still queued from before this time (failStaleQueuedRuns): one a worker took since stays. */
  queuedBefore?: string,
): Promise<boolean> {
  return deps.withTenant(job.orgId, async (tx) => {
    const unfinished = queuedBefore
      ? sql`status = 'queued' and queued_at < ${queuedBefore}::timestamptz`
      : sql`status in ('queued', 'running', 'cancelling')`;
    const [row] = await tx.execute<{ attempt: number }>(sql`
      update app.run set status = 'failed', error = ${reason}, finished_at = now(),
        outcome = ${toJsonb({ kind: "no_answer", reason })}::jsonb
      where org_id = ${job.orgId} and id = ${job.runId} and ${unfinished}
      returning attempt`);
    if (!row) return false;
    await appendEvent(tx, { orgId: job.orgId, id: job.runId, attempt: row.attempt }, "run_end", {
      status: "failed",
      outcome: "no_answer",
    });
    await endChildren(tx, { orgId: job.orgId, id: job.runId });
    await passOnFollowUps(tx, deps.boss, { orgId: job.orgId, id: job.runId });
    return true;
  });
}

/**
 * Runs queued longer than pg-boss keeps a waiting job (BUDGETS.agent.queuedMaxSeconds) fail, saying so: their job is
 * gone or about to be, and the spend room they held goes back (usage/limits.ts). The dispatcher's, 50 a minute.
 */
export async function failStaleQueuedRuns(
  deps: LedgerDeps & { withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>; boss?: PgBoss | null },
  now = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - BUDGETS.agent.queuedMaxSeconds * 1000).toISOString();
  const stale = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from app.run
      where status = 'queued' and parent_run_id is null and queued_at < ${before}::timestamptz
      order by queued_at limit 50`),
  );
  let failed = 0;
  for (const r of stale) {
    const reason = "It waited too long for a worker to take it: ask again.";
    if (await failRunFromQueue(deps, { orgId: r.org_id, runId: r.id }, reason, before)) failed += 1;
  }
  return failed;
}

/** Who is reading a run: its events and outcome are visible only to those who can see its thread. */
export interface Viewer {
  orgId: string;
  userId: string | null;
}

/** The run's events after `afterSeq`, for clients that poll and for `pnpm ask`. Empty when the thread isn't visible. */
export async function runEvents(
  deps: LedgerDeps,
  viewer: Viewer,
  runId: string,
  afterSeq = 0,
  options: { manages?: boolean } = {},
) {
  return deps.withTenant(viewer.orgId, async (tx) => {
    const events = await tx.execute<{
      seq: number;
      attempt: number;
      type: string;
      data: Record<string, unknown>;
      created_at: string;
      author: string | null;
    }>(sql`
      select e.seq, e.attempt, e.type, e.data, e.created_at, t.created_by as author from app.run_event e
      join app.run r on r.org_id = e.org_id and r.id = e.run_id
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where e.org_id = ${viewer.orgId} and e.run_id = ${runId} and e.seq > ${afterSeq}
        and ${runReadableBy(viewer.userId, options.manages)}
        -- What streamed is for watching it work: once the run ended, its outcome and committed events say it all.
        and (e.type <> 'delta' or r.status in ('queued', 'running', 'cancelling'))
      order by e.seq`);
    const author = events[0]?.author ?? null;
    if (!events.length || author === viewer.userId) return events;
    // Someone else reading a shared conversation: a run given its asker's memory keeps what the model wrote along the
    // way to the asker (working notes, notes, the inputs it gave tools), since any of it may repeat a memory; so
    // does a run that read a service as the asker (their own MCP connection), and one that worked on the asker's
    // dashboard draft. The answer and its query cards stay: they're what was shared.
    const [given] = await tx.execute<{ yes: boolean }>(sql`
      select true as yes from app.run_event
      where org_id = ${viewer.orgId} and run_id = ${runId} and type = 'context'
        and data->'items' @> '[{"kind": "memory"}]'::jsonb
      union all
      ${readAsAskerBefore(viewer.orgId, runId)}
      union all
      ${draftWorkIn(viewer.orgId, runId)}
      limit 1`);
    if (!given) return events;
    return events.map((e) => ({ ...e, data: readerView(e.type, e.data) }));
  });
}

/**
 * Whether this run, or one before it in its conversation, could work on its asker's dashboard draft: what
 * a draft holds is the owner's alone until they publish it, and the conversation carries it, so another reader sees
 * structure only. Read from the run's recorded prompt (given the dashboard tools and their skill, recorded before its
 * first model call, so nothing it writes is ever shown first), and from the calls themselves. A row when so.
 */
export const draftWorkIn = (orgId: string, runId: string) => sql`
  select true as yes from app.run r
  join app.run me on me.org_id = r.org_id and me.id = ${runId}
  where r.org_id = ${orgId} and r.thread_id = me.thread_id and r.queued_at <= me.queued_at
    and (r.prompt->'attached' @> ${toJsonb([{ id: BUILD_A_DASHBOARD }])}::jsonb
      -- Given an attached dashboard's draft (its owner asked, in any channel), with or without the tools.
      or r.prompt->'attached' @> ${toJsonb([{ kind: "dashboard", draft: true }])}::jsonb
      -- Given a piece of the asker's App they selected (select to edit): its code is theirs like the draft's.
      or r.prompt->'attached' @> ${toJsonb([{ kind: "app_element" }])}::jsonb
      or exists (
        select 1 from app.tool_call c
        where c.org_id = r.org_id and c.run_id = r.id
          and c.tool in ('dashboard_save', 'dashboard_open', 'dashboard_page', 'dashboard_plan', 'dashboard_start')))`;

/** The record id of the analyst's build-an-app skill (its tools come with it): `builtinId` in @opendash/agent. */
const BUILD_A_DASHBOARD = "opendash/build-an-app";

/**
 * Whether this run, or one before it in its conversation, read a service as the asker (their own MCP connection):
 * the conversation carries what came back, so any later run may repeat it. Read from the calls
 * themselves (kept as long as the conversation; events expire), including calls recorded before they carried their
 * scope, and from events while they last. A row when so.
 */
export const readAsAskerBefore = (orgId: string, runId: string) => sql`
  select true as yes from app.tool_call c
  join app.run r on r.org_id = c.org_id and r.id = c.run_id
  join app.run me on me.org_id = r.org_id and me.id = ${runId}
  where c.org_id = ${orgId} and r.thread_id = me.thread_id and r.queued_at <= me.queued_at
    and c.tool = 'mcp_call' and c.status = 'succeeded'
    and (c.result->>'scope' = 'personal' or c.result->>'read_as' = 'the person''s own account')
  union all
  select true as yes from app.run_event e
  join app.run r on r.org_id = e.org_id and r.id = e.run_id
  join app.run me on me.org_id = r.org_id and me.id = ${runId}
  where e.org_id = ${orgId} and r.thread_id = me.thread_id and r.queued_at <= me.queued_at
    and e.type = 'tool_result' and e.data->>'tool' = 'mcp_call' and e.data->>'scope' = 'personal'`;

/**
 * What a reader who isn't the author sees of an event of a run given the asker's memory: structure only, by allow-list
 * (which tool, its status, ids, counts), never text the model wrote, since any of it may repeat a memory. The answer
 * itself is the outcome, which is what was shared.
 */
const KEPT: Record<string, readonly string[]> = {
  attempt_started: ["attempt", "discardAfterSeq"],
  attempt_ended: ["attempt", "reason"],
  assistant_message: ["messageId"],
  tool_started: ["callId", "tool"],
  tool_result: [
    "callId",
    "tool",
    "status",
    "queryRunId",
    "alias",
    "rows",
    "truncated",
    "durationMs",
    // The gateway's own words about a result (no rows, a partial period, a value not in its column), as its card shows.
    "warnings",
    "accepted",
    "verified",
    "numbers",
    "crossChecks",
    "failed",
  ],
  context: ["items"],
  run_end: ["status", "outcome"],
};

function readerView(type: string, data: Record<string, unknown>): Record<string, unknown> {
  const kept = Object.fromEntries((KEPT[type] ?? []).filter((k) => k in data).map((k) => [k, data[k]]));
  // A tool call's identity (no input), so the steps still line up.
  if (type === "assistant_message" && Array.isArray(data.toolCalls)) {
    kept.toolCalls = (data.toolCalls as { callId?: string; tool?: string }[]).map((c) => ({
      callId: c.callId,
      tool: c.tool,
    }));
  }
  return { ...kept, redacted: true };
}

/** A run's state and outcome, or null when it doesn't exist or its thread isn't visible. */
export async function getRun(deps: LedgerDeps, viewer: Viewer, runId: string, options: { manages?: boolean } = {}) {
  const [row] = await deps.withTenant(viewer.orgId, (tx) =>
    tx.execute<{
      status: string;
      attempt: number;
      outcome: RunOutcome | null;
      error: string | null;
      usage: Record<string, number>;
      thread_id: string;
    }>(sql`
      select r.status, r.attempt, r.outcome, r.error, r.usage, r.thread_id from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${viewer.orgId} and r.id = ${runId} and ${runReadableBy(viewer.userId, options.manages)}`),
  );
  return row ?? null;
}

/**
 * What an answer's PDF says it is: the question, where it was answered from, by which workspace, and when. Reads no
 * access: its callers checked the run first (getRun, or the Slack reply's own run).
 */
export async function answerAbout(
  tx: TenantTx,
  orgId: string,
  runId: string,
): Promise<{ question: string; sourceName: string; organization: string; answeredAt: string } | null> {
  const [r] = await tx.execute<{
    question: string | null;
    title: string;
    source_name: string;
    organization: string;
    finished_at: string | null;
  }>(sql`
    select m.text as question, t.title, c.name as source_name, o.name as organization, r.finished_at
    from app.run r
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    join app.connection c on c.org_id = r.org_id and c.id = coalesce(r.connection_id, t.connection_id)
    join app.org o on o.id = r.org_id
    left join app.message m on m.org_id = r.org_id and m.id = r.input_message_id
    where r.org_id = ${orgId} and r.id = ${runId}`);
  if (!r) return null;
  return {
    question: (r.question ?? "").trim() || r.title,
    sourceName: r.source_name,
    organization: r.organization,
    answeredAt: new Date(r.finished_at ?? Date.now()).toISOString(),
  };
}

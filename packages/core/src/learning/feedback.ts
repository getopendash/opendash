/**
 * Feedback on answers (explicit signals): a thumbs up or down on an answer, with a reason, and "this is
 * wrong" on one of its numbers. One row per person per target, changed in place. Admins read reports in Knowledge →
 * Feedback and on the definitions the answer used.
 *
 * A thumbs down that says what was wrong is a correction: it's kept at once as the person's memory, so their
 * next questions follow it, and as a draft guide on the answer's source, so once an admin approves it every analyst
 * does. Taking the thumbs back undoes both (the guide only while it's a draft).
 *
 * Only answers in a conversation the person can see take feedback, and a number only from that answer's queries.
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { forgetMemory, MEMORY_MAX, rememberFact } from "../context/memory";
import { type LedgerDeps, type Viewer, visibleTo } from "../runs/ledger";
import { signalCorrection, withdrawSignal } from "./curator";

export type FeedbackKind = "up" | "down" | "wrong_number";
export const REASONS = ["wrong_number", "wrong_definition", "missing_context", "misread_question", "other"] as const;
export type ReasonCode = (typeof REASONS)[number];

export interface FeedbackInput {
  runId: string;
  /** For "this number is wrong": the query it was read from, and its reference (q2:0:mrr). */
  queryRunId?: string;
  claimKey?: string;
  kind: FeedbackKind;
  reasonCode?: ReasonCode;
  comment?: string;
  /** What the person says is right ("412k", "it should exclude refunds"). */
  correction?: string;
}

export interface MyFeedback {
  /** The answer's thumbs, if any. */
  answer: {
    kind: "up" | "down";
    reasonCode: ReasonCode | null;
    comment: string | null;
    /** What a correction given with a thumbs down was kept as (its note). */
    correction: CorrectionKept | null;
  } | null;
  /** The numbers reported as wrong, by reference. */
  numbers: string[];
}

const MAX_COMMENT = 2_000;

/** Feedback's deps: a correction is kept in a transaction that carries the person, whose memory is theirs alone. */
export type FeedbackDeps = LedgerDeps & {
  withUser?: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
};

/** What a correction was kept as: the person's memory, and the guide it proposes to the team. */
export interface CorrectionKept {
  /** What the person wrote. */
  text: string;
  memory: { fact: string } | null;
  /** A guide proposed from it, in earlier versions; null since. */
  guideId: string | null;
  /** The learning it opened or joined: the Curator turns it into a team term an admin can approve. */
  learningId?: string | null;
}

/** A correction as feedback.correction holds it. */
interface StoredCorrection {
  text?: string;
  fact?: string;
  /** The memory the correction made, undone with it: none when the person already had that memory. */
  memoryId?: string;
  guideId?: string;
  learningId?: string;
}

const wordCount = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** The correction as one memory: its first sentence when that says something ("Wrong." doesn't), within a memory. */
function asFact(text: string): string {
  const all = text.replace(/\s+/g, " ").trim();
  const first = all.split(/(?<=[.!?])\s/)[0] ?? all;
  const fact = wordCount(first) >= 3 ? first : all;
  return fact.length > MEMORY_MAX ? `${fact.slice(0, MEMORY_MAX - 1).trimEnd()}…` : fact;
}

/** In the person's transaction when one can be opened (`personal`: their memory can be read and written). */
const inTransaction = <T>(deps: FeedbackDeps, viewer: Viewer, fn: (tx: TenantTx, personal: boolean) => Promise<T>) =>
  deps.withUser && viewer.userId
    ? deps.withUser(viewer.orgId, viewer.userId, (tx) => fn(tx, true))
    : deps.withTenant(viewer.orgId, (tx) => fn(tx, false));

async function answerVisible(tx: TenantTx, viewer: Viewer, runId: string): Promise<boolean> {
  const [r] = await tx.execute<{ ok: boolean }>(sql`
    select true as ok from app.run r
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where r.org_id = ${viewer.orgId} and r.id = ${runId} and r.status = 'succeeded'
      and r.outcome->>'kind' = 'answer' and t.deleted_at is null and ${visibleTo(viewer.userId)}`);
  return Boolean(r?.ok);
}

/**
 * Records (or changes) someone's feedback. Null when the answer, or the number's query, isn't theirs to judge. A thumbs
 * down that says, in a few words, what it should have said is a correction, kept in the same transaction.
 */
export async function giveFeedback(
  deps: FeedbackDeps,
  viewer: Viewer,
  input: FeedbackInput,
): Promise<{ id: string; correction?: CorrectionKept } | null> {
  if (!isUuid(input.runId) || (input.queryRunId && !isUuid(input.queryRunId))) return null;
  const number = input.kind === "wrong_number";
  if (number && (!input.queryRunId || !input.claimKey)) return null;
  return inTransaction(deps, viewer, async (tx, personal) => {
    if (!(await answerVisible(tx, viewer, input.runId))) return null;
    if (number) {
      // The number's query must be one of this conversation's.
      const [q] = await tx.execute<{ ok: boolean }>(sql`
        select true as ok from app.query_run q
        join app.run qr on qr.org_id = q.org_id and qr.id = q.requester_id
        join app.run r on r.org_id = qr.org_id and r.thread_id = qr.thread_id
        where q.org_id = ${viewer.orgId} and q.id = ${input.queryRunId as string} and q.requester_type = 'run'
          and r.id = ${input.runId}`);
      if (!q) return null;
    }
    const targetType = number ? "query_run" : "run";
    const targetId = number ? (input.queryRunId as string) : input.runId;
    const claimKey = number ? (input.claimKey as string).slice(0, 200) : "";
    const comment = input.comment?.trim().slice(0, MAX_COMMENT) || null;
    const correction = input.correction?.trim() ? { text: input.correction.trim().slice(0, MAX_COMMENT) } : null;
    const reason = input.kind === "up" ? null : (input.reasonCode ?? (number ? "wrong_number" : null));
    // What an earlier correction of this person's on this answer kept, read before the row is replaced.
    const [prior] = await tx.execute<{ correction: StoredCorrection | null }>(sql`
      select correction from app.feedback
      where org_id = ${viewer.orgId} and user_id is not distinct from ${viewer.userId} and target_type = ${targetType}
        and target_id = ${targetId} and claim_key = ${claimKey}
      for update`);
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into app.feedback (org_id, id, target_type, target_id, claim_key, run_id, user_id, kind, reason_code,
        comment, correction)
      values (${viewer.orgId}, ${uuidv7()}, ${targetType}, ${targetId}, ${claimKey}, ${input.runId},
        ${viewer.userId}, ${input.kind}, ${reason}, ${comment}, ${correction ? JSON.stringify(correction) : null}::jsonb)
      on conflict (org_id, user_id, target_type, target_id, claim_key) do update
        set kind = excluded.kind, reason_code = excluded.reason_code, comment = excluded.comment,
            correction = excluded.correction, status = 'new', updated_at = now()
      returning id`);
    if (!row) return null;
    // A correction says what it should have said; "wrong" or "no" is a comment for the admins.
    const said = input.kind === "down" ? (comment ?? correction?.text ?? null) : null;
    const text = said && wordCount(said) >= 3 ? said : null;
    if (!text || !viewer.userId) {
      // Changed to a thumbs up, or to one that says nothing: what an earlier correction kept goes.
      if (prior?.correction) await undoCorrection(tx, viewer, prior.correction, personal, row.id);
      return { id: row.id };
    }
    // The source the corrected answer read: its number's query's, or where its question started, never
    // where the conversation has moved to since.
    const [run] = await tx.execute<{ connection_id: string; thread_id: string }>(sql`
      select coalesce(
          ${number ? sql`(select q.connection_id from app.query_run q where q.org_id = r.org_id and q.id = ${input.queryRunId as string})` : sql`null`},
          r.connection_id, t.connection_id) as connection_id,
        r.thread_id from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
      where r.org_id = ${viewer.orgId} and r.id = ${input.runId}`);
    // For the team: the correction is a learning's evidence, which the Curator turns into a term an admin
    // approves with one tap, or the rule releases. A changed one replaces its earlier words there. Admins already read
    // a 👎's correction on Knowledge → Feedback, so it's one to share.
    if (prior?.correction?.text && prior.correction.text !== text) {
      await withdrawSignal(tx, viewer.orgId, { kind: "feedback", id: row.id });
    }
    const learning = run?.connection_id
      ? await signalCorrection(
          tx,
          { orgId: viewer.orgId, userId: viewer.userId },
          {
            kind: "feedback",
            id: row.id,
            text,
            runId: input.runId,
            connectionId: run.connection_id,
          },
        )
      : null;
    // The person's memory: a changed correction replaces the one it made; one they already had stays theirs.
    let memory: { id: string; fact: string; made: boolean } | null = null;
    if (personal) {
      if (prior?.correction?.memoryId) await forgetMemory(tx, viewer.orgId, viewer.userId, prior.correction.memoryId);
      const m = await rememberFact(
        tx,
        { orgId: viewer.orgId, userId: viewer.userId },
        { fact: asFact(text), runId: input.runId, threadId: run?.thread_id ?? null },
      );
      memory = { id: m.id, fact: m.fact, made: !m.existing };
    }
    const stored: StoredCorrection = {
      text,
      ...(memory ? { fact: memory.fact } : {}),
      ...(memory?.made ? { memoryId: memory.id } : {}),
      ...(learning ? { learningId: learning.proposalId } : {}),
    };
    await tx.execute(sql`
      update app.feedback set correction = ${JSON.stringify(stored)}::jsonb
      where org_id = ${viewer.orgId} and id = ${row.id}`);
    return {
      id: row.id,
      correction: {
        text,
        memory: memory ? { fact: memory.fact } : null,
        guideId: null,
        learningId: learning?.proposalId ?? null,
      },
    };
  });
}

/**
 * Undoes what a correction kept: the memory it made, its evidence in a learning, and a guide it proposed
 * before that while no admin has approved it.
 */
async function undoCorrection(
  tx: TenantTx,
  viewer: Viewer,
  kept: StoredCorrection,
  personal: boolean,
  feedbackId?: string,
) {
  if (personal && viewer.userId && kept.memoryId) await forgetMemory(tx, viewer.orgId, viewer.userId, kept.memoryId);
  if (feedbackId) await withdrawSignal(tx, viewer.orgId, { kind: "feedback", id: feedbackId });
  if (kept.guideId && isUuid(kept.guideId)) {
    await tx.execute(sql`
      update app.context_item set deleted_at = now()
      where org_id = ${viewer.orgId} and id = ${kept.guideId} and kind = 'guide' and released_version is null
        and deleted_at is null`);
  }
}

/** Takes back someone's thumbs on an answer (pressing it again, or Undo), with what its correction kept. */
export async function withdrawFeedback(deps: FeedbackDeps, viewer: Viewer, runId: string): Promise<boolean> {
  if (!isUuid(runId)) return false;
  return inTransaction(deps, viewer, async (tx, personal) => {
    const [row] = await tx.execute<{ id: string; correction: StoredCorrection | null }>(sql`
      select id, correction from app.feedback
      where org_id = ${viewer.orgId} and user_id is not distinct from ${viewer.userId}
        and target_type = 'run' and target_id = ${runId}
      for update`);
    if (!row) return false;
    if (row.correction) await undoCorrection(tx, viewer, row.correction, personal, row.id);
    await tx.execute(sql`delete from app.feedback where org_id = ${viewer.orgId} and id = ${row.id}`);
    return true;
  });
}

/** What someone has said about an answer, for its buttons' state and its correction's note. */
export async function myFeedback(deps: LedgerDeps, viewer: Viewer, runId: string): Promise<MyFeedback> {
  if (!isUuid(runId)) return { answer: null, numbers: [] };
  const rows = await deps.withTenant(viewer.orgId, (tx) =>
    tx.execute<{
      target_type: string;
      kind: string;
      reason_code: ReasonCode | null;
      comment: string | null;
      claim_key: string;
      correction: StoredCorrection | null;
    }>(sql`
      select target_type, kind, reason_code, comment, claim_key, correction from app.feedback
      where org_id = ${viewer.orgId} and user_id is not distinct from ${viewer.userId} and run_id = ${runId}`),
  );
  const answer = rows.find((r) => r.target_type === "run");
  const c = answer?.kind === "down" ? answer.correction : null;
  return {
    answer:
      answer && (answer.kind === "up" || answer.kind === "down")
        ? {
            kind: answer.kind,
            reasonCode: answer.reason_code,
            comment: answer.comment,
            correction:
              c?.text && (c.fact || c.guideId || c.learningId)
                ? {
                    text: c.text,
                    memory: c.fact ? { fact: c.fact } : null,
                    guideId: c.guideId ?? null,
                    learningId: c.learningId ?? null,
                  }
                : null,
          }
        : null,
    numbers: rows.filter((r) => r.target_type === "query_run").map((r) => r.claim_key),
  };
}

export interface FeedbackReport {
  id: string;
  kind: FeedbackKind;
  reasonCode: ReasonCode | null;
  comment: string | null;
  correction: string | null;
  claimKey: string | null;
  status: "new" | "routed" | "ignored";
  mine: boolean;
  createdAt: string;
  runId: string;
  /** Null when the conversation is private to someone else: the report shows, the conversation doesn't. */
  threadId: string | null;
  threadTitle: string | null;
  /** The question the answer was for. */
  question: string | null;
  /** The definitions the answer's queries compiled from. */
  definitions: { id: string; kind: "dataset" | "metric"; title: string }[];
}

const reportSelect = (viewer: Viewer) => sql`
  select f.id, f.kind, f.reason_code, f.comment, f.correction->>'text' as correction, nullif(f.claim_key, '') as claim_key,
    f.status, f.user_id is not distinct from ${viewer.userId} as mine, f.created_at, f.run_id,
    -- A reviewer sees the report, never more of a private conversation than they could open themselves.
    case when ${visibleTo(viewer.userId)} then t.id end as thread_id,
    case when ${visibleTo(viewer.userId)} then t.title end as thread_title,
    case when ${visibleTo(viewer.userId)} then m.text end as question,
    coalesce((
      select jsonb_agg(distinct jsonb_build_object('id', i.id, 'kind', i.kind, 'title', i.title))
      from app.query_run q
      cross join lateral jsonb_array_elements(coalesce(q.semantic->'definitions', '[]'::jsonb)) d
      join app.context_item i on i.org_id = q.org_id and i.id = (d->>'id')::uuid
      where q.org_id = f.org_id and q.requester_type = 'run' and q.requester_id = f.run_id
    ), '[]'::jsonb) as definitions
  from app.feedback f
  join app.run r on r.org_id = f.org_id and r.id = f.run_id
  join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
  left join app.message m on m.org_id = r.org_id and m.id = r.input_message_id`;

type ReportRow = {
  id: string;
  kind: FeedbackKind;
  reason_code: ReasonCode | null;
  comment: string | null;
  correction: string | null;
  claim_key: string | null;
  status: FeedbackReport["status"];
  mine: boolean;
  created_at: Date;
  run_id: string;
  thread_id: string | null;
  thread_title: string | null;
  question: string | null;
  definitions: FeedbackReport["definitions"];
};

const toReport = (r: ReportRow): FeedbackReport => ({
  id: r.id,
  kind: r.kind,
  reasonCode: r.reason_code,
  comment: r.comment,
  correction: r.correction,
  claimKey: r.claim_key,
  status: r.status,
  mine: r.mine,
  createdAt: new Date(r.created_at).toISOString(),
  runId: r.run_id,
  threadId: r.thread_id,
  threadTitle: r.thread_title,
  question: r.question,
  definitions: r.definitions,
});

/**
 * Reports for reviewers (Knowledge → Feedback; the caller checks the owner or admin role): answers someone said were
 * wrong, and numbers reported as wrong, newest first, with the definitions the answer used. A report on a private
 * conversation the reviewer can't open shows what was reported, not the conversation (no question, title or link).
 */
export async function listReports(
  tx: TenantTx,
  viewer: Viewer,
  options: { status?: "new" | "ignored"; limit?: number } = {},
): Promise<FeedbackReport[]> {
  const rows = await tx.execute<ReportRow>(sql`
    ${reportSelect(viewer)}
    where f.org_id = ${viewer.orgId} and f.kind in ('down', 'wrong_number')
      and f.status = ${options.status ?? "new"} and t.deleted_at is null
    order by f.updated_at desc limit ${Math.min(options.limit ?? 100, 200)}`);
  return rows.map(toReport);
}

/** The reports on answers that used a definition (its page: "Reported as wrong"), for reviewers, as above. */
export async function reportsForDefinition(tx: TenantTx, viewer: Viewer, itemId: string): Promise<FeedbackReport[]> {
  if (!isUuid(itemId)) return [];
  const rows = await tx.execute<ReportRow>(sql`
    ${reportSelect(viewer)}
    where f.org_id = ${viewer.orgId} and f.kind in ('down', 'wrong_number') and f.status = 'new'
      and t.deleted_at is null
      and exists (
        select 1 from app.query_run q
        where q.org_id = f.org_id and q.requester_type = 'run' and q.requester_id = f.run_id
          and q.semantic->'definitions' @> ${JSON.stringify([{ id: itemId }])}::jsonb)
    order by f.updated_at desc limit 20`);
  return rows.map(toReport);
}

/** Dismisses a report (it was right after all, or it's been dealt with), or opens it again. */
export async function setReportStatus(
  tx: TenantTx,
  orgId: string,
  id: string,
  status: "new" | "ignored",
): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await tx.execute(sql`
    update app.feedback set status = ${status}, updated_at = now()
    where org_id = ${orgId} and id = ${id} and kind in ('down', 'wrong_number')
    returning id`);
  return rows.length > 0;
}

/**
 * Learnings as people see and act on them: the card under the answer where a correction was given, and on
 * Knowledge → Proposals; an approver's one tap (Approve), Revert of a released one, Reject; and "Suggest for the team"
 * for someone whose own correction is theirs alone until they choose to share it. Who may approve, revert or reject is
 * the caller's to check (owners and admins); a card is shown to approvers, and to whoever gave one of its corrections.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { approveContext, saveTerm } from "../context/items";
import { enqueueOnce } from "../jobs/boss";
import { learningEvaluateQueue } from "../jobs/queues";
import { type LearningEvidence, learnedTermYaml, signalCorrection } from "./curator";

export interface LearningCard {
  id: string;
  /** drafting · held · evaluating · open · approved · rejected · discarded · failed · superseded · reverted */
  status: string;
  term: string | null;
  means: string | null;
  column: string | null;
  values: string[];
  not: string[];
  /** Other words it brings: the analyst reads each as the term. */
  synonyms: string[];
  /** An approver changed it before the tap. */
  edited: boolean;
  /** Its corrections, and how many people gave them: only the viewer's own, for someone who can't approve. */
  said: { text: string; at: string }[];
  people: number;
  check: { ok: boolean; rows: number | null; why?: string } | null;
  test: { ok: boolean | null; used: boolean | null; why?: string } | null;
  /** Released by the rule rather than a tap. */
  automatic: boolean;
  /** What the rule missed, when it didn't release it. */
  missing: string[];
  heldReason: string | null;
  note: string | null;
  termId: string | null;
  /** The viewer gave one of its corrections. */
  mine: boolean;
  /** The viewer can approve, revert or reject it (an owner or admin). */
  canApprove: boolean;
  /** Its topic's page on Knowledge → Learnings, once it has a topic. */
  topic: string | null;
}

/** A topic's address: its key without "term:", words joined by "-" ("term:paying account" → "paying-account"). */
export const topicSlug = (key: string) =>
  key
    .replace(/^term:/, "")
    .trim()
    .replace(/\s+/g, "-");
/** The topic key an address names. */
export const topicOfSlug = (slug: string) => `term:${slug.trim().replace(/-+/g, " ")}`;

type Row = {
  id: string;
  status: string;
  evidence: LearningEvidence;
  held_reason: string | null;
  note: string | null;
  dedupe_key?: string | null;
};

const cardOf = (r: Row, userId: string | null, approver = false): LearningCard => {
  const e = r.evidence ?? { signals: [] };
  const l = e.learning;
  const signals = e.signals ?? [];
  // Someone who can't approve sees only what they said themselves: another person's correction can come from a
  // conversation of theirs, and it's the approvers' to read.
  const shown = approver ? signals : signals.filter((s) => userId !== null && s.userId === userId);
  return {
    id: r.id,
    status: r.status,
    term: l?.term ?? null,
    means: l?.means ?? null,
    column: l?.column ?? null,
    values: l?.values ?? [],
    not: l?.not ?? [],
    synonyms: l?.synonyms ?? [],
    edited: Boolean(e.edited),
    said: shown.map((s) => ({ text: s.text, at: s.at })),
    people: new Set(shown.map((s) => s.userId)).size,
    check: e.check ? { ok: e.check.ok, rows: e.check.rows, ...(e.check.why ? { why: e.check.why } : {}) } : null,
    test: e.test ? { ok: e.test.ok, used: e.test.used, ...(e.test.why ? { why: e.test.why } : {}) } : null,
    automatic: e.decided?.automatic === true && r.status === "approved",
    missing: e.decided?.missing ?? [],
    heldReason: r.held_reason,
    note: r.note,
    termId: e.termId ?? null,
    mine: userId !== null && signals.some((s) => s.userId === userId),
    canApprove: approver,
    topic: r.dedupe_key ? topicSlug(r.dedupe_key) : null,
  };
};

/**
 * The learnings a correction under this answer opened or joined: every one for an approver, only the ones they gave
 * a correction to for anyone else.
 */
export async function learningsForRun(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null; approver: boolean },
  runId: string,
): Promise<LearningCard[]> {
  if (!isUuid(runId)) return [];
  const rows = await tx.execute<Row>(sql`
    select id, status, evidence, held_reason, note, dedupe_key from app.proposal
    where org_id = ${viewer.orgId} and source = 'curator' and status <> 'superseded'
      and evidence->'signals' @> ${JSON.stringify([{ fromRunId: runId }])}::jsonb
    order by created_at desc limit 5`);
  return rows.map((r) => cardOf(r, viewer.userId, viewer.approver)).filter((c) => viewer.approver || c.mine);
}

/** One learning's card, for an owner or admin (Slack's message to them about it). */
export async function learningCard(tx: TenantTx, orgId: string, id: string): Promise<LearningCard | null> {
  if (!isUuid(id)) return null;
  const [r] = await tx.execute<Row>(sql`
    select id, status, evidence, held_reason, note, dedupe_key from app.proposal
    where org_id = ${orgId} and id = ${id} and source = 'curator'`);
  return r ? cardOf(r, null, true) : null;
}

/**
 * Where a learning's corrections were given in Slack: each person's Slack thread and Slack user, and
 * whether they can approve, for the private message the learning sends there when it's decided. Each status is told
 * once (`evidence.told`).
 */
export async function learningPlaces(
  tx: TenantTx,
  orgId: string,
  id: string,
): Promise<{
  status: string;
  places: { teamId: string; slackThreadId: string; slackUserId: string; approver: boolean }[];
}> {
  if (!isUuid(id)) return { status: "", places: [] };
  const [p] = await tx.execute<{ status: string; told: string[] | null; evidence: LearningEvidence }>(sql`
    select status, evidence->'told' as told, evidence from app.proposal
    where org_id = ${orgId} and id = ${id} and source = 'curator' for update`);
  if (!p || !["open", "approved"].includes(p.status) || (p.told ?? []).includes(p.status)) {
    return { status: p?.status ?? "", places: [] };
  }
  // Each correction's own conversation, and only when it's the corrector's: a 👎 on someone else's shared answer is
  // told to nobody there (the asker didn't say it).
  const said = (p.evidence.signals ?? []).flatMap((s) =>
    s.fromRunId && isUuid(s.fromRunId) && isUuid(s.userId) ? [{ run: s.fromRunId, user: s.userId }] : [],
  );
  const places = said.length
    ? await tx.execute<{ teamId: string; slackThreadId: string; slackUserId: string; approver: boolean }>(sql`
        select distinct c.team_id as "teamId", c.slack_thread_id as "slackThreadId", c.slack_user_id as "slackUserId",
          coalesce(app.member_role(t.created_by) in ('owner', 'admin'), false) as approver
        from jsonb_to_recordset(${JSON.stringify(said)}::jsonb) as s(run uuid, "user" uuid)
        join app.run r on r.org_id = ${orgId} and r.id = s.run
        join app.thread t on t.org_id = r.org_id and t.id = r.thread_id and t.channel = 'slack'
          and t.created_by = s."user"
        join app.slack_conversation c on c.org_id = t.org_id and c.thread_id = t.id`)
    : [];
  await tx.execute(sql`
    update app.proposal set evidence = jsonb_set(evidence, '{told}',
      coalesce(evidence->'told', '[]'::jsonb) || ${JSON.stringify([p.status])}::jsonb)
    where org_id = ${orgId} and id = ${id}`);
  return { status: p.status, places };
}

/** One topic's learnings, newest first (Knowledge → Learnings): every one for an approver, one's own otherwise. */
export async function learningsOfTopic(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null; approver: boolean },
  key: string,
): Promise<LearningCard[]> {
  const rows = await tx.execute<Row & { created_at: string; decided_at: string | null }>(sql`
    select id, status, evidence, held_reason, note, dedupe_key, created_at, decided_at from app.proposal
    where org_id = ${viewer.orgId} and source = 'curator' and status not in ('superseded', 'discarded')
      and dedupe_key = ${key}
    order by created_at desc limit 20`);
  return rows.map((r) => cardOf(r, viewer.userId, viewer.approver)).filter((c) => viewer.approver || c.mine);
}

/** The workspace's learnings, newest first, for Knowledge → Proposals: what's waiting, then what was decided lately. */
export async function listLearnings(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  limit = 50,
): Promise<LearningCard[]> {
  const rows = await tx.execute<Row>(sql`
    select id, status, evidence, held_reason, note, dedupe_key from app.proposal
    where org_id = ${viewer.orgId} and source = 'curator' and status <> 'superseded'
      and (status in ('drafting', 'held', 'evaluating', 'open') or created_at > now() - interval '30 days')
    order by (status in ('open', 'evaluating', 'drafting', 'held')) desc, created_at desc limit ${limit}`);
  return rows.map((r) => cardOf(r, viewer.userId, true));
}

const locked = async (tx: TenantTx, orgId: string, id: string, statuses: string[]) => {
  if (!isUuid(id)) return null;
  const [p] = await tx.execute<{ status: string; evidence: LearningEvidence; connection_id: string }>(sql`
    select status, evidence, connection_id from app.proposal
    where org_id = ${orgId} and id = ${id} and source = 'curator' and status in (${sql.join(
      statuses.map((s) => sql`${s}`),
      sql`, `,
    )})
    for update`);
  return p ?? null;
};

/** One tap (an approver's, the caller checks): the learning's term released at the version they saw. */
export async function approveLearning(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
): Promise<boolean> {
  const p = await locked(tx, viewer.orgId, id, ["open", "evaluating"]);
  const e = p?.evidence;
  if (!p || !e?.termId || !e.termVersion) return false;
  const released = await approveContext(tx, viewer, [{ id: e.termId, version: e.termVersion }]);
  if (!released.length) return false;
  await tx.execute(sql`
    update app.proposal set status = 'approved', reviewer_id = ${viewer.userId}, decided_at = now(),
      evidence = evidence - 'recheck'
    where org_id = ${viewer.orgId} and id = ${id}`);
  return true;
}

/** What an approver may change in a learning before the tap; a field left out stays as it is. */
export interface LearningEdit {
  means?: string;
  /** schema.table.column, or null for none. */
  column?: string | null;
  values?: string[];
  synonyms?: string[];
  /** schema.table each. */
  not?: string[];
}

/**
 * An approver's change before the tap: the term's next proposed version, as they edited it, checked and
 * tested again. What's released is then theirs rather than what was said, so the rule never releases it: their tap does.
 * Throws ContextProblem when the column or a table isn't the source's. False when it isn't waiting for a tap.
 */
export async function editLearning(
  deps: { boss: PgBoss | null },
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
  edit: LearningEdit,
): Promise<boolean> {
  const p = await locked(tx, viewer.orgId, id, ["open"]);
  const e = p?.evidence;
  if (!p || !e?.learning || !e.termId) return false;
  const list = (xs: string[] | undefined, max: number) =>
    xs === undefined ? undefined : [...new Set(xs.map((x) => x.trim()).filter(Boolean))].slice(0, max);
  const [term] = await tx.execute<{ term: string | null }>(sql`
    select v.spec->>'term' as term from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${viewer.orgId} and i.id = ${e.termId} and i.kind = 'term' and i.deleted_at is null`);
  if (!term) return false;
  const column = edit.column === undefined ? e.learning.column : edit.column?.trim() || undefined;
  const learning = {
    ...e.learning,
    term: term.term ?? e.learning.term,
    ...(edit.means?.trim() ? { means: edit.means.trim().slice(0, 300) } : {}),
    column,
    values: column ? (list(edit.values, 10) ?? e.learning.values ?? []) : [],
    synonyms: list(edit.synonyms, 12) ?? e.learning.synonyms,
    not: list(edit.not, 10) ?? e.learning.not,
  };
  const saved = await saveTerm(
    tx,
    { orgId: viewer.orgId, userId: viewer.userId },
    {
      id: e.termId,
      body: learnedTermYaml(learning, id, null),
      connectionId: p.connection_id,
      changeNote: "Changed before the tap",
      proposed: true,
    },
  );
  await tx.execute(sql`
    update app.proposal set status = 'evaluating',
      evidence = (evidence - 'check' - 'test' - 'decided' - 'recheck') || ${JSON.stringify({
        learning,
        termVersion: saved.version,
        edited: { by: viewer.userId, at: new Date().toISOString() },
      } satisfies Partial<LearningEvidence>)}::jsonb
    where org_id = ${viewer.orgId} and id = ${id}`);
  // Checked and tested again, as it now says.
  if (deps.boss) {
    await enqueueOnce(
      deps.boss,
      tx,
      learningEvaluateQueue,
      { orgId: viewer.orgId, proposalId: id },
      { singletonKey: id },
    );
  }
  return true;
}

/** Said when a revert is refused because its term changed again after the learning was released. */
export const REVERT_SUPERSEDED =
  "This term changed again after this learning was released, so reverting it would undo that too: edit the term instead.";

/**
 * Revert of a released learning (an approver's): its term goes back to what was released before it (nothing, for a
 * term it made), and the learning says it was reverted. Only while its own version is still the one released: a later
 * release (another learning, an admin's edit) would be undone with it, and a version a later decision withdrew could
 * come back, so that's refused ("superseded"), and the term stays as it is.
 */
export async function revertLearning(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
): Promise<"reverted" | "not_found" | "superseded"> {
  const p = await locked(tx, viewer.orgId, id, ["approved"]);
  const e = p?.evidence;
  if (!p || !e?.termId || !e.termVersion) return "not_found";
  const before = e.before?.releasedVersion ?? null;
  // Who approved the version it goes back to: none (learned) unless the learning recorded one, so a version nobody
  // approved never reads as an admin's for keeping a later approval.
  const approvedBy = e.before?.verifiedBy ?? null;
  const still = sql`org_id = ${viewer.orgId} and id = ${e.termId} and kind = 'term' and deleted_at is null
    and released_version = ${e.termVersion}`;
  const rows = await tx.execute<{ id: string }>(
    before === null
      ? sql`
          update app.context_item set released_version = null, status = 'draft', updated_at = now()
          where ${still} returning id`
      : sql`
          update app.context_item set released_version = ${before}, verified_by = ${approvedBy}::uuid,
            -- A draft made since (an admin's edit, waiting) stays the draft: only this learning's version goes back.
            current_version = case when current_version = ${e.termVersion} then ${before} else current_version end,
            status = case when current_version = ${e.termVersion} then 'verified' else status end,
            updated_at = now()
          where ${still} returning id`,
  );
  if (!rows.length) return "superseded";
  await tx.execute(sql`
    update app.proposal set status = 'reverted', reviewer_id = ${viewer.userId}, decided_at = now()
    where org_id = ${viewer.orgId} and id = ${id}`);
  return "reverted";
}

/** Reject (an approver's), with a note: the term's proposed version goes, the released one (if any) stays. */
export async function rejectLearning(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  id: string,
  note: string | null = null,
): Promise<boolean> {
  const p = await locked(tx, viewer.orgId, id, ["open", "evaluating", "held", "drafting"]);
  if (!p) return false;
  const e = p.evidence;
  if (e?.termId) {
    await tx.execute(sql`
      update app.context_item set
        current_version = coalesce(released_version, current_version),
        deleted_at = case when released_version is null then now() else deleted_at end,
        status = case when released_version is null then status else 'verified' end,
        updated_at = now()
      where org_id = ${viewer.orgId} and id = ${e.termId} and kind = 'term'`);
  }
  await tx.execute(sql`
    update app.proposal set status = 'rejected', reviewer_id = ${viewer.userId}, decided_at = now(),
      note = ${note?.trim().slice(0, 500) || null}
    where org_id = ${viewer.orgId} and id = ${id}`);
  return true;
}

/**
 * "Suggest for the team": someone shares their own correction, kept as their memory, with the team's
 * learning about it. Their transaction: the memory must be theirs.
 */
export async function suggestLearning(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  memoryId: string,
): Promise<{ proposalId: string } | null> {
  if (!isUuid(memoryId)) return null;
  const [m] = await tx.execute<{
    fact: string;
    run_id: string | null;
    thread_id: string | null;
    about: string | null;
  }>(sql`
    select i.title as fact, v.spec->>'runId' as run_id, v.spec->>'threadId' as thread_id, v.spec->>'about' as about
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${viewer.orgId} and i.id = ${memoryId} and i.kind = 'memory' and i.scope = 'personal'
      and i.scope_id = ${viewer.userId} and i.deleted_at is null`);
  if (!m?.run_id || !isUuid(m.run_id)) return null;
  // The answer it corrected: the conversation's run before the one that kept it; and that run's source.
  const [r] = await tx.execute<{ connection_id: string; corrected: string | null }>(sql`
    select r.connection_id, (
      select p.id from app.run p
      where p.org_id = r.org_id and p.thread_id = r.thread_id and p.parent_run_id is null and p.id <> r.id
        and p.queued_at <= r.queued_at
      order by p.queued_at desc limit 1) as corrected
    from app.run r where r.org_id = ${viewer.orgId} and r.id = ${m.run_id}`);
  if (!r?.connection_id) return null;
  const signal = await signalCorrection(tx, viewer, {
    kind: "suggestion",
    id: memoryId,
    text: m.fact,
    runId: r.corrected,
    fromRunId: m.run_id,
    connectionId: r.connection_id,
    about: m.about,
  });
  return signal ? { proposalId: signal.proposalId } : null;
}

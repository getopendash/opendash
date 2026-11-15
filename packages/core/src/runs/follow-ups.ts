/**
 * Follow-ups: a message sent while its conversation's answer is being worked on is queued on that run
 * (submitQuestion), read by the run at its next step boundary (here), or, when the run ends first, the next run's
 * question (passOnFollowUps, in the transaction that ends it). Until it's read, its author can take it back.
 */
import { isUuid, sql } from "@opendash/db";
import {
  appendEvent,
  type ClaimedRun,
  FOLLOW_UP_MARK,
  fenced,
  type LedgerDeps,
  nextMessageSeq,
  toJsonb,
  type Viewer,
} from "./ledger";

/**
 * The run's queued follow-ups, read now: each gets its place in the transcript (the next seq), the mark that keeps it
 * in the run's turn, and an `input_joined` event, in one fenced transaction. One with attachments waits for the next
 * run, where they're checked as a question's are.
 */
export async function joinFollowUps(deps: LedgerDeps, run: ClaimedRun): Promise<{ id: string; text: string }[]> {
  return fenced(deps, run, async (tx) => {
    // Only the asker's own: a run reads as its asker (submitQuestion already lets no one else add to a conversation).
    // And only while they may still ask: one who left or can only read now waits, and the next run is refused for
    // them when it's claimed (claimRun), saying why.
    const queued = await tx.execute<{ id: string; text: string }>(sql`
      select m.id, m.text from app.message m
      join app.run r on r.org_id = m.org_id and r.id = m.run_id
      join app.message q on q.org_id = r.org_id and q.id = r.input_message_id
      where m.org_id = ${run.orgId} and m.run_id = ${run.id} and m.kind = 'queued_input' and m.status = 'queued'
        and m.attachments = '[]'::jsonb and m.author_id is not distinct from q.author_id
        and (m.author_id is null or coalesce(app.member_role(m.author_id), 'viewer') <> 'viewer')
      order by m.created_at, m.id
      for update of m`);
    for (const m of queued) {
      const seq = await nextMessageSeq(tx, run.orgId, run.threadId);
      await tx.execute(sql`
        update app.message set seq = ${seq}, kind = 'normal', status = 'complete',
          content = ${toJsonb({ role: "user", content: m.text, providerOptions: FOLLOW_UP_MARK })}::jsonb
        where org_id = ${run.orgId} and id = ${m.id}`);
      // Its first words, for the live steps: whoever reads the run's events reads its messages too.
      await appendEvent(tx, run, "input_joined", { messageId: m.id, text: m.text.slice(0, 120) });
    }
    return queued;
  });
}

/** Its author takes a follow-up back before it's read. False once it was read, or for anyone else. */
export async function takeBackFollowUp(deps: LedgerDeps, viewer: Viewer, messageId: string): Promise<boolean> {
  if (!isUuid(messageId) || !viewer.userId) return false;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const gone = await tx.execute<{ id: string }>(sql`
      delete from app.message
      where org_id = ${viewer.orgId} and id = ${messageId} and kind = 'queued_input' and status = 'queued'
        and author_id = ${viewer.userId}
      returning id`);
    return gone.length > 0;
  });
}

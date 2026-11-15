/**
 * Every reply in Slack posted once. A reply job's attempt takes the next number on the run's
 * `slack_reply` and writes only while it's still the latest (a job pg-boss gave up on that still runs, or two at
 * once, can't both post). Each part of the reply is claimed before it's posted and recorded with its message's ts
 * after; one an earlier attempt claimed and never recorded is looked for in the thread (by the metadata each part
 * carries) before it's posted again. Real failures are counted (a hand-off at a shutdown isn't one), so the reply
 * gives up after the third and says where the answer is.
 */
import { sql, type TenantTx } from "@opendash/db";

/** An attempt that's no longer the latest: another took over the reply, or it's finished. */
export class SlackReplyFenced extends Error {
  override name = "SlackReplyFenced";
}

/** How many real failures a reply takes before it gives up and says where the answer is. */
export const SLACK_REPLY_FAILURES = 3;

/** A new attempt at a run's reply: its number, or null when the reply is finished already. */
export async function beginSlackReplyAttempt(tx: TenantTx, orgId: string, runId: string): Promise<number | null> {
  const [r] = await tx.execute<{ attempt: number }>(sql`
    update app.slack_reply set attempt = attempt + 1
    where org_id = ${orgId} and run_id = ${runId} and status = 'streaming' returning attempt`);
  return r?.attempt ?? null;
}

/** Holds the reply's row for the rest of the transaction, if `attempt` is still the latest; throws otherwise. */
async function fence(tx: TenantTx, orgId: string, runId: string, attempt: number): Promise<void> {
  const [r] = await tx.execute<{ attempt: number }>(sql`
    select attempt from app.slack_reply
    where org_id = ${orgId} and run_id = ${runId} and status = 'streaming' and attempt = ${attempt}
    for share`);
  if (!r) throw new SlackReplyFenced();
}

/**
 * A part of the reply, claimed for this attempt: `new` (post it), `posted` by an earlier attempt (its ts), or
 * `unsure` (an earlier attempt claimed it and stopped before saying whether it went: look in the thread first).
 */
export type SlackReplyPart = { state: "new" } | { state: "posted"; ts: string | null } | { state: "unsure" };

export async function claimSlackReplyPart(
  tx: TenantTx,
  orgId: string,
  runId: string,
  attempt: number,
  part: string,
): Promise<SlackReplyPart> {
  await fence(tx, orgId, runId, attempt);
  const made = await tx.execute<{ part: string }>(sql`
    insert into app.slack_reply_message (org_id, run_id, part) values (${orgId}, ${runId}, ${part})
    on conflict do nothing returning part`);
  if (made.length) return { state: "new" };
  const [r] = await tx.execute<{ status: "posting" | "posted"; ts: string | null }>(sql`
    select status, ts from app.slack_reply_message where org_id = ${orgId} and run_id = ${runId} and part = ${part}`);
  return r?.status === "posted" ? { state: "posted", ts: r.ts } : { state: "unsure" };
}

/** The part went: its message's ts. */
export async function slackReplyPartPosted(
  tx: TenantTx,
  orgId: string,
  runId: string,
  attempt: number,
  part: string,
  ts: string | null,
): Promise<void> {
  await fence(tx, orgId, runId, attempt);
  await tx.execute(sql`
    update app.slack_reply_message set status = 'posted', ts = ${ts}, posted_at = now()
    where org_id = ${orgId} and run_id = ${runId} and part = ${part}`);
}

/**
 * What a new attempt finds of the reply's steps: the message showing them, which it carries on in (its
 * ts, and when it was started), and whether the answer was begun, by which time the run has ended.
 */
export async function slackReplySteps(
  tx: TenantTx,
  orgId: string,
  runId: string,
): Promise<{ steps: { ts: string; startedAt: Date } | null; answering: boolean }> {
  const rows = await tx.execute<{ part: string; ts: string | null; posted_at: string | null }>(sql`
    select part, ts, posted_at from app.slack_reply_message
    where org_id = ${orgId} and run_id = ${runId} and part in ('steps', 'answer')`);
  const steps = rows.find((r) => r.part === "steps" && r.ts && r.posted_at);
  return {
    steps: steps?.ts && steps.posted_at ? { ts: steps.ts, startedAt: new Date(steps.posted_at) } : null,
    answering: rows.some((r) => r.part === "answer"),
  };
}

/** The message now showing the reply's steps: the first, or the next once one grew too old or Slack closed it. */
export async function slackReplyStepsAt(
  tx: TenantTx,
  orgId: string,
  runId: string,
  attempt: number,
  ts: string,
): Promise<void> {
  await fence(tx, orgId, runId, attempt);
  await tx.execute(sql`
    insert into app.slack_reply_message (org_id, run_id, part, status, ts, posted_at)
    values (${orgId}, ${runId}, 'steps', 'posted', ${ts}, now())
    on conflict (org_id, run_id, part) do update set status = 'posted', ts = excluded.ts, posted_at = now()`);
}

/** A real failure of this attempt (`error` is Slack's code, never what was said): how many there have been. */
export async function slackReplyFailed(
  tx: TenantTx,
  orgId: string,
  runId: string,
  attempt: number,
  error: string,
): Promise<number> {
  const [r] = await tx.execute<{ failures: number }>(sql`
    update app.slack_reply set failures = failures + 1, error = ${error.slice(0, 200)}
    where org_id = ${orgId} and run_id = ${runId} and status = 'streaming' and attempt = ${attempt}
    returning failures`);
  if (!r) throw new SlackReplyFenced();
  return r.failures;
}

/** Ends the reply for this attempt, if it's still the latest. */
export async function finishSlackReplyAttempt(
  tx: TenantTx,
  orgId: string,
  runId: string,
  attempt: number,
  status: "done" | "failed",
): Promise<void> {
  const ended = await tx.execute<{ run_id: string }>(sql`
    update app.slack_reply set status = ${status}, finished_at = now()
    where org_id = ${orgId} and run_id = ${runId} and status = 'streaming' and attempt = ${attempt}
    returning run_id`);
  if (!ended.length) throw new SlackReplyFenced();
}

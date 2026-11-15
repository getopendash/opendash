/**
 * A routine run's sends: one outbox row per person it emails and per Slack channel it posts to,
 * keyed by run, channel and recipient, so a retried job never sends twice. What's sent is composed when it's sent, for
 * that person, and only while they're still on the routine. The run's status follows its sends: delivered once one
 * went, failed when one couldn't; four failed runs in a row pause the routine, saying why.
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { enqueueOnce } from "../jobs/boss";
import { effectSendQueue } from "../jobs/queues";
import type { SlackDestination } from "./spec";
import { FAILURES_TO_PAUSE, reconcileChecks } from "./store";

/** What a run sends, as its outbox rows carry it (ids only: the content is read when it's sent). */
export type SendPayload =
  /** A scheduled question's answer: the run, read in its conversation when it's sent. */
  | { kind: "answer"; runId: string }
  | { kind: "digest" }
  | { kind: "alert"; insightIds: string[] }
  | { kind: "roundup"; insightIds: string[] }
  /** To its owner: the routine paused itself, and why (by email only). */
  | { kind: "paused" };

/** Queues the run's sends to the routine's people and channels as they are now. The number queued. */
export async function queueSends(
  tx: TenantTx,
  boss: PgBoss,
  orgId: string,
  run: { id: string; routineId: string },
  payload: SendPayload,
): Promise<number> {
  const [r] = await tx.execute<{ user_ids: string[]; slack: SlackDestination[] }>(sql`
    select user_ids, slack from app.routine where org_id = ${orgId} and id = ${run.routineId}`);
  await tx.execute(sql`
    update app.routine_run set status = 'sending', updated_at = now()
    where org_id = ${orgId} and id = ${run.id} and status in ('running', 'writing')`);
  let queued = 0;
  for (const userId of r?.user_ids ?? []) {
    const [effect] = await tx.execute<{ id: string }>(sql`
      insert into app.effect (org_id, id, purpose, source_type, source_id, channel, recipient_key, payload,
        idempotency_key)
      values (${orgId}, ${uuidv7()}, 'notify', 'routine_run', ${run.id}, 'email', ${`user:${userId}`},
        ${JSON.stringify({ ...payload, routineId: run.routineId, userId })}::jsonb,
        ${`routine_run:${run.id}:email:user:${userId}`})
      on conflict (org_id, idempotency_key) do nothing returning id`);
    if (!effect) continue;
    queued++;
    await enqueueOnce(boss, tx, effectSendQueue, { orgId, effectId: effect.id }, { singletonKey: effect.id });
  }
  // A post per channel: what it says is composed for the channel, as the whole workspace reads it.
  for (const c of r?.slack ?? []) {
    const [effect] = await tx.execute<{ id: string }>(sql`
      insert into app.effect (org_id, id, purpose, source_type, source_id, channel, recipient_key, payload,
        idempotency_key)
      values (${orgId}, ${uuidv7()}, 'notify', 'routine_run', ${run.id}, 'slack', ${`slack:${c.teamId}:${c.channelId}`},
        ${JSON.stringify({ ...payload, routineId: run.routineId, slack: { teamId: c.teamId, channelId: c.channelId } })}::jsonb,
        ${`routine_run:${run.id}:slack:${c.teamId}:${c.channelId}`})
      on conflict (org_id, idempotency_key) do nothing returning id`);
    if (!effect) continue;
    queued++;
    await enqueueOnce(boss, tx, effectSendQueue, { orgId, effectId: effect.id }, { singletonKey: effect.id });
  }
  if (!queued) await settleRun(tx, boss, orgId, run.id);
  return queued;
}

/**
 * Settles a run from its sends, once they've all ended: delivered when any went (saying what it didn't reach), failed
 * when none went and one couldn't (the streak counts it), skipped when none had anyone to go to. Only a sending run
 * settles, so it settles once.
 */
export async function settleRun(tx: TenantTx, boss: PgBoss, orgId: string, runId: string): Promise<string | null> {
  // Sends of one run settle one after another, so the last of two at once sees the other's settled row.
  await tx.execute(sql`select 1 from app.routine_run where org_id = ${orgId} and id = ${runId} for update`);
  const [s] = await tx.execute<{
    total: number;
    open: number;
    sent: number;
    failed: number;
    reason: string | null;
  }>(sql`
    select count(*)::int as total,
      count(*) filter (where status in ('queued', 'sending'))::int as open,
      count(*) filter (where status = 'sent')::int as sent,
      count(*) filter (where status in ('failed', 'unknown'))::int as failed,
      (array_agg(receipt->>'reason' order by updated_at desc) filter (where status = 'suppressed'))[1] as reason
    from app.effect where org_id = ${orgId} and source_type = 'routine_run' and source_id = ${runId}
      and payload->>'kind' <> 'paused'`);
  if (!s || s.open) return null;
  // Delivered when anything went: one channel OpenDash was removed from doesn't stop the rest, or count toward the
  // pause; the run says what it didn't reach. Failed when nothing went and something couldn't.
  if (s.failed && !s.sent)
    return failRun(tx, boss, orgId, runId, `${s.failed === 1 ? "A send" : `${s.failed} sends`} couldn't go.`);
  const status = s.sent ? "delivered" : "skipped";
  const error = s.sent
    ? s.failed
      ? await missed(tx, orgId, runId)
      : null
    : (s.reason ?? "There was nobody to send it to.");
  const [run] = await tx.execute<{ routine_id: string }>(sql`
    update app.routine_run set status = ${status}, error = ${error}, updated_at = now()
    where org_id = ${orgId} and id = ${runId} and status = 'sending' returning routine_id`);
  if (run && status === "delivered") {
    await tx.execute(sql`
      update app.routine set failure_streak = 0 where org_id = ${orgId} and id = ${run.routine_id}`);
  }
  return run ? status : null;
}

/** What a delivered run didn't reach, in words its routine's page shows: its channels by name, its people by name. */
async function missed(tx: TenantTx, orgId: string, runId: string): Promise<string> {
  const rows = await tx.execute<{ channel: string; recipient_key: string; slack: SlackDestination[] }>(sql`
    select e.channel, e.recipient_key, r.slack
    from app.effect e
    join app.routine_run rr on rr.org_id = e.org_id and rr.id = e.source_id
    join app.routine r on r.org_id = rr.org_id and r.id = rr.routine_id
    where e.org_id = ${orgId} and e.source_type = 'routine_run' and e.source_id = ${runId}
      and e.status in ('failed', 'unknown') and e.payload->>'kind' <> 'paused'
    order by e.channel, e.recipient_key`);
  const names: string[] = [];
  for (const e of rows) {
    if (e.channel === "slack") {
      const c = e.slack.find((d) => `slack:${d.teamId}:${d.channelId}` === e.recipient_key);
      // Kept on the run for everyone who sees the routine: a private channel isn't named.
      names.push(c ? (c.private ? "a private channel" : `#${c.name}`) : "a Slack channel");
      continue;
    }
    const userId = e.recipient_key.replace(/^user:/, "");
    const [p] = isUuid(userId)
      ? await tx.execute<{ name: string; email: string }>(sql`select name, email from app.member_recipient(${userId})`)
      : [];
    names.push(p ? p.name || p.email : "someone");
  }
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "everyone");
  return `It went, but didn't reach ${list}.`;
}

/**
 * Whether this attempt of a run's job still holds the run, locked until the transaction ends (routine.run): a later
 * attempt that took it over owns it, and an attempt that comes back late writes nothing.
 */
export async function holds(tx: TenantTx, orgId: string, run: { id: string; attempt: number }): Promise<boolean> {
  const [r] = await tx.execute(sql`
    select 1 from app.routine_run
    where org_id = ${orgId} and id = ${run.id} and status = 'running' and attempt = ${run.attempt}
    for update`);
  return Boolean(r);
}

/** A run that failed, saying why; the routine's fourth in a row pauses it, and its owner is told. */
export async function failRun(
  tx: TenantTx,
  boss: PgBoss,
  orgId: string,
  runId: string,
  error: string,
): Promise<string | null> {
  const [run] = await tx.execute<{ routine_id: string }>(sql`
    update app.routine_run set status = 'failed', error = ${error.slice(0, 500)}, updated_at = now()
    where org_id = ${orgId} and id = ${runId} and status in ('queued', 'running', 'writing', 'waiting', 'sending')
    returning routine_id`);
  if (!run) return null;
  const [paused] = await tx.execute<{ owner_id: string | null; trigger: string }>(sql`
    update app.routine set failure_streak = failure_streak + 1, updated_at = now(),
      status = case when failure_streak + 1 >= ${FAILURES_TO_PAUSE} then 'paused' else status end,
      paused_reason = case when failure_streak + 1 >= ${FAILURES_TO_PAUSE}
        then ${`It failed ${FAILURES_TO_PAUSE} times in a row. Last time: ${error.slice(0, 300)}`} else paused_reason end
    where org_id = ${orgId} and id = ${run.routine_id}
    returning case when failure_streak = ${FAILURES_TO_PAUSE} then owner_id end as owner_id, trigger`);
  // Paused, it reads nothing more: the checks only it needed go.
  if (paused?.owner_id && paused.trigger === "found") await reconcileChecks(tx, orgId);
  if (paused?.owner_id) {
    const [effect] = await tx.execute<{ id: string }>(sql`
      insert into app.effect (org_id, id, purpose, source_type, source_id, channel, recipient_key, payload,
        idempotency_key)
      values (${orgId}, ${uuidv7()}, 'notify', 'routine_run', ${runId}, 'email', ${`user:${paused.owner_id}`},
        ${JSON.stringify({ kind: "paused", routineId: run.routine_id, userId: paused.owner_id })}::jsonb,
        ${`routine_run:${runId}:paused:email:user:${paused.owner_id}`})
      on conflict (org_id, idempotency_key) do nothing returning id`);
    if (effect)
      await enqueueOnce(boss, tx, effectSendQueue, { orgId, effectId: effect.id }, { singletonKey: effect.id });
  }
  return "failed";
}

/** A run with nothing to do (its routine paused or deleted since it was made), saying why. */
export async function skipRun(tx: TenantTx, orgId: string, runId: string, reason: string): Promise<void> {
  await tx.execute(sql`
    update app.routine_run set status = 'skipped', error = ${reason}, updated_at = now()
    where org_id = ${orgId} and id = ${runId} and status in ('queued', 'running', 'waiting')`);
}

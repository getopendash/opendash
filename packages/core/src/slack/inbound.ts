/**
 * Every question from Slack, recorded before Slack hears it arrived. The socket (worker) and the event
 * route (web) record a message to the bot or a press of one of its buttons, then acknowledge it; only the delivery
 * that made the row hands it to the bot, so Slack's retries and a message's twins (`message` and `app_mention`) ask
 * once. The question marks its row asked in the same transaction that asks it; any other end marks it handled. A row
 * still received a while later (the process stopped first) is handed to the bot again, and after three tries the
 * person is told it was lost. What Slack sent is kept only until it's handled; the row goes after a week.
 */
import { type PublicTx, type SystemTx, sql, type TenantTx } from "@opendash/db";
import { type LedgerDeps, toJsonb } from "../runs/ledger";

type PublicDeps = { withPublic: <T>(fn: (tx: PublicTx) => Promise<T>) => Promise<T> };
type SystemDeps = <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;

/** What Slack sent, as the bot's forwarded-event entry takes it: the Socket Mode envelope's type and its body. */
export interface SlackEnvelope {
  eventType: string;
  body: unknown;
}

/** A question from Slack, as it's recorded. */
export interface SlackInboundEvent {
  teamId: string;
  /** `m:<channel>:<ts>` for a message, `a:<trigger_id>` for a press. */
  key: string;
  kind: "message" | "press";
  slackThreadId: string;
  slackUserId: string;
  envelope: SlackEnvelope;
}

/** How many times a question is handed to the bot again before the person is told it was lost. */
export const SLACK_INBOUND_REPLAYS = 3;

/** The OpenDash workspace a Slack team belongs to, while it's connected (its token kept); null otherwise. */
export async function connectedSlackTeam(
  deps: PublicDeps,
  teamId: string,
): Promise<{ orgId: string; botUserId: string } | null> {
  const [team] = await deps.withPublic((tx) =>
    tx.execute<{ org_id: string; secret_id: string | null; bot_user_id: string }>(sql`
      select org_id, secret_id, bot_user_id from app.slack_team(${teamId})`),
  );
  return team?.secret_id ? { orgId: team.org_id, botUserId: team.bot_user_id } : null;
}

/**
 * Records a question before it's acknowledged. "new" when this delivery made the row (it's the one handed to the
 * bot), "seen" when an earlier one did (a retry, or a message's twin). It may be handed to the bot again `againAfterMs`
 * from now, if nothing has handled it by then.
 */
export async function recordSlackInbound(
  deps: Pick<LedgerDeps, "withTenant">,
  orgId: string,
  event: SlackInboundEvent,
  againAfterMs: number,
): Promise<"new" | "seen"> {
  const made = await deps.withTenant(orgId, (tx) =>
    tx.execute<{ key: string }>(sql`
      insert into app.slack_inbound (org_id, team_id, key, kind, slack_thread_id, slack_user_id, envelope, next_at)
      values (${orgId}, ${event.teamId}, ${event.key}, ${event.kind}, ${event.slackThreadId}, ${event.slackUserId},
        ${toJsonb(event.envelope)}::jsonb, now() + make_interval(secs => ${againAfterMs / 1000}))
      on conflict do nothing returning key`),
  );
  return made.length ? "new" : "seen";
}

/** The question was asked: in the transaction that asks it, so a question asked is never handed to the bot again. */
export async function slackInboundAsked(
  tx: TenantTx,
  orgId: string,
  teamId: string,
  key: string,
  runId: string,
): Promise<void> {
  await tx.execute(sql`
    update app.slack_inbound set status = 'asked', run_id = ${runId}, envelope = null, handled_at = now()
    where org_id = ${orgId} and team_id = ${teamId} and key = ${key} and status = 'received'`);
}

/** The bot is done with it and asked nothing (it said something instead, or added it to a running answer). */
export async function slackInboundHandled(
  deps: Pick<LedgerDeps, "withTenant">,
  orgId: string,
  teamId: string,
  key: string,
): Promise<void> {
  await deps.withTenant(orgId, (tx) =>
    tx.execute(sql`
      update app.slack_inbound set status = 'handled', envelope = null, handled_at = now()
      where org_id = ${orgId} and team_id = ${teamId} and key = ${key} and status = 'received'`),
  );
}

/** A question nothing handled in time, taken for the bot again or (after its last try) to tell the person. */
export interface DueSlackInbound {
  orgId: string;
  teamId: string;
  key: string;
  kind: "message" | "press";
  slackThreadId: string;
  slackUserId: string;
  envelope: SlackEnvelope | null;
  /** Its last try was used: it's marked lost, and the person is told. */
  lost: boolean;
}

/**
 * The questions still received when they were due, at most `limit`, across workspaces (the worker's replay job):
 * each taken for one more try `againAfterMs` from now, or, past its last, marked lost. Taken rows are skipped by a
 * second replayer running at once.
 */
export async function takeDueSlackInbound(
  withSystem: SystemDeps,
  options: { limit: number; againAfterMs: number },
): Promise<DueSlackInbound[]> {
  return withSystem(async (tx) => {
    const due = await tx.execute<{
      org_id: string;
      team_id: string;
      key: string;
      kind: "message" | "press";
      slack_thread_id: string;
      slack_user_id: string;
      envelope: SlackEnvelope | null;
      replays: number;
    }>(sql`
      select org_id, team_id, key, kind, slack_thread_id, slack_user_id, envelope, replays from app.slack_inbound
      where status = 'received' and next_at <= now()
      order by next_at limit ${options.limit}
      for update skip locked`);
    const taken: DueSlackInbound[] = [];
    for (const r of due) {
      const lost = r.replays >= SLACK_INBOUND_REPLAYS;
      await tx.execute(
        lost
          ? sql`
              update app.slack_inbound set status = 'lost', envelope = null, handled_at = now()
              where org_id = ${r.org_id} and team_id = ${r.team_id} and key = ${r.key}`
          : sql`
              update app.slack_inbound
              set replays = replays + 1, next_at = now() + make_interval(secs => ${options.againAfterMs / 1000})
              where org_id = ${r.org_id} and team_id = ${r.team_id} and key = ${r.key}`,
      );
      taken.push({
        orgId: r.org_id,
        teamId: r.team_id,
        key: r.key,
        kind: r.kind,
        slackThreadId: r.slack_thread_id,
        slackUserId: r.slack_user_id,
        envelope: lost ? null : r.envelope,
        lost,
      });
    }
    return taken;
  });
}

/** Questions recorded over a week ago, whatever became of them (maint). */
export async function purgeSlackInbound(withSystem: SystemDeps): Promise<number> {
  return withSystem(async (tx) => {
    const gone = await tx.execute(sql`
      delete from app.slack_inbound where received_at < now() - interval '7 days' returning key`);
    return gone.length;
  });
}

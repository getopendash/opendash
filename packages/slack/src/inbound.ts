/**
 * Slack's events before the bot. Every question is recorded before Slack hears it arrived: the socket
 * (worker) and the event route (web) put each event through `gateSlackEvent`, which records a question and says
 * whether this delivery is the one to hand to the bot (Slack's retries and a message's twins, `message` and
 * `app_mention`, are the same record, so they ask once). A question is a message to the bot (a DM, or one mentioning
 * it) or a press of one of its buttons; every other event goes to the bot unrecorded, and the bot hears every message
 * in its channels, so nothing else is kept. The worker hands a question nothing handled in time to the bot again
 * (`replaySlackInbound`), through the same forwarded-event entry its socket uses.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  connectedSlackTeam,
  type DueSlackInbound,
  type LedgerDeps,
  recordSlackInbound,
  type SecretStore,
  type SlackEnvelope,
  type SlackInboundEvent,
  slackBotToken,
  takeDueSlackInbound,
} from "@opendash/core";
import type { PublicTx, SystemTx } from "@opendash/db";
import type { Chat } from "chat";
import { tellPrivately } from "./privately";

/**
 * How long Chat SDK remembers a message it has handled (its `dedupeTtlMs`): one handed to it again within this is
 * dropped as a twin. Set on the bot from here, beside the replay that has to wait it out.
 */
export const DEDUPE_TTL_MS = 5 * 60_000;
/** When a question nothing handled is handed to the bot again: once Chat SDK has forgotten it, and again after that. */
export const REPLAY_AFTER_MS = DEDUPE_TTL_MS + 60_000;

/** The Slack team an event or a message came from (the shapes Slack sends it in). */
export function teamOf(raw: unknown): string | null {
  const p = (raw ?? {}) as { team_id?: unknown; team?: unknown; user?: { team_id?: unknown } };
  if (typeof p.team_id === "string" && p.team_id) return p.team_id;
  if (typeof p.team === "string" && p.team) return p.team;
  if (p.team && typeof p.team === "object" && typeof (p.team as { id?: unknown }).id === "string") {
    return (p.team as { id: string }).id;
  }
  if (typeof p.user?.team_id === "string" && p.user.team_id) return p.user.team_id;
  return null;
}

/** The presses that ask a question: a source picked, an option, the questions' Send, a follow-up. */
const ASKING = /^opendash:(source|option|send|next)(:|$)/;

/** The kinds of message that are someone writing: Slack's other subtypes (edits, joins, a bot's post) aren't. */
const WRITTEN = new Set([undefined, "file_share", "thread_broadcast"]);

/**
 * A question's record key, from what a handler is given (a message's Slack event, or a press's payload): the key
 * `inboundOf` recorded it under. Null for anything else.
 */
export function inboundKeyOf(raw: unknown): string | null {
  const r = (raw ?? {}) as { channel?: unknown; ts?: unknown; trigger_id?: unknown; type?: unknown };
  if (r.type === "block_actions") return typeof r.trigger_id === "string" && r.trigger_id ? `a:${r.trigger_id}` : null;
  return typeof r.channel === "string" && typeof r.ts === "string" ? `m:${r.channel}:${r.ts}` : null;
}

/** The question an event carries, if it carries one: what's recorded of it. `botUserId` is the team's bot. */
export function inboundOf(envelope: SlackEnvelope, botUserId: string): Omit<SlackInboundEvent, "envelope"> | null {
  const body = (envelope.body ?? {}) as Record<string, unknown>;
  const teamId = teamOf(body);
  if (!teamId) return null;
  if (envelope.eventType === "events_api" && body.type === "event_callback") {
    const e = (body.event ?? {}) as {
      type?: unknown;
      subtype?: unknown;
      bot_id?: unknown;
      user?: unknown;
      channel?: unknown;
      channel_type?: unknown;
      ts?: unknown;
      thread_ts?: unknown;
      text?: unknown;
    };
    if (e.type !== "message" && e.type !== "app_mention") return null;
    if (e.bot_id || !WRITTEN.has(e.subtype as string | undefined)) return null;
    if (typeof e.user !== "string" || typeof e.channel !== "string" || typeof e.ts !== "string") return null;
    // In a channel, only what's addressed to the bot: app_mention, or its twin naming it.
    const toBot =
      e.type === "app_mention" ||
      e.channel_type === "im" ||
      (botUserId !== "" && typeof e.text === "string" && e.text.includes(`<@${botUserId}>`));
    if (!toBot) return null;
    const threadTs = typeof e.thread_ts === "string" && e.thread_ts ? e.thread_ts : e.ts;
    return {
      teamId,
      key: `m:${e.channel}:${e.ts}`,
      kind: "message",
      slackThreadId: `slack:${e.channel}:${threadTs}`,
      slackUserId: e.user,
    };
  }
  if (envelope.eventType === "interactive" && body.type === "block_actions") {
    const p = body as {
      trigger_id?: unknown;
      user?: { id?: unknown };
      channel?: { id?: unknown };
      message?: { ts?: unknown; thread_ts?: unknown };
      actions?: { action_id?: unknown }[];
    };
    const actionId = p.actions?.[0]?.action_id;
    // Only the bot's own buttons that ask something. A tick in a question's form only changes its state (Send carries
    // every pick); 👍/👎, Open in OpenDash and App Home's buttons ask nothing.
    if (typeof actionId !== "string" || !ASKING.test(actionId)) return null;
    const channel = p.channel?.id;
    const ts = p.message?.thread_ts ?? p.message?.ts;
    if (typeof p.trigger_id !== "string" || typeof p.user?.id !== "string" || typeof channel !== "string") return null;
    return {
      teamId,
      key: `a:${p.trigger_id}`,
      kind: "press",
      slackThreadId: `slack:${channel}:${typeof ts === "string" ? ts : ""}`,
      slackUserId: p.user.id,
    };
  }
  return null;
}

/**
 * A request to the event route as the envelope Slack's socket would have sent (so it's recorded, and replayed, in one
 * shape): an Events API callback as `events_api`, a press's form-encoded `payload` as `interactive`. Null for anything
 * else (Slack's URL check, a slash command), which goes to the bot as it is.
 */
export function envelopeOfRequest(contentType: string | null, body: string): SlackEnvelope | null {
  try {
    if (contentType?.includes("application/json")) {
      const payload = JSON.parse(body) as { type?: unknown };
      return payload?.type === "event_callback" ? { eventType: "events_api", body: payload } : null;
    }
    if (contentType?.includes("application/x-www-form-urlencoded")) {
      const payload = new URLSearchParams(body).get("payload");
      return payload ? { eventType: "interactive", body: JSON.parse(payload) } : null;
    }
  } catch {
    return null;
  }
  return null;
}

/** What the gate reads and writes. */
export type GateDeps = Pick<LedgerDeps, "withTenant"> & {
  withPublic: <T>(fn: (tx: PublicTx) => Promise<T>) => Promise<T>;
};

/**
 * Whether to hand an event to the bot. A question is recorded first ("forward" only for the delivery that made the
 * record, "skip" for a retry or a twin); a question from a Slack team OpenDash doesn't know (or that took the app back)
 * is skipped, since nothing could be answered there. Anything else is forwarded. Throws when a question couldn't be
 * recorded: the caller then doesn't acknowledge it (the socket) or answers 500 (HTTP), and Slack sends it again.
 */
export async function gateSlackEvent(deps: GateDeps, envelope: SlackEnvelope): Promise<"forward" | "skip"> {
  const teamId = teamOf(envelope.body);
  if (!teamId) return "forward";
  const team = await connectedSlackTeam(deps, teamId);
  if (!team) return inboundOf(envelope, "") ? "skip" : "forward";
  const question = inboundOf(envelope, team.botUserId);
  if (!question) return "forward";
  const made = await recordSlackInbound(deps, team.orgId, { ...question, envelope }, REPLAY_AFTER_MS);
  return made === "new" ? "forward" : "skip";
}

/** Hands an event to the bot as its own socket would: the adapter's forwarded-event entry, with its secret. */
export async function forwardToBot(
  slack: Pick<SlackAdapter, "handleWebhook">,
  forwardingSecret: string,
  envelope: SlackEnvelope & { retryNum?: number },
  track: (task: Promise<unknown>) => void,
): Promise<Response> {
  const forwarded = new Request("http://opendash.socket/slack", {
    method: "POST",
    headers: { "content-type": "application/json", "x-slack-socket-token": forwardingSecret },
    body: JSON.stringify({
      type: "socket_event",
      eventType: envelope.eventType,
      body: envelope.body,
      retryNum: envelope.retryNum,
      timestamp: Date.now(),
    }),
  });
  return slack.handleWebhook(forwarded, { waitUntil: track });
}

/** What the replay needs: every workspace's questions, each team's token, and the bot. */
export interface ReplayDeps extends GateDeps {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  secrets: SecretStore;
}

/** What the person is told when their question couldn't be asked. */
export const LOST_QUESTION = "I lost that question on the way in. Please ask it again.";

/**
 * Whether a lost question's thread is one Slack shows (privately.ts). A message said in the channel names its thread
 * after itself, and the bot never answered it, so that thread has no replies. A press is on the bot's own card, which
 * sits in its thread.
 */
export function lostThreadShown(d: Pick<DueSlackInbound, "kind" | "key" | "slackThreadId">): boolean {
  if (d.kind === "press") return true;
  const ts = d.key.slice(d.key.lastIndexOf(":") + 1);
  return !d.slackThreadId.endsWith(`:${ts}`);
}

/**
 * The worker's replay (slack.inbound.check): each question nothing handled in time, handed to the bot again; past its
 * last try, the person told privately, where Slack shows it. What's said goes with the team's own token, and a team
 * that took the app back meanwhile is told nothing. Returns what it did, for the log.
 */
export async function replaySlackInbound(
  deps: ReplayDeps,
  bot: Chat,
  slack: Pick<SlackAdapter, "handleWebhook" | "withBotToken">,
  forwardingSecret: string,
  track: (task: Promise<unknown>) => void,
  limit = 20,
): Promise<{ replayed: number; lost: number }> {
  const due: DueSlackInbound[] = await takeDueSlackInbound(deps.withSystem, { limit, againAfterMs: REPLAY_AFTER_MS });
  let replayed = 0;
  let lost = 0;
  for (const d of due) {
    if (!d.lost && d.envelope) {
      await forwardToBot(slack, forwardingSecret, d.envelope, track);
      replayed += 1;
      continue;
    }
    lost += 1;
    const token = (await slackBotToken(deps, d.teamId))?.token;
    if (!token) continue;
    await slack
      .withBotToken(
        token,
        () => tellPrivately(bot.thread(d.slackThreadId), d.slackUserId, LOST_QUESTION, lostThreadShown(d)),
        { installationId: d.teamId },
      )
      .catch(() => {});
  }
  return { replayed, lost };
}

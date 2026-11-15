/**
 * Slack's Web API from OpenDash's own code: the channels a routine can post in, checking the ones it
 * names, and posting a routine's message once. Each call goes through `fetch` with its timeout (BUDGETS.slack), and
 * never inside a transaction: the token is read in one, the call made after it. The bot itself (the Chat SDK) is
 * @opendash/slack's.
 */
import { sql, type TenantTx } from "@opendash/db";
import { BUDGETS } from "../budgets";
import type { SecretStore } from "../secrets/store";

const SLACK_API = "https://slack.com/api";

/** What Slack said no with (`not_in_channel`, `ratelimited`), or a call that never got an answer (`timeout`). */
export class SlackApiError extends Error {
  override name = "SlackApiError";
  constructor(readonly code: string) {
    super(`Slack said: ${code}`);
  }
}

/** Slack's refusals no retry changes: the token gone, or the channel. A routine's post fails there, once. */
export const SLACK_FOR_GOOD = new Set([
  "token_revoked",
  "invalid_auth",
  "account_inactive",
  "not_authed",
  "channel_not_found",
  "not_in_channel",
  "is_archived",
  "restricted_action",
  // Ours: the channel is shared with another company now (Slack Connect), so nothing of a routine's goes there.
  "channel_external",
]);

/** Slack refusing a message's blocks: it's posted again as its text alone. */
const REFUSED_BLOCKS = new Set(["invalid_blocks", "invalid_blocks_format", "invalid_arguments"]);

/** What a routine's posts carry as their message metadata: the outbox row's id, nothing said. */
export const ROUTINE_EVENT = "opendash_routine";

export type SlackFetch = typeof fetch;

/** One Web API call, form-encoded (every method takes it; nested values as JSON), with its timeout. */
export async function slackApi<T>(
  token: string,
  method: string,
  args: Record<string, unknown>,
  fetchImpl: SlackFetch = fetch,
): Promise<T> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    body.set(k, typeof v === "string" ? v : JSON.stringify(v));
  }
  let response: Response;
  try {
    response = await fetchImpl(`${SLACK_API}/${method}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(BUDGETS.slack.apiMs),
    });
  } catch (error) {
    throw new SlackApiError(error instanceof Error && error.name === "TimeoutError" ? "timeout" : "unreachable");
  }
  if (response.status === 429) throw new SlackApiError("ratelimited");
  const json = (await response.json().catch(() => null)) as ({ ok?: boolean; error?: string } & T) | null;
  if (!json?.ok) throw new SlackApiError(json?.error ?? `http_${response.status}`);
  return json;
}

/**
 * A Slack user's email (users.info's user), only when Slack confirmed the address is theirs; null otherwise. Linking a
 * Slack account trusts it to say who the person is, so an address its owner hasn't confirmed never
 * stands in for them.
 */
export function confirmedSlackEmail(
  user: { is_email_confirmed?: boolean; profile?: { email?: string } } | null | undefined,
): string | null {
  return user?.is_email_confirmed === true ? user.profile?.email?.trim().toLowerCase() || null : null;
}

export interface SlackWorkspaceToken {
  teamId: string;
  teamName: string;
  botUserId: string;
  token: string;
}

/** The workspace's connected Slack and its bot token; null when none is, or Slack took the app back. */
export async function slackWorkspaceToken(
  deps: { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>; secrets: SecretStore },
  orgId: string,
): Promise<SlackWorkspaceToken | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [w] = await tx.execute<{
      team_id: string;
      team_name: string;
      bot_user_id: string;
      secret_id: string | null;
      removed_at: string | null;
    }>(
      sql`select team_id, team_name, bot_user_id, secret_id, removed_at from app.slack_workspace where org_id = ${orgId}`,
    );
    if (!w?.secret_id || w.removed_at) return null;
    const token = await deps.secrets.reveal(tx, orgId, w.secret_id, "oauth");
    return { teamId: w.team_id, teamName: w.team_name, botUserId: w.bot_user_id, token };
  });
}

export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
  /** OpenDash's bot is in it: only then can a routine post there. */
  member: boolean;
}

type ChannelRow = {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  /** Shared with another company (Slack Connect), or asked to be. */
  is_ext_shared?: boolean;
  is_pending_ext_shared?: boolean;
};

/** A channel people outside the workspace's company read (Slack Connect): routines never post there. */
const external = (c: ChannelRow) => Boolean(c.is_ext_shared || c.is_pending_ext_shared);

/**
 * The channels a routine can name (public ones, and private ones the bot was invited to), not archived and not shared
 * with another company; those the bot is in first. At most 1,000.
 */
export async function listSlackChannels(token: string, fetchImpl: SlackFetch = fetch): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const found = await slackApi<{ channels?: ChannelRow[]; response_metadata?: { next_cursor?: string } }>(
      token,
      "conversations.list",
      { types: "public_channel,private_channel", exclude_archived: "true", limit: "200", cursor },
      fetchImpl,
    );
    for (const c of found.channels ?? []) {
      if (external(c)) continue;
      out.push({ id: c.id, name: c.name, private: Boolean(c.is_private), member: Boolean(c.is_member) });
    }
    cursor = found.response_metadata?.next_cursor || undefined;
    if (!cursor) break;
  }
  return out.sort((a, b) => Number(b.member) - Number(a.member) || a.name.localeCompare(b.name));
}

/**
 * One channel as Slack has it now: its name, archived, whether the bot is in it, private, and shared with another
 * company; null when it's gone.
 */
export async function slackChannelInfo(
  token: string,
  channelId: string,
  fetchImpl: SlackFetch = fetch,
): Promise<{
  id: string;
  name: string;
  archived: boolean;
  member: boolean;
  private: boolean;
  external: boolean;
} | null> {
  try {
    const { channel } = await slackApi<{ channel: ChannelRow }>(
      token,
      "conversations.info",
      { channel: channelId },
      fetchImpl,
    );
    return {
      id: channel.id,
      name: channel.name,
      archived: Boolean(channel.is_archived),
      member: Boolean(channel.is_member),
      private: Boolean(channel.is_private),
      external: external(channel),
    };
  } catch (error) {
    if (error instanceof SlackApiError && error.code === "channel_not_found") return null;
    throw error;
  }
}

type HistoryMessage = {
  ts?: string;
  user?: string;
  metadata?: { event_type?: string; event_payload?: { effect?: string } };
};

/** How many pages of a channel's history a later attempt reads, looking for its post. */
export const LOOKUP_PAGES = 3;

/**
 * The most Slack calls one post makes: the channel's state, the look, then a post and its text-only retry
 * (budgets.test.ts).
 */
export const CALLS_PER_POST = 1 + LOOKUP_PAGES + 2;

/**
 * A routine's post an earlier attempt may have made, found in the channel by its metadata. Only a message OpenDash's
 * own bot posted counts: any app in the workspace can put metadata on a message.
 */
async function findPost(
  token: string,
  input: { channelId: string; effectId: string; botUserId: string; since: Date },
  fetchImpl: SlackFetch,
): Promise<string | null> {
  let cursor: string | undefined;
  // From a little before its row was made: the clocks agree to within that.
  const oldest = String(Math.floor(input.since.getTime() / 1000) - 300);
  for (let page = 0; page < LOOKUP_PAGES; page++) {
    const found = await slackApi<{ messages?: HistoryMessage[]; response_metadata?: { next_cursor?: string } }>(
      token,
      "conversations.history",
      { channel: input.channelId, oldest, include_all_metadata: "true", limit: "200", cursor },
      fetchImpl,
    );
    const hit = (found.messages ?? []).find(
      (m) =>
        input.botUserId !== "" &&
        m.user === input.botUserId &&
        m.metadata?.event_type === ROUTINE_EVENT &&
        m.metadata.event_payload?.effect === input.effectId,
    );
    if (hit?.ts) return hit.ts;
    cursor = found.response_metadata?.next_cursor || undefined;
    if (!cursor) return null;
  }
  return null;
}

export type SlackPostResult = { status: "sent"; ts: string } | { status: "unknown"; why: string };

/**
 * Posts a routine's message once. A later attempt (one before it may have posted, then stopped) looks for its post
 * first; when it can't tell, it says `unknown` rather than post a second time. Slack refusing the blocks: posted as
 * text alone. Slack refusing for good (`SLACK_FOR_GOOD`) and anything to retry are thrown as SlackApiError.
 */
export async function postSlackOnce(
  token: string,
  input: {
    channelId: string;
    effectId: string;
    botUserId: string;
    /** Which attempt this is (the outbox row's, counted when it's claimed). */
    attempt: number;
    /** When the row was made. */
    since: Date;
    text: string;
    blocks: unknown[];
  },
  fetchImpl: SlackFetch = fetch,
): Promise<SlackPostResult> {
  if (input.attempt > 1) {
    try {
      const ts = await findPost(token, input, fetchImpl);
      if (ts) return { status: "sent", ts };
    } catch (error) {
      return { status: "unknown", why: error instanceof SlackApiError ? error.code : "lookup_failed" };
    }
  }
  const message = {
    channel: input.channelId,
    text: input.text,
    metadata: { event_type: ROUTINE_EVENT, event_payload: { effect: input.effectId } },
    unfurl_links: "false",
    unfurl_media: "false",
  };
  try {
    const posted = await slackApi<{ ts?: string }>(
      token,
      "chat.postMessage",
      { ...message, blocks: input.blocks },
      fetchImpl,
    );
    return { status: "sent", ts: posted.ts ?? "" };
  } catch (error) {
    if (!(error instanceof SlackApiError) || !REFUSED_BLOCKS.has(error.code)) throw error;
    const posted = await slackApi<{ ts?: string }>(token, "chat.postMessage", message, fetchImpl);
    return { status: "sent", ts: posted.ts ?? "" };
  }
}

/** A routine's post, as the outbox hands it over. */
export interface SlackPostInput {
  orgId: string;
  teamId: string;
  channelId: string;
  effectId: string;
  attempt: number;
  since: Date;
  text: string;
  blocks: unknown[];
}

/** Posts with the workspace's own token; a team that isn't the connected one is refused for good. */
export function slackPoster(
  deps: Parameters<typeof slackWorkspaceToken>[0],
  fetchImpl: SlackFetch = fetch,
): (input: SlackPostInput) => Promise<SlackPostResult> {
  return async (input) => {
    const w = await slackWorkspaceToken(deps, input.orgId);
    if (!w || w.teamId !== input.teamId) throw new SlackApiError("not_authed");
    // As the channel is now, not as it was when the routine was saved: one shared with another company since gets
    // nothing, and the send fails for good, saying so.
    const channel = await slackChannelInfo(w.token, input.channelId, fetchImpl);
    if (!channel) throw new SlackApiError("channel_not_found");
    if (channel.external) throw new SlackApiError("channel_external");
    return postSlackOnce(w.token, { ...input, botUserId: w.botUserId }, fetchImpl);
  };
}

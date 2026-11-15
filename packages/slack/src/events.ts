/**
 * Slack's events before the bot sees them: the signature on an HTTPS request, checked by OpenDash itself so
 * a request can be read first, and the two events that say Slack took the app back, which Chat SDK ignores.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signed request may be: Slack's own advice, against a replayed one. */
const MAX_AGE_SECONDS = 5 * 60;

/** Whether Slack signed this body with the app's signing secret, recently (`v0=` HMAC-SHA256 of `v0:<ts>:<body>`). */
export function slackSigned(
  secret: string,
  headers: { timestamp: string | null; signature: string | null },
  body: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const at = Number(headers.timestamp);
  if (!secret || !headers.signature || !Number.isInteger(at) || Math.abs(nowSeconds - at) > MAX_AGE_SECONDS) {
    return false;
  }
  const expected = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${at}:${body}`).digest("hex")}`);
  const given = Buffer.from(headers.signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Slack took the app back from a workspace: uninstalled there, or its bot token revoked. */
export interface SlackRemoval {
  teamId: string;
  why: "uninstalled" | "tokens_revoked";
  /** When Slack says it happened (its `event_time`, seconds): an install made after it isn't removed by it. */
  eventTime: number | null;
  /** For a token revoked: whose bot tokens (Slack's bot user ids). Only the bot OpenDash keeps for the team counts. */
  botUserIds?: string[];
}

/**
 * The removal an Events API payload carries, if it is one: `app_uninstalled`, or `tokens_revoked` naming a bot token.
 * An Enterprise Grid organization-wide installation is never one OpenDash keeps, so its events are never a removal.
 */
export function slackRemovalOf(payload: unknown): SlackRemoval | null {
  const p = (payload ?? {}) as {
    type?: unknown;
    team_id?: unknown;
    event_time?: unknown;
    is_enterprise_install?: unknown;
    authorizations?: { team_id?: unknown; is_enterprise_install?: unknown }[];
    event?: { type?: unknown; tokens?: { bot?: unknown } };
  };
  if (p.type !== "event_callback" || !p.event) return null;
  if (p.is_enterprise_install === true || p.authorizations?.[0]?.is_enterprise_install === true) return null;
  const teamId =
    typeof p.team_id === "string" && p.team_id
      ? p.team_id
      : typeof p.authorizations?.[0]?.team_id === "string"
        ? (p.authorizations[0].team_id as string)
        : null;
  if (!teamId) return null;
  const eventTime = typeof p.event_time === "number" && Number.isFinite(p.event_time) ? p.event_time : null;
  if (p.event.type === "app_uninstalled") return { teamId, why: "uninstalled", eventTime };
  const bot = p.event.tokens?.bot;
  const botUserIds = Array.isArray(bot) ? bot.filter((b): b is string => typeof b === "string" && b.length > 0) : [];
  if (p.event.type === "tokens_revoked" && botUserIds.length > 0) {
    return { teamId, why: "tokens_revoked", eventTime, botUserIds };
  }
  return null;
}

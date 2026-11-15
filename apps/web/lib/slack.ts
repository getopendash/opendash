import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { authBaseUrl } from "@opendash/auth";
import { BUDGETS, SlackProblem, type SlackTeam } from "@opendash/core";
import { withPublic, withTenant } from "@opendash/db";
import { secretStore } from "./sources";

/**
 * Slack, the web's part: the Slack calls Add to Slack needs, and the database access the link page
 * uses. How the deployment's Slack app is set up is @opendash/slack's `slackSetup`, which the worker reads too. The bot
 * listens at /api/slack/events, or in the worker over Socket Mode.
 */
export { type SlackSetup, slackSetup } from "@opendash/slack";

/** The web app's origin (BETTER_AUTH_URL; HTTPS in production), or null when it isn't set right. */
export function webOrigin(): string | null {
  try {
    return authBaseUrl().replace(/\/$/, "");
  } catch {
    return null;
  }
}

/**
 * Where Slack reaches OpenDash: its events, button presses and Add to Slack's return. SLACK_PUBLIC_URL when
 * Slack can't reach the web app's own address (locally, a tunnel to it), else the web app's origin. Slack only calls
 * https: null when it isn't.
 */
export function slackPublicUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const given = env.SLACK_PUBLIC_URL?.trim();
  try {
    const url = new URL(given || (webOrigin() ?? ""));
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export const slackDeps = {
  withPublic,
  withTenant: <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId }, fn),
  secrets: secretStore(),
};

/** The bot scopes OpenDash asks for: what infra/slack/manifest.json lists, nothing more. */
export const SLACK_SCOPES = [
  "app_mentions:read",
  "assistant:write",
  "channels:history",
  "channels:read",
  "chat:write",
  "files:read",
  "files:write",
  "groups:history",
  "groups:read",
  "im:history",
  "im:read",
  "im:write",
  "mpim:history",
  "mpim:read",
  "reactions:write",
  "users:read",
  "users:read.email",
];

const SLACK_API = "https://slack.com/api";

/** The Slack workspace and bot user a bot token belongs to (Slack's auth.test). */
export async function slackTeamOfToken(token: string): Promise<SlackTeam> {
  const response = await fetch(`${SLACK_API}/auth.test`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(BUDGETS.slack.apiMs),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    team?: string;
    team_id?: string;
    url?: string;
    user_id?: string;
  };
  if (!body.ok || !body.team_id || !body.user_id) {
    throw new SlackProblem(`Slack didn't accept the app's token (${body.error ?? `HTTP ${response.status}`}).`);
  }
  let domain: string | null = null;
  try {
    domain = body.url ? (new URL(body.url).hostname.split(".")[0] ?? null) : null;
  } catch {
    domain = null;
  }
  return { teamId: body.team_id, teamName: body.team ?? body.team_id, teamDomain: domain, botUserId: body.user_id };
}

/** Exchanges an OAuth code for the bot's token and its workspace (oauth.v2.access). */
export async function slackOAuthAccess(code: string, redirectUri: string): Promise<{ team: SlackTeam; token: string }> {
  const response = await fetch(`${SLACK_API}/oauth.v2.access`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID ?? "",
      client_secret: process.env.SLACK_CLIENT_SECRET ?? "",
      code,
      redirect_uri: redirectUri,
    }),
    signal: AbortSignal.timeout(BUDGETS.slack.apiMs),
  });
  const body = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    token_type?: string;
    bot_user_id?: string;
    team?: { id?: string; name?: string };
    is_enterprise_install?: boolean;
  };
  if (!body.ok || body.token_type !== "bot" || !body.access_token || !body.bot_user_id || !body.team?.id) {
    throw new SlackProblem(`Slack didn't finish installing (${body.error ?? `HTTP ${response.status}`}).`);
  }
  // An Enterprise Grid organization-wide install isn't one Slack workspace: refused, its token given back.
  if (body.is_enterprise_install) {
    await slackRevoke(body.access_token);
    throw new SlackEnterprise();
  }
  try {
    return { team: await slackTeamOfToken(body.access_token), token: body.access_token };
  } catch (error) {
    // Not revoked here: the caller gives it back only when no OpenDash workspace uses this Slack workspace's token.
    throw new SlackUnconfirmed(body.team.id, body.access_token, error);
  }
}

/** Slack installed the app but didn't confirm its token after (auth.test): the token, for the caller to decide on. */
export class SlackUnconfirmed extends SlackProblem {
  constructor(
    readonly teamId: string,
    readonly token: string,
    cause: unknown,
  ) {
    super("Slack didn't confirm the app's token.", { cause });
  }
}

/** An Enterprise Grid organization-wide install, which OpenDash doesn't take. */
export class SlackEnterprise extends SlackProblem {
  constructor() {
    super("OpenDash is added to one Slack workspace at a time, not to an Enterprise Grid organization.");
  }
}

/**
 * Gives a bot token back to Slack (auth.revoke): one OpenDash got but won't keep (a workspace already taken, one
 * disconnected). True when Slack confirmed it; never throws, as the caller has already decided.
 */
export async function slackRevoke(token: string): Promise<boolean> {
  try {
    const response = await fetch(`${SLACK_API}/auth.revoke`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(BUDGETS.slack.apiMs),
    });
    const body = (await response.json().catch(() => ({}))) as { ok?: boolean; revoked?: boolean };
    return Boolean(body.ok && body.revoked);
  } catch {
    return false;
  }
}

/**
 * The OAuth state: who started installing, for which workspace, which install, until when, signed with the auth
 * secret. Slack hands it back unchanged; anything else is refused. It names the install; the install, not this,
 * proves which browser started it.
 */
export interface SlackInstallState {
  orgId: string;
  userId: string;
  installId: string;
  expires: number;
}

const key = () => {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("Set BETTER_AUTH_SECRET.");
  return createHmac("sha256", secret).update("opendash:slack-install").digest();
};

export function signInstallState(
  input: { orgId: string; userId: string; installId: string },
  now = Date.now(),
): SlackInstallState & { state: string } {
  const s: SlackInstallState = { ...input, expires: now + 10 * 60_000 };
  const payload = Buffer.from(JSON.stringify(s)).toString("base64url");
  const mac = createHmac("sha256", key()).update(payload).digest("base64url");
  return { ...s, state: `${payload}.${mac}` };
}

export function readInstallState(state: string, now = Date.now()): SlackInstallState | null {
  const [payload, mac] = state.split(".");
  if (!payload || !mac) return null;
  const expected = createHmac("sha256", key()).update(payload).digest();
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as SlackInstallState;
    return typeof s.expires === "number" && s.expires > now && s.orgId && s.userId && s.installId ? s : null;
  } catch {
    return null;
  }
}

/** The secret the browser that pressed Add to Slack keeps, until it confirms the install (Settings → Slack only). */
export const SLACK_INSTALL_COOKIE = "opendash_slack_install";
export const SLACK_INSTALL_COOKIE_PATH = "/settings/slack";

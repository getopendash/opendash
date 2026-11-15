/**
 * OpenDash's App Home tab in Slack: the OpenDash workspace it's connected to, whether the person is linked
 * (with Unlink, or Link account), how to ask, and their last five conversations with Open. Published when they open
 * the tab, and again after they link or unlink there.
 *
 * Chat SDK's own App Home event doesn't say which Slack team it's from, so the socket (worker) and the event route
 * (web) read the tab opening from the event itself (`homeOpenedOf`), as they read Slack taking the app back. Everything
 * on the tab is plain text: a conversation's title is the person's own, and nothing in it is markup.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import { type SecretStore, type SlackEnvelope, type SlackHome, slackBotToken, slackHomeOf } from "@opendash/core";
import type { GateDeps } from "./inbound";

/** The tab's buttons. */
export const HOME_LINK = "opendash:home:link";
export const HOME_UNLINK = "opendash:home:unlink";

/** Someone opened the Home tab: their team and Slack user. Null for any other event (the Messages tab included). */
export function homeOpenedOf(envelope: SlackEnvelope): { teamId: string; userId: string } | null {
  const body = (envelope.body ?? {}) as {
    type?: unknown;
    team_id?: unknown;
    event?: { type?: unknown; tab?: unknown; user?: unknown };
  };
  if (envelope.eventType !== "events_api" || body.type !== "event_callback") return null;
  const e = body.event;
  if (e?.type !== "app_home_opened" || e.tab !== "home") return null;
  if (typeof body.team_id !== "string" || typeof e.user !== "string") return null;
  return { teamId: body.team_id, userId: e.user };
}

const text = (t: string) => ({ type: "plain_text", text: t, emoji: true });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/**
 * The tab, as Slack's `home` view. `link`: a link to confirm their account, just made (they pressed Link account), its
 * address in a button that opens it.
 */
export function homeView(home: SlackHome, webUrl: string, link: string | null = null): Record<string, unknown> {
  const base = webUrl.replace(/\/$/, "");
  const blocks: Record<string, unknown>[] = [
    { type: "header", text: text("OpenDash") },
    {
      type: "context",
      elements: [{ type: "plain_text", text: `Connected to ${home.organization || "your OpenDash workspace"}.` }],
    },
  ];
  if (home.linked) {
    blocks.push({
      type: "section",
      text: text("Your Slack account is linked: you ask as yourself, with your access."),
      accessory: {
        type: "button",
        action_id: HOME_UNLINK,
        text: text("Unlink"),
        confirm: {
          title: text("Unlink your account?"),
          text: text("You'll need to link it again to ask OpenDash here."),
          confirm: text("Unlink"),
          deny: text("Keep it"),
        },
      },
    });
  } else if (link) {
    blocks.push({
      type: "section",
      text: text("Open the link to confirm it's you. It works once, for 10 minutes."),
      accessory: {
        type: "button",
        action_id: "opendash:home:open-link",
        text: text("Open the link"),
        url: link,
        style: "primary",
      },
    });
  } else {
    blocks.push({
      type: "section",
      text: text("Link your Slack account to OpenDash, so you ask as yourself, with your access."),
      accessory: { type: "button", action_id: HOME_LINK, text: text("Link account"), style: "primary" },
    });
  }
  blocks.push(
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*How to ask*" } },
    {
      type: "section",
      text: text("Open OpenDash in the Agents tab, send it a message, or mention @OpenDash in a channel's thread."),
    },
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*Your recent conversations*" } },
  );
  if (!home.conversations.length) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "plain_text",
          text: home.linked ? "Nothing yet: ask your first question." : "Link your account to ask.",
        },
      ],
    });
  }
  for (const c of home.conversations) {
    blocks.push({
      type: "section",
      text: text(`${c.title.slice(0, 140) || "Untitled"} · ${DAY.format(new Date(c.at))}`),
      accessory: {
        type: "button",
        action_id: `opendash:home:open:${c.threadId}`,
        text: text("Open"),
        url: `${base}/ask/${encodeURIComponent(c.threadId)}`,
      },
    });
  }
  return { type: "home", blocks };
}

/** What publishing the tab needs: the team's token, and what the tab shows. */
export type HomeDeps = GateDeps & { secrets: SecretStore; webUrl: string };

/**
 * Publishes someone's tab, with the team's own token: nothing for a team OpenDash doesn't know (or that took the app
 * back). Slack's refusal is the caller's to log.
 */
export async function publishSlackHome(
  deps: HomeDeps,
  slack: Pick<SlackAdapter, "publishHomeView" | "withBotToken">,
  teamId: string,
  userId: string,
  link: string | null = null,
): Promise<boolean> {
  const home = await slackHomeOf(deps, teamId, userId);
  const token = home ? (await slackBotToken(deps, teamId))?.token : null;
  if (!home || !token) return false;
  await slack.withBotToken(token, () => slack.publishHomeView(userId, homeView(home, deps.webUrl, link)), {
    installationId: teamId,
  });
  return true;
}

import "server-only";
import { randomBytes } from "node:crypto";
import { deploymentKeys } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { createSlackBot, publishSlackHome, slackState } from "@opendash/slack";
import { slackDeps, slackSetup, webOrigin } from "@/lib/slack";
import { queue } from "@/lib/sources";

type WebhookBot = {
  handle: (request: Request, waitUntil: (task: Promise<unknown>) => void) => Promise<Response>;
  /** Publishes someone's App Home tab, for the team the event came from. */
  home: (teamId: string, userId: string) => Promise<unknown>;
};
const shared = globalThis as unknown as { openDashSlackBot?: WebhookBot | null };

/**
 * The bot that hears Slack's events over HTTPS (the cloud's way). Null when Slack reaches this deployment
 * over the worker's Socket Mode connection instead, or has no Slack app: nothing here answers then. One per process.
 */
export function webhookBot(env: NodeJS.ProcessEnv = process.env): WebhookBot | null {
  if (shared.openDashSlackBot !== undefined) return shared.openDashSlackBot;
  const setup = slackSetup(env);
  const webUrl = webOrigin();
  const systemUrl = env.DATABASE_SYSTEM_URL?.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  if (setup.kind !== "oauth" || setup.socket || !webUrl || !systemUrl || !signingSecret) {
    shared.openDashSlackBot = null;
    return null;
  }
  const deps = {
    ...slackDeps,
    // A correction given with 👎 is kept as the person's own memory, in a transaction that carries them.
    withUser: <T>(orgId: string, userId: string, fn: Parameters<typeof withTenant<T>>[1]) =>
      withTenant({ orgId, userId }, fn),
    boss: queue,
    deploymentKeys: deploymentKeys(env),
    webUrl,
  };
  const { bot, slack } = createSlackBot(
    deps,
    // Nothing forwarded is taken here: the forwarding secret is one nobody knows.
    { signingSecret, forwardingSecret: randomBytes(32).toString("hex"), state: slackState(systemUrl).state },
  );
  const ready = bot.initialize();
  shared.openDashSlackBot = {
    handle: async (request, waitUntil) => {
      await ready;
      const hook = bot.webhooks.slack;
      return hook ? hook(request, { waitUntil }) : new Response("Not found", { status: 404 });
    },
    home: async (teamId, userId) => {
      await ready;
      return publishSlackHome(deps, slack, teamId, userId);
    },
  };
  return shared.openDashSlackBot;
}

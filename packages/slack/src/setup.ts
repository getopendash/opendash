/**
 * How this deployment's Slack app is set up, read the same way by the web app and the worker, so they
 * agree on who hears Slack's events. Add to Slack (OAuth) is the only install: the app's client id, client secret and
 * signing secret. With an app-level token too, events come over Socket Mode to the worker (a self-host with no public
 * address); without one, over HTTPS to the web app.
 */
export type SlackSetup =
  /** No Slack app here yet: the settings it still needs, and whether the old single-workspace token is set. */
  { kind: "off"; missing: string[]; legacyToken: boolean } | { kind: "oauth"; socket: boolean };

const NEEDED = ["SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET"] as const;

export function slackSetup(env: NodeJS.ProcessEnv = process.env): SlackSetup {
  const missing = NEEDED.filter((name) => !env[name]?.trim());
  if (missing.length) return { kind: "off", missing, legacyToken: Boolean(env.SLACK_BOT_TOKEN?.trim()) };
  return { kind: "oauth", socket: Boolean(env.SLACK_APP_TOKEN?.trim()) };
}

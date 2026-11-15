import "server-only";
import { connectSlack, SlackTaken, takeSlackInstall } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { slackDeps } from "./slack";

/** Postgres's unique violation: another OpenDash workspace connected the same Slack workspace at the same moment. */
const isUnique = (error: unknown) =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "23505";

export type SlackInstallOutcome = "connected" | "taken" | "another_here" | "not_this_browser";

/**
 * Connects a held Add to Slack, for the person who started it, from the browser they started in, with the code Slack's
 * return carried. The token is taken from its hold in one transaction and connected in the next, so a
 * Slack workspace that's taken leaves nothing held. A token OpenDash doesn't keep is left alone, never revoked: Slack
 * can hand the same bot token to another install, and revoking it would cut that one off (its reviews).
 */
export async function confirmSlackInstall(
  ctx: { orgId: string; userId: string },
  input: { installId: string; code: string; browserSecret: string },
): Promise<SlackInstallOutcome> {
  const taken = await withTenant(ctx, (tx) => takeSlackInstall(slackDeps, tx, ctx, input));
  if (!taken) return "not_this_browser";
  try {
    await withTenant(ctx, (tx) => connectSlack(slackDeps, tx, ctx, taken.team, taken.token));
    return "connected";
  } catch (error) {
    if (!(error instanceof SlackTaken) && !isUnique(error)) throw error;
    return error instanceof SlackTaken && error.where === "here" ? "another_here" : "taken";
  }
}

import {
  cancelSlackInstall,
  holdSlackInstall,
  returnSlackInstall,
  SlackInstallGone,
  SlackProblem,
} from "@opendash/core";
import { withTenant } from "@opendash/db";
import { NextResponse } from "next/server";
import { readInstallState, SlackEnterprise, slackDeps, slackOAuthAccess, slackPublicUrl, webOrigin } from "@/lib/slack";

/**
 * Add to Slack's callback, at OpenDash's public address (a tunnel locally), where the browser's session
 * may not be. The state must be ours and fresh, and its install unused: then the code is exchanged, and what Slack
 * gave is held, the token encrypted, until the person who started it confirms in the browser they started in. That
 * browser is sent back to Settings → Slack with a code, in the address's fragment so no server log has it. Only an
 * Enterprise Grid install's token is given back to Slack: any other Slack may hand to another install too, so a token
 * OpenDash doesn't keep is left alone (its reviews).
 */
export async function GET(request: Request) {
  const origin = webOrigin() ?? new URL(request.url).origin;
  const back = (result: string, fragment = "") =>
    NextResponse.redirect(`${origin}/settings/slack?slack=${result}${fragment}`);
  const url = new URL(request.url);
  const state = readInstallState(url.searchParams.get("state") ?? "");
  if (!state) return back("failed");
  const ctx = { orgId: state.orgId };
  if (url.searchParams.get("error")) {
    // Only an install still waiting for Slack: one already held isn't cancelled by an address anyone could replay.
    await withTenant(ctx, (tx) => cancelSlackInstall(tx, state.orgId, state.installId));
    return back("cancelled");
  }
  const code = url.searchParams.get("code");
  if (!code || !(await withTenant(ctx, (tx) => returnSlackInstall(tx, state.orgId, state.installId)))) {
    return back("failed");
  }
  const publicUrl = slackPublicUrl() ?? new URL(request.url).origin;
  let installed: Awaited<ReturnType<typeof slackOAuthAccess>>;
  try {
    installed = await slackOAuthAccess(code, `${publicUrl}/api/slack/oauth`);
  } catch (error) {
    if (error instanceof SlackEnterprise) return back("enterprise");
    if (error instanceof SlackProblem) return back("failed");
    throw error;
  }
  try {
    const held = await withTenant(ctx, (tx) =>
      holdSlackInstall(slackDeps, tx, state.orgId, state.installId, installed.team, installed.token),
    );
    return back("confirm", `#${state.installId}.${held}`);
  } catch (error) {
    // Replaced by a newer Add to Slack meanwhile, or purged: nothing is held.
    if (error instanceof SlackInstallGone) return back("failed");
    throw error;
  }
}

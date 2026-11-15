import { authRoutes } from "@opendash/auth/routes";
import { startSlackInstall } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import {
  SLACK_INSTALL_COOKIE,
  SLACK_INSTALL_COOKIE_PATH,
  SLACK_SCOPES,
  signInstallState,
  slackPublicUrl,
  slackSetup,
  webOrigin,
} from "@/lib/slack";
import { canManageTeam } from "@/lib/team";

/**
 * Whether a request came from OpenDash's own page: its Origin is the web app's, and the browser says it's same-origin
 * (Sec-Fetch-Site, when it sends one). A navigation forced from elsewhere (a link, a redirect after a sign-in link)
 * never is (its review: an install started that way could be confirmed into the wrong workspace).
 */
const fromOwnPage = (request: Request, origin: string) => {
  const site = request.headers.get("sec-fetch-site");
  return request.headers.get("origin") === origin && (site === null || site === "same-origin");
};

/**
 * Add to Slack (the only install): an owner or admin presses it on Settings → Slack, a form posted there.
 * The install is started for them, with a secret this browser keeps (a cookie only Settings → Slack reads), and a
 * signed state naming it. Slack comes back to OpenDash's public address, then this browser confirms.
 */
export async function POST(request: Request) {
  const origin = webOrigin();
  const publicUrl = slackPublicUrl();
  const settings = (result: string) =>
    NextResponse.redirect(new URL(`/settings/slack?slack=${result}`, origin ?? "http://localhost"), 303);
  if (!origin || !fromOwnPage(request, origin)) return settings("unavailable");
  const viewer = await currentViewer();
  if (viewer.kind !== "tenant") return NextResponse.redirect(new URL(authRoutes.signIn, origin), 303);
  const userId = viewer.ctx.userId;
  if (slackSetup().kind !== "oauth" || !publicUrl || !canManageTeam(viewer.role) || !userId) {
    return settings("unavailable");
  }
  const started = await withTenant(viewer.ctx, (tx) => startSlackInstall(tx, { orgId: viewer.ctx.orgId, userId }));
  const signed = signInstallState({ orgId: viewer.ctx.orgId, userId, installId: started.installId });
  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", process.env.SLACK_CLIENT_ID ?? "");
  authorize.searchParams.set("scope", SLACK_SCOPES.join(","));
  authorize.searchParams.set("redirect_uri", `${publicUrl}/api/slack/oauth`);
  authorize.searchParams.set("state", signed.state);
  const response = NextResponse.redirect(authorize, 303);
  response.cookies.set(SLACK_INSTALL_COOKIE, started.browserSecret, {
    httpOnly: true,
    secure: origin.startsWith("https:"),
    sameSite: "lax",
    path: SLACK_INSTALL_COOKIE_PATH,
    maxAge: 600,
  });
  return response;
}

/** Add to Slack is started only from Settings → Slack's button: a link or redirect here just goes there. */
export async function GET() {
  return NextResponse.redirect(new URL("/settings/slack", webOrigin() ?? "http://localhost"), 303);
}

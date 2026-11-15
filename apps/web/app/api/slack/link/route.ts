import { confirmSlackLink, slackLinkPreview } from "@opendash/core";
import { sql, withTenant } from "@opendash/db";
import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { currentViewer } from "@/lib/auth";
import { publicJson, smallJson } from "@/lib/public-json";
import { slackDeps } from "@/lib/slack";

/** Where the link's token waits while its person signs in: only this route reads it, for the link's 10 minutes. */
const COOKIE = "opendash_slack_link";
const PATH = "/api/slack/link";
const TOKEN = /^[A-Za-z0-9_-]{20,64}$/;

/**
 * A link to confirm a Slack account. The page reads the token from the link's fragment,
 * which no server sees, and sends it here once; it's kept in a short-lived httpOnly cookie, so a sign-in on the way,
 * even in another tab, comes back to it without the token ever being in an address. Signed in, the page first shows
 * who's linking (`confirm` unset), then links on confirm. The checks tell a stranger only that it isn't theirs: the
 * Slack account's email must be theirs, then the workspace theirs, then their role one that asks.
 */
export async function POST(request: Request) {
  const body = await smallJson(request);
  const given = typeof body?.token === "string" && TOKEN.test(body.token) ? body.token : null;
  const kept = (await cookies()).get(COOKIE)?.value;
  const token = given ?? (kept && TOKEN.test(kept) ? kept : "");
  const keep = (response: NextResponse) => {
    if (given) {
      response.cookies.set(COOKIE, given, {
        httpOnly: true,
        secure: new URL(request.url).protocol === "https:",
        sameSite: "lax",
        path: PATH,
        maxAge: 600,
      });
    }
    return response;
  };
  const forget = (response: NextResponse) => {
    response.cookies.delete({ name: COOKIE, path: PATH });
    return response;
  };
  if (!token) return forget(publicJson({ ok: false, reason: "invalid" }, 404));
  const viewer = await currentViewer();
  if (viewer.kind !== "tenant") return keep(publicJson({ ok: false, reason: "sign_in" }, 401));
  const who = { orgId: viewer.ctx.orgId, userId: viewer.user.id, email: viewer.user.email, role: viewer.role };
  if (body?.confirm !== true) {
    const preview = await slackLinkPreview(slackDeps, token, who);
    if (preview.kind === "invalid") return forget(publicJson({ ok: false, reason: "invalid" }, 404));
    if (preview.kind === "not_yours") {
      return keep(
        publicJson({ ok: false, reason: "not_yours", slackEmail: preview.shown, you: viewer.user.email }, 409),
      );
    }
    if (preview.kind !== "ok") return keep(publicJson({ ok: false, reason: preview.kind }, 409));
    const [org] = await withTenant(viewer.ctx, (tx) =>
      tx.execute<{ name: string }>(sql`select name from app.org where id = ${viewer.ctx.orgId}`),
    );
    return keep(
      publicJson({
        ok: true,
        preview: {
          teamName: preview.teamName,
          slackUserName: preview.slackUserName,
          you: viewer.user.name ? `${viewer.user.name} · ${viewer.user.email}` : viewer.user.email,
          workspace: org?.name ?? "",
        },
      }),
    );
  }
  const linked = await confirmSlackLink(slackDeps, who, token);
  if (linked.kind === "linked") return forget(publicJson({ ok: true, linked: { teamName: linked.teamName } }));
  if (linked.kind === "invalid") return forget(publicJson({ ok: false, reason: "invalid" }, 404));
  return keep(
    publicJson(
      linked.kind === "not_yours"
        ? { ok: false, reason: "not_yours", slackEmail: linked.shown, you: viewer.user.email }
        : { ok: false, reason: linked.kind },
      409,
    ),
  );
}

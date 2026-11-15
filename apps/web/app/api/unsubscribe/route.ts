import { applyUnsubscribe } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { NextResponse } from "next/server";
import { unsubscribeTarget } from "@/lib/unsubscribe";

/** The confirmation form's body at most: a token and a field. */
const MAX_FORM = 4096;

/**
 * One-click unsubscribe (RFC 8058). A mail client's own button posts "List-Unsubscribe=One-Click"
 * here with the token in the address; the confirmation page posts its form here. No sign-in: the signed token
 * is the permission, and it can only stop the one email it names. GET does nothing, so link scanners stop nothing.
 */
export async function POST(request: Request) {
  const url = new URL(request.url);
  // A mail client's token is in the address; only the page's form needs its body read, and that's small.
  const fromAddress = url.searchParams.get("t");
  let form: FormData | null = null;
  if (!fromAddress) {
    const length = Number(request.headers.get("content-length"));
    if (!Number.isFinite(length) || length <= 0 || length > MAX_FORM) {
      return NextResponse.json({ ok: false, message: "That link isn't one of ours." }, { status: 400 });
    }
    form = await request.formData().catch(() => null);
  }
  const fromForm = form?.get("t");
  const token = fromAddress ?? (typeof fromForm === "string" ? fromForm : null);
  const target = unsubscribeTarget(token);
  if (!target) return NextResponse.json({ ok: false, message: "That link isn't one of ours." }, { status: 400 });
  await withTenant({ orgId: target.orgId, userId: target.userId }, (tx) => applyUnsubscribe(tx, target));
  // The page's own form comes back to say so; a mail client only needs to hear it worked.
  if (form?.get("from") === "page") {
    return NextResponse.redirect(new URL(`/unsubscribe?t=${encodeURIComponent(token as string)}&done=1`, url), 303);
  }
  return NextResponse.json({ ok: true });
}

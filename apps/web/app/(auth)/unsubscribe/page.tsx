import { buttonVariants } from "@heroui/react";
import { describeUnsubscribe } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { MailCheck, MailX, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { unsubscribeTarget } from "@/lib/unsubscribe";

export const metadata: Metadata = { title: "Unsubscribe · OpenDash" };
export const dynamic = "force-dynamic";

/**
 * An email's unsubscribe link. Opening it only asks; the button takes the person off the routine that sent it,
 * without signing in (the link's signed token is the permission). Sign-in links and invitations aren't affected.
 */
export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string | string[]; done?: string | string[] }>;
}) {
  const params = await searchParams;
  // A repeated parameter is a list: only a single token is one of ours.
  const t = typeof params.t === "string" ? params.t : undefined;
  const done = params.done === "1";
  const target = unsubscribeTarget(t);
  const open = (
    <Link href="/" className="text-link hover:underline">
      Open OpenDash
    </Link>
  );
  if (!target) {
    return (
      <AuthScreen aside={open}>
        <AuthHeading icon={ShieldAlert} title="This link doesn't work">
          Stop an email from its routine instead: Routines → Yours.
        </AuthHeading>
      </AuthScreen>
    );
  }
  const about = await withTenant({ orgId: target.orgId, userId: target.userId }, (tx) =>
    describeUnsubscribe(tx, target),
  );
  if (done || !about.on) {
    return (
      <AuthScreen aside={open}>
        <div className="flex flex-col gap-6">
          <AuthHeading icon={MailCheck} title="You're unsubscribed">
            {`${about.what.charAt(0).toUpperCase()}${about.what.slice(1)} won't come to you any more. See what still does in Routines → Yours.`}
          </AuthHeading>
          <Link href="/routines?tab=yours" className={buttonVariants({ size: "lg", fullWidth: true })}>
            Open your routines
          </Link>
        </div>
      </AuthScreen>
    );
  }
  return (
    <AuthScreen aside={open}>
      <form method="post" action="/api/unsubscribe" className="flex flex-col gap-6">
        <AuthHeading icon={MailX} title="Stop these emails?">
          {`You'd stop getting ${about.what}.`}
        </AuthHeading>
        <input type="hidden" name="t" value={t} />
        <input type="hidden" name="from" value="page" />
        <button type="submit" className={buttonVariants({ size: "lg", fullWidth: true })}>
          Unsubscribe
        </button>
        <p className="text-small text-muted-tertiary">
          Other emails from OpenDash (sign-in links, invitations) aren't affected.
        </p>
      </form>
    </AuthScreen>
  );
}

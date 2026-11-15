import { buttonVariants } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import { ClockAlert, ShieldAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";

export const metadata: Metadata = { title: "Link expired · OpenDash" };

/** and the landing page for any email link that can't be used. */
export default async function LinkExpiredPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  const inviteOnly = error === "REGISTRATION_REQUIRES_INVITATION";
  return (
    <AuthScreen
      aside={
        <Link href={authRoutes.signIn} className="text-link hover:underline">
          Back to sign in
        </Link>
      }
    >
      <div className="flex flex-col gap-6">
        {inviteOnly ? (
          <AuthHeading icon={ShieldAlert} title="This OpenDash is invite-only">
            Ask your admin to invite you, then use the link in that email.
          </AuthHeading>
        ) : (
          <AuthHeading icon={ClockAlert} title="This link has expired">
            Links work for 1 hour, and only once.
          </AuthHeading>
        )}
        {inviteOnly ? null : (
          <Link href={authRoutes.signUp} className={buttonVariants({ size: "lg", fullWidth: true })}>
            Send a new link
          </Link>
        )}
      </div>
    </AuthScreen>
  );
}

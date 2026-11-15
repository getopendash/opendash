import { authRoutes } from "@opendash/auth/routes";
import { ArrowLeft, MailCheck } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { RememberedIt } from "@/components/auth/remembered-it";

export const metadata: Metadata = { title: "Check your email · OpenDash" };

/** The reset link is on its way. Worded so it never confirms whether an account exists. */
export default async function ResetLinkSentPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const { email = "" } = await searchParams;
  return (
    <AuthScreen aside={<RememberedIt />}>
      <div className="flex flex-col gap-6">
        <AuthHeading icon={MailCheck} title="Check your email">
          If an account exists for {email.slice(0, 254) || "that email"}, a reset link is on its way. It works for 1
          hour.
        </AuthHeading>
        <Link href={authRoutes.signIn} className="flex items-center justify-center gap-1.5 text-body hover:underline">
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to sign in
        </Link>
      </div>
    </AuthScreen>
  );
}

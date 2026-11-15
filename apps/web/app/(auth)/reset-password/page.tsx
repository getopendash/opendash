import { buttonVariants } from "@heroui/react";
import { getAuthDatabase, resetPasswordEmail } from "@opendash/auth";
import { authRoutes } from "@opendash/auth/routes";
import { ClockAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { RememberedIt } from "@/components/auth/remembered-it";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export const metadata: Metadata = { title: "Set a new password · OpenDash" };

/** Choosing a new password. Better Auth redirects reset links here with ?token=…, or ?error=INVALID_TOKEN once they've expired. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token = "" } = await searchParams;
  const email = token ? await resetPasswordEmail(getAuthDatabase(), token) : null;
  return (
    <AuthScreen aside={<RememberedIt />}>
      {email ? (
        <ResetPasswordForm token={token} email={email} />
      ) : (
        <div className="flex flex-col gap-6">
          <AuthHeading icon={ClockAlert} title="This reset link has expired">
            Reset links work for 1 hour, and only once.
          </AuthHeading>
          <Link href={authRoutes.forgotPassword} className={buttonVariants({ size: "lg", fullWidth: true })}>
            Send a new link
          </Link>
        </div>
      )}
    </AuthScreen>
  );
}

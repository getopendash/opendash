import { isUuid } from "@opendash/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthScreen } from "@/components/auth/auth-screen";
import { SetPasswordForm } from "@/components/auth/set-password-form";
import { currentViewer, nextStep } from "@/lib/auth";

export const metadata: Metadata = { title: "Choose a password · OpenDash" };

export default async function SetPasswordPage({ searchParams }: { searchParams: Promise<{ invitation?: string }> }) {
  const viewer = await currentViewer();
  if (viewer.kind !== "needs-password") redirect(nextStep(viewer) ?? "/");
  const { invitation } = await searchParams;
  return (
    <AuthScreen>
      <SetPasswordForm email={viewer.user.email} invitationId={invitation && isUuid(invitation) ? invitation : null} />
    </AuthScreen>
  );
}

import { getAuthDatabase, invitationPreview } from "@opendash/auth";
import { authRoutes } from "@opendash/auth/routes";
import { ClockAlert } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { InvitationResponse, InvitationWrongAccount } from "@/components/auth/invitation-response";
import { InvitationSignUpForm } from "@/components/auth/invitation-sign-up-form";
import { OrgCard } from "@/components/auth/org-card";
import { SignedInAs } from "@/components/auth/signed-in-as";
import { authSettings, currentViewer } from "@/lib/auth";

export const metadata: Metadata = { title: "Invitation · OpenDash" };

/** An invitation: signed in as the invitee, signed in as someone else, or signed out. */
export default async function InvitationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [invitation, viewer, settings] = await Promise.all([
    invitationPreview(getAuthDatabase(), id),
    currentViewer(),
    authSettings(),
  ]);
  const signedIn = viewer.kind !== "signed-out";
  const aside = signedIn ? (
    <SignedInAs email={viewer.user.email} />
  ) : (
    <>
      Already have an account?{" "}
      <Link
        href={`${authRoutes.signIn}?next=${encodeURIComponent(authRoutes.invitation(id))}`}
        className="text-link hover:underline"
      >
        Sign in
      </Link>
    </>
  );

  if (!invitation) {
    return (
      <AuthScreen aside={aside}>
        <AuthHeading icon={ClockAlert} title="This invitation is no longer valid">
          It may have expired or been used. Ask the person who invited you to send a new one.
        </AuthHeading>
      </AuthScreen>
    );
  }

  const { organization, inviter } = invitation;
  const sameAccount = signedIn && viewer.user.email.toLowerCase() === invitation.email.toLowerCase();
  return (
    <AuthScreen aside={aside}>
      <div className="flex flex-col gap-6">
        <AuthHeading title={`Join ${organization.name} on OpenDash`}>
          {signedIn && sameAccount
            ? `${inviter.name} (${inviter.email}) invited you to the ${organization.name} organization.`
            : `${inviter.name} invited you to ${organization.name}.`}
        </AuthHeading>
        {!signedIn || sameAccount ? <OrgCard invitation={invitation} host={settings.host} /> : null}
        {!signedIn ? (
          <InvitationSignUpForm invitationId={invitation.id} email={invitation.email} />
        ) : sameAccount ? (
          <InvitationResponse invitationId={invitation.id} />
        ) : (
          <InvitationWrongAccount
            invitationId={invitation.id}
            invitedEmail={invitation.email}
            currentEmail={viewer.user.email}
          />
        )}
      </div>
    </AuthScreen>
  );
}

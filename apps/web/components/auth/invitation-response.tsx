"use client";

import { Alert, Button } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import { ArrowLeft, UserRoundX } from "lucide-react";
import Link from "next/link";
import { useActionState } from "react";
import { type FormState, respondToInvitation } from "@/app/(auth)/actions";
import { signOutTo } from "@/lib/sign-out";

/** Accept or decline, as the account the invitation is for. */
export function InvitationResponse({ invitationId }: { invitationId: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(respondToInvitation, { error: null });
  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="invitation" value={invitationId} />
      {state.error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{state.error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Button type="submit" name="response" value="accept" size="lg" isPending={pending} fullWidth>
        Accept and continue
      </Button>
      <Button type="submit" name="response" value="decline" size="lg" variant="ghost" isDisabled={pending} fullWidth>
        Decline
      </Button>
    </form>
  );
}

/** Signed in as someone else. Switching signs out and comes back to the invitation. */
export function InvitationWrongAccount({
  invitationId,
  invitedEmail,
  currentEmail,
}: {
  invitationId: string;
  invitedEmail: string;
  currentEmail: string;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Alert status="accent">
        <Alert.Indicator>
          <UserRoundX />
        </Alert.Indicator>
        <Alert.Content>
          <Alert.Title>This invitation is for {invitedEmail}</Alert.Title>
          <Alert.Description>You're signed in as {currentEmail}. Switch accounts to accept it.</Alert.Description>
        </Alert.Content>
      </Alert>
      <div className="flex flex-col gap-3">
        <Button
          size="lg"
          fullWidth
          onPress={() =>
            signOutTo(`${authRoutes.signIn}?next=${encodeURIComponent(authRoutes.invitation(invitationId))}`)
          }
        >
          Switch account
        </Button>
        <Link href="/" className="flex items-center justify-center gap-1.5 text-body hover:underline">
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to OpenDash
        </Link>
      </div>
    </div>
  );
}

"use client";

import { Alert, Button } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import Link from "next/link";
import { useActionState } from "react";
import { choosePassword, type FormState } from "@/app/(auth)/actions";
import { AuthHeading } from "./auth-heading";
import { PasswordField } from "./password-field";

/** The first password, chosen after the email link proved the address. */
export function SetPasswordForm({ email, invitationId }: { email: string; invitationId: string | null }) {
  const [state, action, pending] = useActionState<FormState, FormData>(choosePassword, { error: null });
  return (
    <div className="flex flex-col gap-6">
      <AuthHeading title="Choose a password">
        {email} is confirmed. Choose a password to finish setting up your account.
      </AuthHeading>
      {state.error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {state.error}{" "}
              {state.expired ? (
                <Link href={authRoutes.signUp} className="text-link hover:underline">
                  Request a new link
                </Link>
              ) : null}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <form action={action} className="auth-form flex flex-col gap-4">
        {invitationId ? <input type="hidden" name="invitation" value={invitationId} /> : null}
        <PasswordField autoComplete="new-password" description="At least 10 characters." autoFocus />
        <Button type="submit" size="lg" isPending={pending} fullWidth className="mt-2">
          Continue
        </Button>
      </form>
    </div>
  );
}

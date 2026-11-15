"use client";

import { Alert, Button } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { authRoutes } from "@opendash/auth/routes";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthHeading } from "./auth-heading";
import { PasswordField } from "./password-field";

/** A new password. Resetting signs the account out everywhere (revokeSessionsOnPasswordReset). */
export function ResetPasswordForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [mismatch, setMismatch] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const newPassword = String(form.get("password") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) {
      setMismatch(true);
      return;
    }
    setMismatch(false);
    setError(null);
    setPending(true);
    const result = await authClient.resetPassword({ newPassword, token });
    setPending(false);
    if (result.error) {
      setError(
        result.error.code === "INVALID_TOKEN"
          ? "This reset link has expired. Ask for a new one."
          : "We couldn't update your password. Try again.",
      );
      return;
    }
    router.push(`${authRoutes.signIn}?reset=1`);
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading title="Set a new password">For {email}. You'll be signed out on your other devices.</AuthHeading>
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <form className="auth-form flex flex-col gap-4" onSubmit={onSubmit}>
        {/* The mismatch marks the field invalid, which stops the form submitting again: typing clears it. */}
        <PasswordField
          label="New password"
          autoComplete="new-password"
          description="At least 10 characters."
          autoFocus
          onChange={() => setMismatch(false)}
        />
        <PasswordField
          name="confirm"
          label="Confirm password"
          autoComplete="new-password"
          error={mismatch ? "The passwords don't match." : null}
          onChange={() => setMismatch(false)}
        />
        <Button type="submit" size="lg" isPending={pending} fullWidth className="mt-2">
          Update password
        </Button>
      </form>
    </div>
  );
}

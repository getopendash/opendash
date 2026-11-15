"use client";

import { Button, Input, Label, TextField } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { authRoutes } from "@opendash/auth/routes";
import { ArrowLeft, KeySquare } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthHeading } from "./auth-heading";

/** Forgot password. The response never says whether an account exists; the next page says "if an account exists". */
export function ForgotPasswordForm() {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    const email = String(new FormData(event.currentTarget).get("email") ?? "").trim();
    await authClient.requestPasswordReset({ email, redirectTo: authRoutes.resetPassword });
    router.push(`${authRoutes.forgotPassword}/sent?email=${encodeURIComponent(email)}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading icon={KeySquare} title="Reset your password">
        Enter the email you sign in with. We'll send you a link to set a new password.
      </AuthHeading>
      <form className="auth-form flex flex-col gap-4" onSubmit={onSubmit}>
        <TextField name="email" type="email" autoComplete="email" autoFocus>
          <Label>Email</Label>
          <Input placeholder="you@company.com" required />
        </TextField>
        <Button type="submit" size="lg" isPending={pending} fullWidth className="mt-2">
          Send reset link
        </Button>
        <Link href={authRoutes.signIn} className="flex items-center justify-center gap-1.5 text-body hover:underline">
          <ArrowLeft className="size-3.5" aria-hidden />
          Back to sign in
        </Link>
      </form>
    </div>
  );
}

"use client";

import { Button, Description, Input, InputGroup, Label, TextField } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import { Lock } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { sendEmailLink } from "./email-link";

/** Someone signed out opens an invitation. The email comes from the invitation and can't be changed. */
export function InvitationSignUpForm({ invitationId, email }: { invitationId: string; email: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    await sendEmailLink({
      email,
      name: String(new FormData(event.currentTarget).get("name") ?? "").trim(),
      // Someone who already has an account signs in and lands back here to accept. A new account chooses a
      // password and joins straight away, since pressing Continue here already said yes.
      callbackURL: authRoutes.invitation(invitationId),
      newUserCallbackURL: `${authRoutes.setPassword}?invitation=${invitationId}`,
    });
    router.push(`${authRoutes.checkEmail}?email=${encodeURIComponent(email)}`);
  }

  return (
    <form className="auth-form flex flex-col gap-4" onSubmit={onSubmit}>
      <TextField name="name" autoComplete="name" autoFocus>
        <Label>Full name</Label>
        <Input placeholder="Maya Chen" required />
      </TextField>
      <TextField value={email} isReadOnly>
        <Label>Work email</Label>
        <InputGroup variant="secondary">
          <InputGroup.Input />
          <InputGroup.Suffix>
            <Lock className="size-3.5 text-muted" aria-hidden />
          </InputGroup.Suffix>
        </InputGroup>
        <Description>From your invitation. You can't change it here.</Description>
      </TextField>
      <Button type="submit" size="lg" isPending={pending} fullWidth className="mt-2">
        Continue
      </Button>
    </form>
  );
}

"use client";

import { Alert, Button, Input, Label, TextField } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthHeading } from "./auth-heading";
import { sendEmailLink } from "./email-link";

/** Sign-up: name and work email only. The password is chosen after the emailed link is opened. */
export function SignUpForm({ legal }: { legal: { label: string; href: string }[] }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const terms = legal.filter((l) => l.label !== "Security");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const result = await sendEmailLink({
      email,
      name: String(form.get("name") ?? "").trim(),
      callbackURL: "/",
      newUserCallbackURL: authRoutes.setPassword,
    });
    setPending(false);
    if (result.error) {
      setError(
        result.error.status === 429
          ? "Too many requests. Wait a minute, then try again."
          : "Something went wrong. Try again.",
      );
      return;
    }
    router.push(`${authRoutes.checkEmail}?email=${encodeURIComponent(email)}`);
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading title="Create your account">
        Start with your work email. We'll send a link to confirm it, then you'll choose a password.
      </AuthHeading>
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <form className="auth-form flex flex-col gap-4" onSubmit={onSubmit}>
        <TextField name="name" autoComplete="name" autoFocus>
          <Label>Full name</Label>
          <Input placeholder="Maya Chen" required />
        </TextField>
        <TextField name="email" type="email" autoComplete="email">
          <Label>Work email</Label>
          <Input placeholder="you@company.com" required />
        </TextField>
        <Button type="submit" size="lg" isPending={pending} fullWidth className="mt-2">
          Continue
        </Button>
        {terms.length ? (
          <p className="text-center text-small text-muted">
            By continuing you agree to the{" "}
            {terms.map((l, i) => (
              <span key={l.label}>
                {i > 0 ? " and " : null}
                <a href={l.href} className="text-link hover:underline">
                  {l.label === "Privacy" ? "Privacy Policy" : l.label}
                </a>
              </span>
            ))}
          </p>
        ) : null}
      </form>
    </div>
  );
}

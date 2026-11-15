"use client";

import { Alert, Button, Input, Label, TextField } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { authRoutes } from "@opendash/auth/routes";
import { KeyRound, Mail } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { discoverSso } from "@/app/(auth)/actions";
import { startSsoSignIn } from "@/components/sso/start-sign-in";
import { AuthHeading } from "./auth-heading";
import { formatCooldown, sendEmailLink, useCooldown } from "./email-link";
import { PasswordField } from "./password-field";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sign in, with its wrong-password and email-not-confirmed states, and a paused state when an account
 * has seen too many attempts: password sign-in waits, and an email link still gets the owner in. Email first for
 * single sign-on: when the address's domain has an identity provider, "Continue with single sign-on" comes first, and
 * is the only way in when the company requires it.
 */
export function SignInForm({
  next,
  passwordReset,
  ssoError,
}: {
  next: string;
  passwordReset: boolean;
  /** Back from an identity provider without signing in: why, in a sentence. */
  ssoError?: string | null;
}) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [sso, setSso] = useState<{ email: string; enforced: boolean } | null>(null);
  const [error, setError] = useState<string | null>(ssoError ?? null);
  const [linkSent, setLinkSent] = useState<{ email: string; title: string } | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const cooldown = useCooldown();

  const linkFor = (email: string) =>
    sendEmailLink({ email, callbackURL: next, newUserCallbackURL: authRoutes.setPassword });

  // Which way in this address has, once it looks like one (a moment after typing stops).
  useEffect(() => {
    const value = email.trim().toLowerCase();
    if (!EMAIL.test(value)) {
      setSso(null);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      discoverSso(value)
        .then((found) => live && setSso(found.sso ? { email: value, enforced: found.enforced } : null))
        .catch(() => live && setSso(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [email]);
  const required = Boolean(sso?.enforced && sso.email === email.trim().toLowerCase());
  const continueWithSso = async () => {
    setError(null);
    setPending(true);
    const r = await startSsoSignIn({ email: email.trim(), next });
    if (r) {
      setPending(false);
      setError(r.message);
    }
  };

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPaused(null);
    setPending(true);
    if (required) return void continueWithSso();
    const form = new FormData(event.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const result = await authClient.signIn.email({ email, password });
    if (result.error) {
      setPending(false);
      if (result.error.code === "SSO_REQUIRED") {
        setSso({ email: email.toLowerCase(), enforced: true });
        setError("Your company requires single sign-on for this address.");
        return;
      }
      if (result.error.code === "EMAIL_NOT_VERIFIED") {
        // Older accounts that never confirmed their email get an email link, which also drops any password set
        // before the address was proven.
        await linkFor(email);
        cooldown.restart();
        setLinkSent({ email, title: "Confirm your email first" });
        return;
      }
      if (result.error.status === 429) {
        setPaused(email);
        return;
      }
      setError("Email or password is incorrect.");
      return;
    }
    // Two-factor sign-in: the password was right, and the code comes next.
    if (result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect) {
      router.push(`${authRoutes.twoFactor}?next=${encodeURIComponent(next)}`);
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading title="Sign in to OpenDash">Welcome back. Use your work account to continue.</AuthHeading>
      {passwordReset && !error && !linkSent && !paused ? (
        <Alert status="success">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>Your password is updated. Sign in with the new one.</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {paused ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>Too many attempts</Alert.Title>
            <Alert.Description>
              Password sign-in is paused for a few minutes. You can sign in with an email link instead.{" "}
              <button
                type="button"
                className="cursor-pointer text-link hover:underline"
                onClick={async () => {
                  const email = paused;
                  setPaused(null);
                  await linkFor(email);
                  cooldown.restart();
                  setLinkSent({ email, title: "Check your email" });
                }}
              >
                Email me a sign-in link
              </button>
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {linkSent ? (
        <Alert status="accent">
          <Alert.Indicator>
            <Mail />
          </Alert.Indicator>
          <Alert.Content>
            <Alert.Title>{linkSent.title}</Alert.Title>
            <Alert.Description>
              We've sent a sign-in link to {linkSent.email}.{" "}
              {cooldown.left > 0 ? (
                <span className="text-muted">Didn't get it? Resend in {formatCooldown(cooldown.left)}</span>
              ) : (
                <button
                  type="button"
                  className="cursor-pointer text-link hover:underline"
                  onClick={async () => {
                    await linkFor(linkSent.email);
                    cooldown.restart();
                  }}
                >
                  Resend
                </button>
              )}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {error ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <form className="auth-form flex flex-col gap-4" onSubmit={onSubmit}>
        <TextField name="email" type="email" autoComplete="email" autoFocus value={email} onChange={setEmail}>
          <Label>Email</Label>
          <Input placeholder="you@company.com" required />
        </TextField>
        {sso ? (
          <>
            {required ? (
              <p className="text-body text-muted">
                {sso.email.split("@")[1]} signs in through single sign-on. Your company requires it.
              </p>
            ) : null}
            <Button
              type={required ? "submit" : "button"}
              size="lg"
              isPending={pending && required}
              fullWidth
              onPress={required ? undefined : () => void continueWithSso()}
            >
              <KeyRound className="size-4" aria-hidden />
              Continue with single sign-on
            </Button>
            {required ? null : <p className="text-center text-small text-muted-tertiary">or use your password</p>}
          </>
        ) : null}
        {required ? null : (
          <>
            <div className="relative">
              <PasswordField autoComplete="current-password" />
              <Link
                href={authRoutes.forgotPassword}
                className="absolute top-0 right-0 text-small text-link hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Button
              type="submit"
              size="lg"
              variant={sso ? "outline" : "primary"}
              isPending={pending}
              fullWidth
              className="mt-2"
            >
              Sign in
            </Button>
          </>
        )}
        {linkSent ? (
          <button
            type="button"
            className="cursor-pointer self-center text-body text-link hover:underline"
            onClick={(e) => {
              e.currentTarget.form?.reset();
              setLinkSent(null);
            }}
          >
            Use a different account
          </button>
        ) : null}
      </form>
    </div>
  );
}

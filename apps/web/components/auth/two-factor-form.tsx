"use client";

import { Alert, Button, Checkbox, Input, InputOTP, Label, TextField } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { authRoutes } from "@opendash/auth/routes";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { AuthHeading } from "./auth-heading";

/** A backup code as it's stored (two-factor.ts makes them): lowercase, five and five, with the dash. */
function backupCodeOf(typed: string): string {
  const plain = typed.toLowerCase().replace(/[^a-z0-9]/g, "");
  return plain.length === 10 ? `${plain.slice(0, 5)}-${plain.slice(5)}` : typed.trim();
}

/** What each refusal means for the person, by Better Auth's code (and the per-IP limit's 429). */
function problemOf(code: string | undefined, status?: number): { message: string; restart: boolean } {
  if (status === 429)
    return { message: "Too many tries in a row: wait a few seconds, then try again.", restart: false };
  if (code === "INVALID_TWO_FACTOR_COOKIE") return { message: "This sign-in timed out.", restart: true };
  if (code === "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE")
    return { message: "Too many tries for this sign-in.", restart: true };
  if (code === "ACCOUNT_TEMPORARILY_LOCKED") {
    return { message: "Too many wrong codes: signing in is paused for 15 minutes.", restart: false };
  }
  return { message: "That code isn't right.", restart: false };
}

/** Two-factor sign-in: the code from the authenticator app, or a backup code, after the password or an email link. */
export function TwoFactorForm({ next }: { next: string }) {
  const router = useRouter();
  const [backup, setBackup] = useState(false);
  const [code, setCode] = useState("");
  const [trust, setTrust] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ message: string; restart: boolean } | null>(null);

  async function onSubmit(event?: FormEvent) {
    event?.preventDefault();
    const value = code.trim();
    if (!value || (!backup && value.length !== 6)) return;
    setPending(true);
    setProblem(null);
    const { error } = backup
      ? await authClient.twoFactor.verifyBackupCode({ code: backupCodeOf(value), trustDevice: trust })
      : await authClient.twoFactor.verifyTotp({ code: value, trustDevice: trust });
    if (error) {
      setPending(false);
      setCode("");
      setProblem(problemOf(error.code, error.status));
      return;
    }
    router.push(next);
    router.refresh();
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <AuthHeading icon={ShieldCheck} title={backup ? "Use a backup code" : "Two-factor authentication"}>
        {backup
          ? "Enter one of the backup codes you saved when you turned on two-factor sign-in. Each works once."
          : "Enter the 6-digit code from your authenticator app."}
      </AuthHeading>
      {problem ? (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>
              {problem.message}{" "}
              {problem.restart ? (
                <Link href={`${authRoutes.signIn}?next=${encodeURIComponent(next)}`} className="text-link underline">
                  Sign in again
                </Link>
              ) : null}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {backup ? (
        <TextField value={code} onChange={setCode} className="flex flex-col gap-1.5" autoFocus>
          <Label>Backup code</Label>
          <Input autoComplete="one-time-code" spellCheck={false} />
        </TextField>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span id="authentication-code" className="text-body font-medium">
            Authentication code
          </span>
          <InputOTP
            aria-labelledby="authentication-code"
            maxLength={6}
            inputMode="numeric"
            value={code}
            onChange={setCode}
            onComplete={() => onSubmit()}
            autoFocus
          >
            <InputOTP.Group>
              {[0, 1, 2].map((i) => (
                <InputOTP.Slot key={i} index={i} />
              ))}
            </InputOTP.Group>
            <InputOTP.Separator />
            <InputOTP.Group>
              {[3, 4, 5].map((i) => (
                <InputOTP.Slot key={i} index={i} />
              ))}
            </InputOTP.Group>
          </InputOTP>
        </div>
      )}
      <Checkbox isSelected={trust} onChange={setTrust}>
        <Checkbox.Content>
          <Checkbox.Control>
            <Checkbox.Indicator />
          </Checkbox.Control>
          Trust this device for 30 days
        </Checkbox.Content>
      </Checkbox>
      <Button type="submit" size="lg" fullWidth isPending={pending} isDisabled={!code.trim()}>
        Verify
      </Button>
      <button
        type="button"
        className="cursor-pointer text-center text-body text-link hover:underline"
        onClick={() => {
          setBackup(!backup);
          setCode("");
          setProblem(null);
        }}
      >
        {backup ? "Use a code from your app instead" : "Use a backup code instead"}
      </button>
    </form>
  );
}

"use client";

import { Button, Chip, InputOTP, Modal, toast } from "@heroui/react";
import { authClient } from "@opendash/auth/client";
import { CodeBlock } from "@opendash/ui";
import { ShieldCheck } from "lucide-react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { PasswordField } from "@/components/auth/password-field";
import { QrCode } from "./qr-code";

type Step =
  | { kind: "password"; then: "on" | "off" | "codes" }
  | { kind: "scan"; uri: string; codes: string[] }
  | { kind: "codes"; codes: string[] };

/** The key inside the QR code, in groups of four, for apps that can't scan. */
const keyOf = (uri: string) => (new URL(uri).searchParams.get("secret") ?? "").replace(/(.{4})/g, "$1 ").trim();

const WRONG_PASSWORD = "That password isn't right.";
const TOO_FAST = "Too many tries in a row: wait a few seconds, then try again.";
/** Better Auth's per-IP limit answers 429; anything else here is a wrong password or code. */
const refusal = (error: { status?: number } | null, wrong: string) => (error?.status === 429 ? TOO_FAST : wrong);
const WRONG_CODE = "That code isn't right. Check the time on your phone is set automatically, then try the next code.";

/**
 * Two-factor sign-in on the person's own Security page. Turning it on: their password, the QR code and a code from
 * the app to confirm it, then the backup codes, shown once; their other sessions are signed out. Turning it off and
 * making new backup codes ask for the password too.
 */
export function TwoFactorCard({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [step, setStep] = useState<Step | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const open = (then: "on" | "off" | "codes") => {
    setPassword("");
    setCode("");
    setProblem(null);
    setStep({ kind: "password", then });
  };
  const close = () => {
    const finished = step?.kind === "codes";
    setStep(null);
    if (finished) router.refresh();
  };

  async function withPassword(event: FormEvent) {
    event.preventDefault();
    if (step?.kind !== "password") return;
    setPending(true);
    setProblem(null);
    if (step.then === "on") {
      const { data, error } = await authClient.twoFactor.enable({ password });
      setPending(false);
      if (error || !data || !("totpURI" in data) || !data.totpURI) return setProblem(refusal(error, WRONG_PASSWORD));
      setStep({ kind: "scan", uri: data.totpURI, codes: data.backupCodes ?? [] });
    } else if (step.then === "off") {
      const { error } = await authClient.twoFactor.disable({ password });
      setPending(false);
      if (error) return setProblem(refusal(error, WRONG_PASSWORD));
      setStep(null);
      toast.success("Two-factor sign-in is off.");
      router.refresh();
    } else {
      const { data, error } = await authClient.twoFactor.generateBackupCodes({ password });
      setPending(false);
      if (error || !data) return setProblem(refusal(error, WRONG_PASSWORD));
      setStep({ kind: "codes", codes: data.backupCodes });
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (step?.kind !== "scan" || code.length !== 6) return;
    setPending(true);
    setProblem(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code });
    if (error) {
      setPending(false);
      setCode("");
      return setProblem(refusal(error, WRONG_CODE));
    }
    // Any other session (someone else's, perhaps) doesn't outlive the change.
    await authClient.revokeOtherSessions();
    setPending(false);
    setStep({ kind: "codes", codes: step.codes });
  }

  const title =
    step?.kind === "scan"
      ? "Scan this with your authenticator app"
      : step?.kind === "codes"
        ? "Save your backup codes"
        : step?.then === "off"
          ? "Turn off two-factor sign-in"
          : step?.then === "codes"
            ? "Make new backup codes"
            : "Turn on two-factor sign-in";

  return (
    <section
      aria-labelledby="two-factor-title"
      className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-2xl border border-border px-5 py-4"
    >
      <ShieldCheck className="size-5 shrink-0 text-muted" aria-hidden />
      <div className="flex min-w-64 flex-1 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 id="two-factor-title" className="text-body font-medium">
            Two-factor sign-in
          </h2>
          <Chip size="sm" variant="soft" color={enabled ? "success" : "default"}>
            {enabled ? "On" : "Off"}
          </Chip>
        </div>
        <p className="text-small text-muted">
          {enabled
            ? "OpenDash asks for a code from your authenticator app after your password or an email link. Make new backup codes if you've used or lost yours; the old ones stop working."
            : "After your password or an email link, OpenDash asks for a code from an authenticator app (1Password, Google Authenticator, Authy…), so a stolen password isn't enough."}
        </p>
      </div>
      {enabled ? (
        <div className="flex items-center gap-2">
          <Button size="sm" variant="secondary" onPress={() => open("codes")}>
            New backup codes
          </Button>
          <Button size="sm" variant="danger-soft" onPress={() => open("off")}>
            Turn off
          </Button>
        </div>
      ) : (
        <Button size="sm" onPress={() => open("on")}>
          Turn on
        </Button>
      )}

      <Modal>
        <Modal.Backdrop isOpen={step !== null} onOpenChange={(isOpen) => (isOpen ? null : close())}>
          <Modal.Container size="md">
            <Modal.Dialog>
              <Modal.Header className="flex flex-col gap-1">
                <Modal.Heading>{title}</Modal.Heading>
                <p className="text-body text-muted">
                  {step?.kind === "scan"
                    ? "1Password, Google Authenticator, Authy or any app that shows six-digit codes."
                    : step?.kind === "codes"
                      ? "If you can't use your app, each of these signs you in once. Keep them somewhere safe: you won't see them again."
                      : "First, your password."}
                </p>
              </Modal.Header>
              {step?.kind === "password" ? (
                <form onSubmit={withPassword}>
                  <Modal.Body className="flex flex-col gap-3">
                    <PasswordField
                      value={password}
                      onChange={(value) => {
                        // The error marks the field invalid, which stops the form submitting: retyping clears it.
                        setPassword(value);
                        setProblem(null);
                      }}
                      autoFocus
                      error={problem}
                    />
                  </Modal.Body>
                  <Modal.Footer className="flex justify-end gap-2">
                    <Button variant="ghost" slot="close">
                      Cancel
                    </Button>
                    <Button
                      type="submit"
                      isPending={pending}
                      isDisabled={!password}
                      variant={step.then === "off" ? "danger" : "primary"}
                    >
                      {step.then === "off" ? "Turn off" : "Continue"}
                    </Button>
                  </Modal.Footer>
                </form>
              ) : null}
              {step?.kind === "scan" ? (
                <form onSubmit={confirm}>
                  <Modal.Body className="flex flex-col gap-4">
                    <div className="flex flex-wrap items-center gap-4">
                      <QrCode
                        value={step.uri}
                        label="QR code for your authenticator app"
                        className="size-36 shrink-0 rounded-xl border border-border p-1"
                      />
                      <div className="flex min-w-48 flex-1 flex-col gap-1.5">
                        <span className="text-small text-muted">Can't scan it? Enter this key:</span>
                        <CodeBlock code={keyOf(step.uri)} label="Copy key" wrap />
                      </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <span id="confirm-code" className="text-body font-medium">
                        Code from the app
                      </span>
                      <InputOTP
                        aria-labelledby="confirm-code"
                        maxLength={6}
                        inputMode="numeric"
                        value={code}
                        onChange={setCode}
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
                      {problem ? <p className="text-small text-danger">{problem}</p> : null}
                    </div>
                  </Modal.Body>
                  <Modal.Footer className="flex justify-end gap-2">
                    <Button variant="ghost" slot="close">
                      Cancel
                    </Button>
                    <Button type="submit" isPending={pending} isDisabled={code.length !== 6}>
                      Turn on
                    </Button>
                  </Modal.Footer>
                </form>
              ) : null}
              {step?.kind === "codes" ? (
                <>
                  <Modal.Body className="flex flex-col gap-3">
                    <ul className="grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-xl border border-border bg-surface-secondary px-4 py-3 font-mono text-body">
                      {step.codes.map((c) => (
                        <li key={c}>{c}</li>
                      ))}
                    </ul>
                  </Modal.Body>
                  <Modal.Footer className="flex justify-end gap-2">
                    <Button
                      variant="secondary"
                      onPress={async () => {
                        try {
                          await navigator.clipboard.writeText(step.codes.join("\n"));
                          toast.success("Copied the backup codes.");
                        } catch {
                          toast.danger("Couldn't copy them: select the codes and copy them yourself.");
                        }
                      }}
                    >
                      Copy codes
                    </Button>
                    <Button slot="close">Done</Button>
                  </Modal.Footer>
                </>
              ) : null}
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </section>
  );
}

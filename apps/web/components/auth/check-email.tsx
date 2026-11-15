"use client";

import { buttonVariants } from "@heroui/react";
import { authRoutes } from "@opendash/auth/routes";
import { EnvelopeSimple, GoogleLogo } from "@opendash/ui";
import { Mail } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { AuthHeading } from "./auth-heading";
import { formatCooldown, lastLinkRequest, sendEmailLink, useCooldown } from "./email-link";

const inboxes = [
  { label: "Open Gmail", href: "https://mail.google.com/mail/u/0/#inbox", icon: GoogleLogo },
  { label: "Open Outlook", href: "https://outlook.office.com/mail/", icon: EnvelopeSimple },
];

/** The link is on its way. Resend after a minute, or start over with another email. */
export function CheckEmail({ email }: { email: string }) {
  const cooldown = useCooldown();
  const [resent, setResent] = useState(false);
  // An invitation fixes the email, so "Use a different email" would lead nowhere useful.
  const [fromInvitation, setFromInvitation] = useState(false);
  useEffect(() => setFromInvitation(lastLinkRequest(email).newUserCallbackURL.includes("invitation=")), [email]);

  return (
    <div className="flex flex-col gap-6">
      <AuthHeading icon={Mail} title="Check your email">
        We sent a link to {email || "your inbox"}. It expires in 1 hour.
      </AuthHeading>
      <div className="flex flex-col gap-2">
        {inboxes.map((inbox) => (
          <a
            key={inbox.label}
            href={inbox.href}
            target="_blank"
            rel="noreferrer"
            className={`${buttonVariants({ variant: "outline", size: "lg", fullWidth: true })} gap-2`}
          >
            <inbox.icon className="size-3.5" />
            {inbox.label}
          </a>
        ))}
      </div>
      <p className="text-center text-small text-muted" aria-live="polite">
        {resent && cooldown.left > 0 ? "Sent again. " : "Didn't get it? "}
        {cooldown.left > 0 ? (
          <>Resend in {formatCooldown(cooldown.left)}</>
        ) : (
          <button
            type="button"
            className="cursor-pointer text-link hover:underline"
            onClick={async () => {
              await sendEmailLink(lastLinkRequest(email));
              setResent(true);
              cooldown.restart();
            }}
          >
            Resend
          </button>
        )}
        {fromInvitation ? null : (
          <>
            {" · "}
            <Link href={authRoutes.signUp} className="text-link hover:underline">
              Use a different email
            </Link>
          </>
        )}
      </p>
    </div>
  );
}

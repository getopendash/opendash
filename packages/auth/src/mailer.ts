import { createHash } from "node:crypto";
import { BUDGETS } from "@opendash/core";
import { type AuthEmailKind, authEmail, type EmailSender, emailSenderFromEnv, isUndeliverable } from "@opendash/email";

/** Outbound auth email: through Resend or an SMTP server, whichever EMAIL_FROM is set up with. */
export interface AuthMail {
  to: string;
  /**
   * sign-up: a link that creates the account (the password is chosen after it's opened).
   * sign-in: the same link sent to someone who already has an account.
   */
  kind: AuthEmailKind;
  url: string;
  context?: { organization?: string; inviter?: string };
}

export interface Mailer {
  send(mail: AuthMail): Promise<void>;
}

/** Development mailer: prints the link. Refuses to run in production, where real mail is required. */
export function consoleMailer(): Mailer {
  return {
    async send(mail) {
      if (process.env.NODE_ENV === "production") throw new Error("No mailer configured for production");
      console.info(JSON.stringify({ msg: "auth mail (development)", to: mail.to, kind: mail.kind, url: mail.url }));
    },
  };
}

/** Test mailer: keeps every message in memory. */
export function memoryMailer(): Mailer & { sent: AuthMail[] } {
  const sent: AuthMail[] = [];
  return {
    sent,
    async send(mail) {
      sent.push(mail);
    },
  };
}

/**
 * Real email: renders the template for the kind and sends it, within the email budget. The idempotency key is
 * derived from the link, so a retried send of the same link is delivered once; a new link (Resend on the
 * check-your-email page) is a new key. Sign-in mail is sent at once rather than through the outbox: a link can't wait
 * for a queue, and someone who gets nothing asks again.
 */
export function emailMailer(sender: EmailSender, options: { host: string }): Mailer {
  return {
    async send(mail) {
      // Reserved test domains (maya@acme.test) would only bounce and hurt the sender's reputation.
      if (isUndeliverable(mail.to)) return;
      const email = authEmail(mail.kind, { to: mail.to, url: mail.url, host: options.host, ...mail.context });
      const key = createHash("sha256").update(`${mail.kind}\n${mail.url}`).digest("hex").slice(0, 40);
      await sender.send(
        { to: mail.to, ...email, tags: { kind: mail.kind } },
        { idempotencyKey: `auth/${key}`, signal: AbortSignal.timeout(BUDGETS.email.sendMs) },
      );
    },
  };
}

/**
 * The mailer for this environment: Resend or SMTP when configured; otherwise the console in development. Production
 * without email refuses to start, because nobody could sign up or reset a password. In development the link is
 * also printed, so the flow can be tested without opening an inbox; production never logs links.
 */
export function defaultMailer(host: string): Mailer {
  const sender = emailSenderFromEnv(process.env, {
    smtpTimeouts: { connectMs: BUDGETS.email.smtpConnectMs, socketMs: BUDGETS.email.smtpSocketMs },
  });
  if (!sender) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("Email isn't configured. Set EMAIL_FROM, and RESEND_API_KEY or SMTP_URL.");
    }
    return consoleMailer();
  }
  const real = emailMailer(sender, { host });
  if (process.env.NODE_ENV === "production") return real;
  const log = consoleMailer();
  return {
    async send(mail) {
      await log.send(mail);
      await real.send(mail);
    },
  };
}

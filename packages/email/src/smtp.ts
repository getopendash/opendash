import { createTransport } from "nodemailer";
import { EmailError, type EmailMessage, type EmailOutcome, type EmailSender, within } from "./resend";

/** What the sender needs from a nodemailer transport; tests pass their own. */
export interface SmtpTransport {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
    headers?: Record<string, string>;
    messageId?: string;
  }): Promise<{ messageId: string }>;
}

/** How long the SMTP server gets: to connect and greet, and between its answers (the caller's time budget). */
export interface SmtpTimeouts {
  connectMs: number;
  socketMs: number;
}

/**
 * The transport for an SMTP URL: smtp://user:pass@host:587 (STARTTLS) or smtps://user:pass@host:465 (TLS from the
 * start). TLS is required by default, since sign-in links travel in these emails; only a URL that says
 * `?requireTLS=false` sends in plain text (a local mail sink, say). With timeouts, a server that stops answering ends
 * the send itself (nodemailer's own are minutes long).
 */
export function smtpTransport(url: string, timeouts?: SmtpTimeouts): SmtpTransport {
  // The URL's own options (its query included) are merged over these.
  return createTransport({
    url,
    requireTLS: true,
    ...(timeouts
      ? {
          connectionTimeout: timeouts.connectMs,
          greetingTimeout: timeouts.connectMs,
          socketTimeout: timeouts.socketMs,
        }
      : {}),
  } as Parameters<typeof createTransport>[0]) as SmtpTransport;
}

/**
 * What an SMTP failure says about the message: a 5xx refused it for good and a 4xx for now; failing while connecting
 * (`CONN`) or signing in, nothing was given to the server. Anything else (a timeout or a broken connection mid-send)
 * may have delivered it.
 */
export function smtpOutcome(e: {
  code?: string | null;
  command?: string | null;
  responseCode?: number | null;
}): EmailOutcome {
  const status = e.responseCode ?? null;
  if (status !== null && status >= 500) return "rejected";
  if (status !== null && status >= 400) return "not_sent";
  if (e.command === "CONN" || e.code === "EAUTH" || e.code === "ENOAUTH") return "not_sent";
  return "unclear";
}

const idPart = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");

/**
 * Sends through an SMTP server, for self-hosting without Resend. SMTP has no idempotency key, so a send that wasn't
 * acknowledged fails `unclear` and isn't sent again by the outbox; the key becomes the Message-ID, so mail clients
 * show any copies as one message. Resend's tags have no SMTP equivalent and are dropped.
 */
export function smtpSender(options: {
  url?: string;
  from: string;
  timeouts?: SmtpTimeouts;
  transport?: SmtpTransport;
}): EmailSender {
  const transport = options.transport ?? smtpTransport(options.url ?? "", options.timeouts);
  const domain = idPart(/@([^>\s]+)/.exec(options.from)?.[1] ?? "opendash");
  return {
    async send(message: EmailMessage, sendOptions) {
      try {
        const info = await within(
          transport.sendMail({
            from: options.from,
            to: message.to,
            subject: message.subject,
            html: message.html,
            text: message.text,
            ...(message.headers ? { headers: message.headers } : {}),
            ...(sendOptions?.idempotencyKey ? { messageId: `<${idPart(sendOptions.idempotencyKey)}@${domain}>` } : {}),
          }),
          sendOptions?.signal,
        );
        return { id: info.messageId };
      } catch (error) {
        if (error instanceof EmailError) throw error;
        const e = error as { message?: string; code?: string; command?: string; responseCode?: number };
        throw new EmailError(
          e.message ?? "The SMTP server refused the message",
          e.code ?? null,
          e.responseCode ?? null,
          smtpOutcome(e),
        );
      }
    },
  };
}

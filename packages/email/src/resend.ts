import { Resend } from "resend";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Resend tags: ASCII letters, numbers, underscores and dashes. */
  tags?: Record<string, string>;
  /** Extra headers (List-Unsubscribe on scheduled email). */
  headers?: Record<string, string>;
}

export interface EmailSender {
  /** Resolves with the provider's message id; rejects with EmailError (code `timeout` when the signal ends it). */
  send(message: EmailMessage, options?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<{ id: string }>;
}

/**
 * What a failed send means for the message: `rejected`, the provider refused it for good; `not_sent`, it never took
 * it (refused for now, or never reached), so sending again is safe; `unclear`, it may have gone (a timeout, a broken
 * connection, a server error), so it mustn't be sent again.
 */
export type EmailOutcome = "rejected" | "not_sent" | "unclear";

export class EmailError extends Error {
  override name = "EmailError";
  constructor(
    message: string,
    readonly code: string | null,
    readonly status: number | null,
    readonly outcome: EmailOutcome = "unclear",
  ) {
    super(message);
  }
}

/**
 * Resend's answer, read for what it says about the message. A 429 took nothing; another 4xx refused it for good,
 * except the idempotency answers, which mean an earlier request with this key was taken or still is. No status (the
 * request failed or was cut off) and 5xx say nothing.
 */
export function resendOutcome(error: { name?: string | null; statusCode?: number | null }): EmailOutcome {
  const status = error.statusCode ?? null;
  if (status === null || status >= 500) return "unclear";
  if (error.name === "invalid_idempotent_request" || error.name === "concurrent_idempotent_requests") return "unclear";
  if (status === 429) return "not_sent";
  return status >= 400 ? "rejected" : "unclear";
}

type ResendEmails = Pick<Resend["emails"], "send">;

/** Sends through Resend. `client` is for tests; production builds one from the API key. */
export function resendSender(options: {
  apiKey?: string;
  from: string;
  client?: { emails: ResendEmails };
}): EmailSender {
  const client = options.client ?? new Resend(options.apiKey);
  return {
    async send(message, sendOptions) {
      const sent = client.emails.send(
        {
          from: options.from,
          to: message.to,
          subject: message.subject,
          html: message.html,
          text: message.text,
          tags: Object.entries(message.tags ?? {}).map(([name, value]) => ({ name, value })),
          ...(message.headers ? { headers: message.headers } : {}),
        },
        {
          ...(sendOptions?.idempotencyKey ? { idempotencyKey: sendOptions.idempotencyKey } : {}),
          // Not in the SDK's types, but its request options reach fetch as they are.
          ...(sendOptions?.signal ? { signal: sendOptions.signal } : {}),
        } as Parameters<ResendEmails["send"]>[1],
      );
      const { data, error } = await within(sent, sendOptions?.signal);
      if (error || !data) {
        throw new EmailError(
          error?.message ?? "Resend returned no message id",
          error?.name ?? null,
          error?.statusCode ?? null,
          error ? resendOutcome(error) : "unclear",
        );
      }
      return { id: data.id };
    },
  };
}

/**
 * The send, or an EmailError once the signal ends it: `unclear`, since the provider may still take it (its own request
 * is cancelled where it can be). The send's own outcome is still observed, so a late failure is never unhandled.
 */
export function within<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  const ended = () => new EmailError("The email provider didn't answer in time.", "timeout", null, "unclear");
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(ended());
  }
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(ended());
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

const RESERVED_TLDS = [".test", ".example", ".invalid", ".localhost"];
const RESERVED_DOMAINS = ["example.com", "example.net", "example.org"];

/**
 * Addresses on domains reserved for testing (RFC 2606, RFC 6761) can never receive mail. Sending to them only
 * bounces, and bounces count against the sending domain's reputation, so mailers skip them.
 */
export function isUndeliverable(address: string): boolean {
  const domain = address.split("@").pop()?.trim().toLowerCase() ?? "";
  return (
    !domain ||
    RESERVED_TLDS.some((tld) => domain.endsWith(tld)) ||
    RESERVED_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`))
  );
}

/**
 * The origin every link in an email points to (BETTER_AUTH_URL, the web app's). In production it must be a bare
 * HTTPS origin, as auth requires, or there's no origin and nothing that needs one is sent; elsewhere it defaults to
 * the local web app.
 */
export function emailLinkOrigin(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.BETTER_AUTH_URL?.trim();
  if (env.NODE_ENV !== "production") return (value || "http://localhost:3000").replace(/\/$/, "");
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value.replace(/\/$/, "") ? url.origin : null;
  } catch {
    return null;
  }
}

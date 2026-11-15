import { type EmailSender, resendSender } from "./resend";
import { type SmtpTimeouts, smtpSender } from "./smtp";

/**
 * The sender this environment configures, from EMAIL_FROM and one of: RESEND_API_KEY (Resend, the cloud's), or
 * SMTP_URL (any SMTP server, for self-hosting). Resend wins when both are set; null when EMAIL_FROM or both are
 * missing. An SMTP server gets the caller's timeouts.
 */
export function emailSenderFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  options: { smtpTimeouts?: SmtpTimeouts } = {},
): EmailSender | null {
  const from = env.EMAIL_FROM?.trim();
  if (!from) return null;
  const apiKey = env.RESEND_API_KEY?.trim();
  if (apiKey) return resendSender({ apiKey, from });
  const url = env.SMTP_URL?.trim();
  return url ? smtpSender({ url, from, ...(options.smtpTimeouts ? { timeouts: options.smtpTimeouts } : {}) }) : null;
}

import { oneLine, type RenderedEmail, renderEmail } from "./layout";

export type AuthEmailKind = "sign-up" | "sign-in" | "reset-password" | "invitation";

export interface AuthEmailData {
  to: string;
  url: string;
  /** This instance's address, so people can tell which OpenDash wrote to them. */
  host: string;
  organization?: string;
  inviter?: string;
}

const LINK_NOTE = "This link works once and expires in 1 hour.";

/** The four emails the auth flows send. Copy matches the check-your-email, reset-sent and invitation pages. */
export function authEmail(kind: AuthEmailKind, data: AuthEmailData): RenderedEmail {
  const footer = `You're getting this because this address was used on OpenDash at ${data.host}. If that wasn't you, you can ignore this email.`;
  switch (kind) {
    case "sign-up":
      return renderEmail({
        subject: "Confirm your email for OpenDash",
        preheader: "Finish creating your OpenDash account. The link works for 1 hour.",
        heading: "Confirm your email",
        paragraphs: [`Confirm ${data.to} to finish creating your OpenDash account. You'll choose a password next.`],
        button: { label: "Confirm email", url: data.url },
        note: LINK_NOTE,
        footer,
      });
    case "sign-in":
      return renderEmail({
        subject: "Sign in to OpenDash",
        preheader: "Your sign-in link. It works for 1 hour.",
        heading: "Sign in to OpenDash",
        paragraphs: [
          `Use the button below to sign in as ${data.to}. You already have an account, so there's nothing to set up.`,
        ],
        button: { label: "Sign in", url: data.url },
        note: LINK_NOTE,
        footer,
      });
    case "reset-password":
      return renderEmail({
        subject: "Reset your OpenDash password",
        preheader: "Choose a new password. The link works for 1 hour.",
        heading: "Reset your password",
        paragraphs: [`Choose a new password for ${data.to}. You'll be signed out on your other devices.`],
        button: { label: "Choose a new password", url: data.url },
        note: "This link expires in 1 hour. If you didn't ask for a reset, your password hasn't changed.",
        footer,
      });
    case "invitation": {
      const organization = oneLine(data.organization || "an organization", 80);
      const inviter = oneLine(data.inviter || "A teammate", 80);
      return renderEmail({
        subject: `${inviter} invited you to ${organization} on OpenDash`,
        preheader: `Join ${organization} on OpenDash.`,
        heading: `Join ${organization} on OpenDash`,
        paragraphs: [`${inviter} invited you to the ${organization} organization on OpenDash.`],
        button: { label: "View invitation", url: data.url },
        note: `This invitation is for ${data.to} and expires in 7 days.`,
        footer,
      });
    }
  }
}

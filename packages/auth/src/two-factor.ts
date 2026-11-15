/**
 * Two-factor sign-in: an authenticator app (TOTP) and backup codes, through
 * Better Auth's plugin.
 *
 * Better Auth asks for the second factor only on password sign-in. OpenDash also signs people in by email link, so
 * the plugin's own challenge runs on that path too: for an account with two-factor, the link's session is discarded,
 * the challenge cookie is set, and the browser goes to the code page instead of where the link pointed. The
 * link proves the inbox, the code the app: still two factors, and an owner whose password sign-in is paused can
 * still get in.
 */
import { randomInt } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { twoFactor } from "better-auth/plugins";
import { authRoutes, safeRedirectPath } from "./routes";

const LINK_PATH = "/magic-link/verify";

/** "Trust this device": skip the code on that browser for 30 days. */
export const TRUST_DEVICE_DAYS = 30;

/** Lowercase letters and digits without look-alikes (i, l, o, 0, 1): codes people type from paper. */
const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Ten backup codes like "k7mq2-xr9dt": 31^10 each, about 50 bits, behind the plugin's per-challenge and lockout limits. */
export function backupCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    const chars = Array.from({ length: 10 }, () => BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)]).join("");
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** The plugin, with its challenge on the email-link path as well as password sign-in. */
export function twoFactorPlugin() {
  const plugin = twoFactor({
    issuer: "OpenDash",
    trustDeviceMaxAge: TRUST_DEVICE_DAYS * 24 * 60 * 60,
    backupCodeOptions: { customBackupCodesGenerate: backupCodes },
  });
  const challenge = plugin.hooks.after[0];
  if (!challenge) throw new Error("Better Auth's two-factor plugin has no sign-in hook: check it after an upgrade.");
  plugin.hooks.after.push({ matcher: (context) => context.path === LINK_PATH, handler: challenge.handler });
  return plugin;
}

const isChallenge = (value: unknown) =>
  typeof value === "object" && value !== null && (value as { twoFactorRedirect?: unknown }).twoFactorRedirect === true;

/**
 * After the challenge on the email-link path: the link is opened by the browser itself, so the plugin's JSON answer
 * becomes a redirect to the code page, carrying where the link was going (when that's a path on this site).
 */
export function twoFactorLinkRedirect(): BetterAuthPlugin {
  return {
    id: "opendash-two-factor-link",
    hooks: {
      after: [
        {
          matcher: (context) => context.path === LINK_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            if (!isChallenge(ctx.context.returned)) return;
            const next = safeRedirectPath(ctx.query?.callbackURL as string | undefined) ?? "/";
            throw ctx.redirect(`${authRoutes.twoFactor}?next=${encodeURIComponent(next)}`);
          }),
        },
      ],
    },
  };
}

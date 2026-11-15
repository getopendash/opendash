/** Web pages the auth server links to from emails and redirects. The web app owns the pages themselves. */
export const authRoutes = {
  signIn: "/sign-in",
  signUp: "/sign-up",
  /** Email links land here first: a button, not the one-time link, so mail scanners can't use it up. */
  continue: "/auth/continue",
  checkEmail: "/check-email",
  setPassword: "/welcome/password",
  linkExpired: "/link-expired",
  forgotPassword: "/forgot-password",
  resetPassword: "/reset-password",
  createOrganization: "/onboarding/organization",
  /** The session's organization isn't the person's any more (removed from it). */
  leftOrganization: "/left-organization",
  invitation: (id: string) => `/invite/${id}`,
  /** The code from the authenticator app (or a backup code), after the password or an email link. */
  twoFactor: "/two-factor",
  /** The person's own security settings (two-factor). */
  security: "/settings/security",
} as const;

/** Better Auth's one-time sign-in endpoint behind every email link (GET, consumed on first use). */
export const magicLinkVerifyPath = "/api/auth/magic-link/verify";

/** How long email links work, in seconds. The check-your-email and expired-link pages tell people "1 hour". */
export const EMAIL_LINK_TTL_SECONDS = 60 * 60;

const PROBE_ORIGIN = "https://opendash.invalid";

/**
 * A same-site path to send someone to after signing in, or null. Parsed the way browsers parse it, so tricks like
 * "//evil.com", "/\\evil.com", "/\t/evil.com" (browsers drop tabs and newlines) or "/.//evil.com" (dot segments
 * collapse to "//evil.com") can't point elsewhere.
 */
export function safeRedirectPath(value: string | string[] | null | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw?.startsWith("/")) return null;
  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Normalising dot segments can itself produce "//host" ("/.//evil.com" → "//evil.com"), so check the result too.
  if (path.startsWith("//") || path.startsWith("/\\") || new URL(path, PROBE_ORIGIN).origin !== PROBE_ORIGIN)
    return null;
  return path;
}

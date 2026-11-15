/**
 * Single sign-on's rules: who may be created, which workspace they land in, and who is
 * refused. Everything reduces to two proofs that are never confused:
 *  - DNS proves the organization may claim a domain. It permits configuration, and nothing else on its own.
 *  - A validated OIDC token or SAML assertion proves the person. Only that, at exactly the provider's verified domain,
 *    creates or links an account, even on an invite-only instance.
 * Pure: the lookups that read the database are in store.ts.
 */

/**
 * The label of the domain's TXT record: `_opendash-verification-<providerId>.<domain>`. It names us (like
 * `_okta-verification`), not the library, since it stays in the customer's DNS zone. The plugin is configured from
 * this one constant and the settings page shows the record built from it, so the two can't disagree.
 */
export const SSO_DNS_TOKEN_PREFIX = "opendash-verification";

/** RFC 1035: one DNS label is at most 63 octets. */
export const DNS_LABEL_MAX = 63;

export const ssoDnsLabel = (providerId: string) => `_${SSO_DNS_TOKEN_PREFIX}-${providerId}`;

/** The longest provider id whose record label still fits in one DNS label (40). */
export const PROVIDER_ID_MAX = DNS_LABEL_MAX - ssoDnsLabel("").length;

export type SsoStatus = "draft" | "verified" | "active" | "disabled";

/** The statuses whose provider signs people in (and may create or link them). */
export const SIGN_IN_STATUSES: readonly SsoStatus[] = ["verified", "active"];

export interface ProviderPolicy {
  providerId: string;
  organizationId: string;
  domain: string;
  domainVerified: boolean;
  status: string;
  enforceSso: boolean;
  updatedAt: Date;
}

/** May this provider sign someone in? The lifecycle in one place. */
export function canSignInThrough<P extends Pick<ProviderPolicy, "domainVerified" | "status">>(
  provider: P | null | undefined,
): provider is P {
  return Boolean(provider?.domainVerified && SIGN_IN_STATUSES.includes(provider.status as SsoStatus));
}

/** One message for every enforcement refusal; the reason is logged and audited. */
export const SSO_REQUIRED_MESSAGE = "Your company requires single sign-on. Continue with your identity provider.";

/** One message for "this provider can't sign anyone in now" (draft, disabled, unverified, unknown), saying none. */
export const SSO_UNAVAILABLE_MESSAGE = "Single sign-on isn't available for this address.";

/**
 * The plugin's routes that consume an identity assertion, as Better Auth names them in hooks (the route pattern, not
 * the request path). The shared `/sso/callback` is disabled over HTTP: every provider uses its own.
 */
const CALLBACK_ROUTES = new Set(["/sso/callback/:providerId", "/sso/saml2/sp/acs/:providerId"]);

export const isSsoCallbackPath = (path: string | undefined): boolean => CALLBACK_ROUTES.has(path ?? "");

/** The provider a callback is for: what the router matched, never parsed out of a path. */
export function callbackProviderId(context: unknown): string | null {
  const ctx = context as { path?: string; params?: Record<string, unknown> } | null | undefined;
  if (!isSsoCallbackPath(ctx?.path)) return null;
  const id = ctx?.params?.providerId;
  return typeof id === "string" && id && !id.startsWith(":") ? id : null;
}

/** Whether a request is for the plugin's own routes (sign-in, callbacks), anchored on the auth base path. */
export function isSsoPluginRequest(request: Pick<Request, "url"> | undefined, basePath = "/api/auth"): boolean {
  if (!request) return false;
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return false;
  }
  return pathname === `${basePath}/sign-in/sso` || pathname.startsWith(`${basePath}/sso/`);
}

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0
    ? ""
    : email
        .slice(at + 1)
        .trim()
        .toLowerCase();
}

export const normalizeDomain = (domain: string) => domain.trim().toLowerCase().replace(/\.$/, "");

/** The sign-in paths that make a session without the identity provider, with the email in their body. */
export const LOCAL_SIGN_IN_PATHS = new Set(["/sign-in/email", "/sign-in/magic-link"]);

/**
 * Paths a refused session may still use: signing in again (that's how it gets a good one), signing out, and the
 * recovery pages. /get-session has its own after-hook. Everything else is an authenticated action it mustn't take.
 */
export function isSessionGuardExempt(path: string | undefined): boolean {
  if (!path) return true;
  return (
    path === "/get-session" ||
    path === "/sign-out" ||
    path === "/ok" ||
    path === "/error" ||
    path.startsWith("/sign-in") ||
    path.startsWith("/magic-link") ||
    path.startsWith("/two-factor/verify") ||
    path === "/request-password-reset" ||
    path.startsWith("/reset-password") ||
    path === "/sso/saml2/sp/metadata" ||
    isSsoCallbackPath(path)
  );
}

export interface SessionProvenance {
  authenticationMethod?: string | null;
  ssoProviderId?: string | null;
  authenticatedAt?: Date | string | null;
}

export type SessionRefusal = "not_sso" | "other_provider" | "provider_inactive" | "too_old";

/**
 * Should a session of someone at an enforced domain be honoured? It must come from the enforcing provider, which must
 * still be active, and the identity provider must have vouched for the person within the age bound.
 */
export function refuseEnforcedSession(
  session: SessionProvenance,
  provider: Pick<ProviderPolicy, "providerId" | "status">,
  now: Date,
  maxAuthAgeHours: number,
): SessionRefusal | null {
  if (session.authenticationMethod !== "sso") return "not_sso";
  if (session.ssoProviderId !== provider.providerId) return "other_provider";
  if (provider.status !== "active") return "provider_inactive";
  const at = session.authenticatedAt ? new Date(session.authenticatedAt) : null;
  if (!at || Number.isNaN(at.getTime())) return "too_old";
  return now.getTime() - at.getTime() > maxAuthAgeHours * 3_600_000 ? "too_old" : null;
}

/** OPENDASH_SSO_MAX_AUTH_AGE_HOURS (default 12): how often people at an enforced domain see their provider. */
export function maxSsoAuthAgeHours(env: Record<string, string | undefined> = process.env): number {
  const raw = env.OPENDASH_SSO_MAX_AUTH_AGE_HOURS?.trim();
  if (!raw) return 12;
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 30) {
    throw new Error("OPENDASH_SSO_MAX_AUTH_AGE_HOURS must be a number of hours between 0 and 720");
  }
  return hours;
}

/**
 * Origins the two largest identity providers serve their endpoints from beside their issuer (Entra's userinfo;
 * Google's token, userinfo and keys). The plugin refuses an endpoint whose origin isn't trusted, which is what stops a
 * hostile discovery document aiming the token-carrying calls elsewhere; these are published, vendor-owned hosts.
 * OPENDASH_SSO_TRUSTED_IDP_ORIGINS adds more (https only in production); it can't remove these.
 */
const WELL_KNOWN_IDP_ORIGINS = [
  "https://graph.microsoft.com",
  "https://oauth2.googleapis.com",
  "https://openidconnect.googleapis.com",
  "https://www.googleapis.com",
];

export function trustedIdpOrigins(
  raw = process.env.OPENDASH_SSO_TRUSTED_IDP_ORIGINS,
  production = process.env.NODE_ENV === "production",
): string[] {
  const extra = (raw ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean)
    .map((value) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        throw new Error(`OPENDASH_SSO_TRUSTED_IDP_ORIGINS: "${value}" isn't a URL`);
      }
      // Outside production an operator may list a local identity provider (a Keycloak on localhost) over http.
      if (url.protocol !== "https:" && (production || url.protocol !== "http:")) {
        throw new Error(`OPENDASH_SSO_TRUSTED_IDP_ORIGINS: "${value}" must be https`);
      }
      return url.origin;
    });
  return [...new Set([...WELL_KNOWN_IDP_ORIGINS, ...extra])];
}

/**
 * What we ask an OIDC provider for. Not `offline_access` (the plugin's default): sessions are ours, and the age bound
 * sends people back to their provider rather than refreshing behind their back. Asking for it anyway shows people in
 * tenants that restrict consent an approval wall for a permission nothing uses.
 */
export const OIDC_SCOPES = ["openid", "email", "profile"];

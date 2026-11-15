/**
 * The lookups single sign-on makes on the request path, as opendash_auth. Enforcement is asked on every authenticated
 * request, so its answer is cached per domain for a short time, one lookup at a time: uncached, it's a query per
 * request from inside a request already holding a pooled connection. The caches are cleared by the changes this
 * process makes (manage.ts); another replica's changes reach it within the TTL, and the changes themselves delete the
 * sessions they refuse, so nothing relies on the cache alone in between.
 */
import type { AuthDatabase } from "@opendash/db/auth";
import { authTables as t } from "@opendash/db/auth";
import { and, eq, inArray } from "drizzle-orm";
import { normalizeDomain, type ProviderPolicy, SIGN_IN_STATUSES } from "./policy";

type Db = AuthDatabase["db"];

const POLICY_COLUMNS = {
  providerId: t.ssoProvider.providerId,
  organizationId: t.ssoProvider.organizationId,
  domain: t.ssoProvider.domain,
  domainVerified: t.ssoProvider.domainVerified,
  status: t.ssoProvider.status,
  enforceSso: t.ssoProvider.enforceSso,
  updatedAt: t.ssoProvider.updatedAt,
};

export async function providerPolicy(db: Db, providerId: string): Promise<ProviderPolicy | null> {
  const [row] = await db.select(POLICY_COLUMNS).from(t.ssoProvider).where(eq(t.ssoProvider.providerId, providerId));
  return row ?? null;
}

/** The provider that signs in people at a domain: verified, and in a status that signs people in. */
export async function signInProviderForDomain(db: Db, domain: string): Promise<ProviderPolicy | null> {
  const rows = await db
    .select(POLICY_COLUMNS)
    .from(t.ssoProvider)
    .where(
      and(
        eq(t.ssoProvider.domain, normalizeDomain(domain)),
        eq(t.ssoProvider.domainVerified, true),
        inArray(t.ssoProvider.status, [...SIGN_IN_STATUSES]),
      ),
    );
  // While a domain moves between providers, the enforcing one (or else the active one) is the one people use.
  return rows.find((r) => r.enforceSso) ?? rows.find((r) => r.status === "active") ?? rows[0] ?? null;
}

const ENFORCED_TTL_MS = 30_000;
const DOMAIN_CACHE_MAX = 10_000;
const enforced = new Map<string, { value: ProviderPolicy | null; expires: number }>();
const enforcedInFlight = new Map<string, Promise<ProviderPolicy | null>>();

/**
 * The provider enforcing a domain, if one is: the CHECK constraint makes enforce_sso imply verified and active, and the
 * unique index makes it one. A failed refresh keeps the last answer, or reports none: one window of failing open
 * rather than taking every request down with the database. Enforcing a domain deletes its other sessions at once, so
 * that window can't bring old sessions back; and a sign-in asks with `fresh` (a sign-in is rare, a session read isn't),
 * so nobody signs in another way after enforcement however stale a replica's cache is. A fresh answer refreshes the
 * cache too.
 */
export function enforcedProviderForDomain(
  db: Db,
  domain: string,
  options: { fresh?: boolean; now?: number } = {},
): Promise<ProviderPolicy | null> {
  const key = normalizeDomain(domain);
  const hit = enforced.get(key);
  if (!options.fresh && hit && hit.expires > (options.now ?? Date.now())) return Promise.resolve(hit.value);
  const load = () =>
    db
      .select(POLICY_COLUMNS)
      .from(t.ssoProvider)
      .where(and(eq(t.ssoProvider.domain, key), eq(t.ssoProvider.enforceSso, true)))
      .limit(1)
      .then(([row]) => {
        if (enforced.size >= DOMAIN_CACHE_MAX) enforced.clear();
        enforced.set(key, { value: row ?? null, expires: Date.now() + ENFORCED_TTL_MS });
        return row ?? null;
      });
  // A sign-in asks the database itself, and a failure refuses it rather than letting it through.
  if (options.fresh) return load();
  let pending = enforcedInFlight.get(key);
  if (!pending) {
    pending = load()
      .catch((error: unknown) => {
        console.error(
          JSON.stringify({ msg: "sso enforcement lookup failed", error: error instanceof Error ? error.message : "" }),
        );
        return hit?.value ?? null;
      })
      .finally(() => enforcedInFlight.delete(key));
    enforcedInFlight.set(key, pending);
  }
  return pending;
}

const ORIGINS_TTL_MS = 60_000;
let origins: { value: string[]; expires: number } | undefined;
let originsInFlight: Promise<string[]> | undefined;

/**
 * The issuer and discovery origins of every provider that signs people in, for the plugin's guard on the OIDC calls
 * it makes (discovery, token, keys): https and public only, the same rule as at registration, restated where the trust
 * is granted. A draft nobody has proved a domain for never widens it. Cached a minute; a failed refresh keeps the last
 * value and never throws, since every request on the SSO paths asks.
 */
export function verifiedProviderOrigins(db: Db, now = Date.now()): Promise<string[]> {
  if (origins && origins.expires > now) return Promise.resolve(origins.value);
  originsInFlight ??= db
    .select({ issuer: t.ssoProvider.issuer })
    .from(t.ssoProvider)
    .where(and(eq(t.ssoProvider.domainVerified, true), inArray(t.ssoProvider.status, [...SIGN_IN_STATUSES])))
    .then((rows) => {
      const set = new Set<string>();
      for (const { issuer } of rows) {
        try {
          const url = new URL(issuer);
          if (url.protocol === "https:") set.add(url.origin);
        } catch {
          // A SAML entity id may be a URN: nothing to trust.
        }
      }
      origins = { value: [...set], expires: Date.now() + ORIGINS_TTL_MS };
      return origins.value;
    })
    .catch(() => origins?.value ?? [])
    .finally(() => {
      originsInFlight = undefined;
    });
  return originsInFlight;
}

/** After this process changes a provider: the next request reads afresh. */
export function forgetProviderCaches(domain?: string): void {
  if (domain) enforced.delete(normalizeDomain(domain));
  else enforced.clear();
  origins = undefined;
}

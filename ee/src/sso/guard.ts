/**
 * Enforcement where sessions are read. Refusing sign-in another way isn't enough on its own: a session made before
 * enforcement was turned on would keep working. So every read that turns a session into a person asks: for someone at
 * an enforced domain, did this session come from the enforcing provider, within the age bound?
 */
import type { AuthDatabase } from "@opendash/db/auth";
import {
  emailDomain,
  maxSsoAuthAgeHours,
  refuseEnforcedSession,
  type SessionProvenance,
  type SessionRefusal,
} from "./policy";
import { enforcedProviderForDomain } from "./store";

export type SessionVerdict = { ok: true } | { ok: false; reason: SessionRefusal; providerId: string };

let maxAge: number | undefined;

/** One indexed (and cached) lookup when the domain isn't enforced. A refusal is a value, so no catch fails open. */
export async function guardEnforcedSession(
  db: AuthDatabase["db"],
  input: { userEmail: string; session: SessionProvenance },
  now = new Date(),
): Promise<SessionVerdict> {
  const domain = emailDomain(input.userEmail);
  if (!domain) return { ok: true };
  const provider = await enforcedProviderForDomain(db, domain);
  if (!provider) return { ok: true };
  maxAge ??= maxSsoAuthAgeHours();
  const reason = refuseEnforcedSession(input.session, provider, now, maxAge);
  return reason ? { ok: false, reason, providerId: provider.providerId } : { ok: true };
}

/** Tests: read OPENDASH_SSO_MAX_AUTH_AGE_HOURS again. */
export function resetSessionGuard(): void {
  maxAge = undefined;
}

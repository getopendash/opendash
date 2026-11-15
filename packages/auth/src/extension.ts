import type { BetterAuthPlugin, DBAdapterInstance } from "better-auth";
import type { AuthAudit } from "./audit";

/**
 * What an enterprise build adds to the auth server: single sign-on and directory sync live in ee/, which the core never
 * imports, so apps/web hands them in through createAuth's `extension`. Every part is optional; without one the server
 * is the community edition's.
 */
export interface AuthExtension {
  /** Better Auth plugins, after the core's own and before the audit log's (so it records what they decided). */
  plugins?: BetterAuthPlugin[];
  /** Endpoints that answer 404 over HTTP and stay callable in process through `auth.api`. */
  disabledPaths?: string[];
  /** Wraps the database adapter, for example to seal secrets before Better Auth writes them. */
  adapter?: (adapter: DBAdapterInstance) => DBAdapterInstance;
  /** Origins trusted for this request on top of the deployment's own. Called on every request: keep it cached. */
  trustedOrigins?: (request: Request | undefined) => Promise<string[]>;
  /**
   * Vouches for a person whose account is about to be created, although registration may be closed (an SSO sign-in
   * at its provider's verified domain). Returns the fields to set on them, or null to leave the decision to the
   * registration rule.
   */
  vouchForNewUser?: (user: { email: string }, context: unknown) => Promise<Record<string, unknown> | null>;
  /**
   * Fields for the session being created (where it came from, its organization), or undefined to leave it as the core
   * makes it. May throw to refuse the session.
   */
  sessionFields?: (session: { userId: string }, context: unknown) => Promise<Record<string, unknown> | undefined>;
  /** Rate limits for its own paths (Better Auth's patterns, `*` a wildcard), applied where limits are on. */
  rateLimitRules?: Record<string, { window: number; max: number }>;
}

/** What the core hands an extension: its pieces the extension may use. */
export interface AuthCore {
  /** The audit log's writer for auth events (as the system role, right after Better Auth's write). */
  audit: AuthAudit;
  /** A key for one purpose, derived from the auth secret (HKDF-SHA-256), so a feature needs no secret of its own. */
  deriveSecret(purpose: string): string;
  /** Ends what a membership gave in the product (routines), after it's gone: what removing a member does. */
  memberRemoved(orgId: string, userId: string): Promise<void>;
}

export type AuthExtensionSource = AuthExtension | ((core: AuthCore) => AuthExtension);

/**
 * Several extensions as one: plugins and paths in order, adapters wrapped in turn, trusted origins together, and the
 * first extension that vouches for a new person, or sets a session's fields, decides. So each must answer null (or
 * undefined) for requests that aren't its own: one that vouches too broadly would decide for the others. Two that set
 * a rate limit for the same pattern are refused rather than one silently winning.
 */
export function combineExtensions(...sources: AuthExtensionSource[]): (core: AuthCore) => AuthExtension {
  return (core) => {
    const all = sources.map((source) => (typeof source === "function" ? source(core) : source));
    const adapters = all.flatMap((e) => (e.adapter ? [e.adapter] : []));
    const origins = all.flatMap((e) => (e.trustedOrigins ? [e.trustedOrigins] : []));
    return {
      plugins: all.flatMap((e) => e.plugins ?? []),
      disabledPaths: all.flatMap((e) => e.disabledPaths ?? []),
      rateLimitRules: mergeRules(all.map((e) => e.rateLimitRules ?? {})),
      ...(adapters.length ? { adapter: (factory) => adapters.reduce((wrapped, wrap) => wrap(wrapped), factory) } : {}),
      ...(origins.length
        ? { trustedOrigins: async (request) => (await Promise.all(origins.map((o) => o(request)))).flat() }
        : {}),
      vouchForNewUser: async (user, context) => {
        for (const e of all) {
          const vouched = await e.vouchForNewUser?.(user, context);
          if (vouched) return vouched;
        }
        return null;
      },
      sessionFields: async (session, context) => {
        for (const e of all) {
          const fields = await e.sessionFields?.(session, context);
          if (fields) return fields;
        }
        return undefined;
      },
    };
  };
}

function mergeRules(sets: Record<string, { window: number; max: number }>[]) {
  const merged: Record<string, { window: number; max: number }> = {};
  for (const rules of sets) {
    for (const [pattern, rule] of Object.entries(rules)) {
      if (pattern in merged) throw new Error(`Two auth extensions set a rate limit for ${pattern}`);
      merged[pattern] = rule;
    }
  }
  return merged;
}

/** The session columns an extension may set (migration 0083); declared always, so the schema is the same either way. */
export const SESSION_PROVENANCE_FIELDS = {
  authenticationMethod: { type: "string", required: false, input: false },
  ssoProviderId: { type: "string", required: false, input: false },
  authenticatedAt: { type: "date", required: false, input: false },
} as const;

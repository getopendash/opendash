/**
 * Single sign-on in the auth server: `@better-auth/sso` plus OpenDash's rules, handed to createAuth as an
 * AuthExtension. Each hook does one thing:
 *  1. before an identity provider's callback: refuse unless its provider signs people in (the plugin itself checks
 *     only that the domain was verified, so without this "disable" wouldn't disable);
 *  2. before /sign-in/sso: the same, found by the exact email domain (the plugin would match a subdomain);
 *  3. before a password or email-link sign-in: refuse it at an enforced domain;
 *  4. before everything that takes a session: a session at an enforced domain that didn't come from the enforcing
 *     provider, or is past the age bound, is deleted and the request refused. Better Auth's own endpoints read the
 *     session through a function call, not an endpoint, so this is on every path, not only /get-session;
 *  5. after /get-session: the same verdict, for the one path (4) skips; the app's pages and API ask through it;
 *  6. after anything else that made a session (an email link, a two-factor code): at an enforced domain it's deleted;
 *  7. after a provider's callback: someone new to the provider's workspace joins it, with the role an invitation gave
 *     them, or else the provider's join role (viewer unless an admin chose member).
 * Inside the callback's own transaction, `resolveUser` checks the provider again (after the plugin locked its row, so
 * Disable can't race a sign-in) and that the email is at exactly its domain.
 */
import { sso } from "@better-auth/sso";
import type { AuthAudit, AuthExtension } from "@opendash/auth";
import { safeRedirectPath } from "@opendash/auth/routes";
import type { OrgSealer } from "@opendash/core";
import { uuidv7 } from "@opendash/db";
import type { AuthDatabase } from "@opendash/db/auth";
import { authTables as t } from "@opendash/db/auth";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { and, eq, gt, sql } from "drizzle-orm";
import { guardEnforcedSession } from "./guard";
import { assertPublicIdpUrl, IdpAddressRefused } from "./hosts";
import {
  callbackProviderId,
  canSignInThrough,
  emailDomain,
  isSessionGuardExempt,
  isSsoCallbackPath,
  isSsoPluginRequest,
  LOCAL_SIGN_IN_PATHS,
  type ProviderPolicy,
  SSO_DNS_TOKEN_PREFIX,
  SSO_REQUIRED_MESSAGE,
  SSO_UNAVAILABLE_MESSAGE,
  trustedIdpOrigins,
} from "./policy";
import { sealedSsoAdapter } from "./sealed-adapter";
import { enforcedProviderForDomain, providerPolicy, signInProviderForDomain, verifiedProviderOrigins } from "./store";

/**
 * The plugin's own provider management, which OpenDash calls in process (manage.ts) and never over HTTP: there the
 * plugin's only check is "an admin of the organization you name", and it knows nothing of the lifecycle, the audit
 * log or the refusal to remove an enforced provider. The shared callback isn't used: each provider has its own.
 */
export const SSO_DISABLED_PATHS = [
  "/sso/register",
  "/sso/update-provider",
  "/sso/delete-provider",
  "/sso/providers",
  "/sso/get-provider",
  "/sso/request-domain-verification",
  "/sso/verify-domain",
  "/sso/callback",
];

/** OpenDash's columns, declared to the plugin so its reads return them; nobody can set them through its input. */
const PROVIDER_FIELDS = {
  name: { type: "string", required: false, input: false, defaultValue: "" },
  status: { type: "string", required: false, input: false, defaultValue: "draft" },
  enforceSso: { type: "boolean", required: false, input: false, defaultValue: false },
  joinRole: { type: "string", required: false, input: false, defaultValue: "viewer" },
  lastTestedAt: { type: "date", required: false, input: false },
  createdAt: { type: "date", required: false, input: false, defaultValue: () => new Date() },
  updatedAt: { type: "date", required: false, input: false, defaultValue: () => new Date() },
} as const;

const NO_USER = "00000000-0000-0000-0000-000000000000";

type Ctx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];
type SessionShape = {
  user?: { id?: string; email?: string; name?: string | null };
  session?: {
    token?: string;
    authenticationMethod?: string | null;
    ssoProviderId?: string | null;
    authenticatedAt?: Date | string | null;
  };
} | null;

export interface SsoAuthDeps {
  database: AuthDatabase;
  sealer: OrgSealer;
  /** The app's origin (BETTER_AUTH_URL), for sending a browser back to the sign-in page. */
  appOrigin: string;
}

const textOf = (body: unknown, key: string) => {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

export function ssoAuthExtension(deps: SsoAuthDeps): (core: { audit: AuthAudit }) => AuthExtension {
  const { db } = deps.database;
  const signInPage = (error: string) => `${deps.appOrigin}/sign-in?error=${error}`;

  return ({ audit }) => {
    const where = (ctx: Ctx) => audit.requestFacts(ctx);

    /** A refusal is recorded in every workspace the person belongs to; the same work whether or not they exist. */
    async function refused(ctx: Ctx, email: string, method: "password" | "email_link" | "session") {
      const [u] = await db
        .select({ id: t.user.id, name: t.user.name, email: t.user.email })
        .from(t.user)
        .where(sql`lower(${t.user.email}) = ${email.toLowerCase()}`)
        .limit(1);
      await audit.record(
        await audit.orgsOf(u?.id ?? NO_USER),
        {
          action: "signin.refused",
          actor: u ? { type: "user", id: u.id, name: u.name || u.email } : { type: "user" },
          detail: { method, reason: "sso_required" },
          ...where(ctx),
        },
        true,
      );
    }

    /** A refused session is deleted, row and cookie, so it can't be replayed at a path these hooks don't cover. */
    async function revoke(ctx: Ctx, token: string | undefined) {
      if (token) await ctx.context.internalAdapter.deleteSession(token).catch(() => undefined);
      deleteSessionCookie(ctx);
      ctx.context.session = null;
    }

    const unavailable = () => new APIError("FORBIDDEN", { message: SSO_UNAVAILABLE_MESSAGE, code: "SSO_UNAVAILABLE" });

    /** An OIDC provider's issuer must be public (hosts.ts); checked again before each sign-in, as DNS can change. */
    async function publicIssuer(providerId: string) {
      const [row] = await db
        .select({ issuer: t.ssoProvider.issuer, oidc: sql<boolean>`${t.ssoProvider.oidcConfig} is not null` })
        .from(t.ssoProvider)
        .where(eq(t.ssoProvider.providerId, providerId));
      if (!row) return false;
      // SAML: the server never calls the identity provider (the browser carries both messages), and its addresses
      // were checked when its metadata was read.
      if (!row.oidc) return true;
      try {
        await assertPublicIdpUrl(row.issuer);
        return true;
      } catch (error) {
        if (error instanceof IdpAddressRefused) {
          console.error(JSON.stringify({ msg: "sso issuer refused", providerId, reason: error.message }));
          return false;
        }
        throw error;
      }
    }

    /** Someone new to the provider's workspace joins it (with their invitation's role, or the provider's join role). */
    async function join(ctx: Ctx, provider: ProviderPolicy, user: { id: string; email: string; name?: string | null }) {
      const orgId = provider.organizationId;
      const [already] = await db
        .select({ id: t.member.id })
        .from(t.member)
        .where(and(eq(t.member.organizationId, orgId), eq(t.member.userId, user.id)));
      if (already) return;
      const [invited] = await db
        .select({ id: t.invitation.id, role: t.invitation.role })
        .from(t.invitation)
        .where(
          and(
            eq(t.invitation.organizationId, orgId),
            eq(t.invitation.status, "pending"),
            gt(t.invitation.expiresAt, new Date()),
            sql`lower(${t.invitation.email}) = ${user.email.toLowerCase()}`,
          ),
        )
        .limit(1);
      // An invitation's role wins; otherwise the provider's join role (viewer or member, never more: a CHECK says so).
      let role: "admin" | "member" | "viewer" = "viewer";
      if (invited) {
        if (invited.role === "admin" || invited.role === "member") role = invited.role;
      } else {
        const [row] = await db
          .select({ joinRole: t.ssoProvider.joinRole })
          .from(t.ssoProvider)
          .where(eq(t.ssoProvider.providerId, provider.providerId));
        if (row?.joinRole === "member") role = "member";
      }
      const memberId = uuidv7();
      await db.transaction(async (tx) => {
        await tx
          .insert(t.member)
          .values({ id: memberId, organizationId: orgId, userId: user.id, role, createdAt: new Date() })
          .onConflictDoNothing();
        if (invited) await tx.update(t.invitation).set({ status: "accepted" }).where(eq(t.invitation.id, invited.id));
      });
      await audit.record([orgId], {
        action: "member.joined",
        actor: { type: "user", id: user.id, name: user.name || user.email },
        target: { type: "member", id: memberId, name: user.name || user.email },
        detail: { role },
        ...where(ctx),
      });
    }

    const policy: BetterAuthPlugin = {
      id: "opendash-sso-policy",
      hooks: {
        before: [
          {
            // 1. An identity provider's callback, for a provider that may sign people in.
            matcher: (ctx) => isSsoCallbackPath(ctx.path),
            handler: createAuthMiddleware(async (ctx) => {
              const providerId = callbackProviderId(ctx);
              const provider = providerId ? await providerPolicy(db, providerId) : null;
              if (!providerId || !canSignInThrough(provider) || !(await publicIssuer(providerId))) {
                throw ctx.redirect(signInPage("sso_unavailable"));
              }
            }),
          },
          {
            // 2. Starting single sign-on: by provider (a test sign-in) or by email, at exactly the provider's domain.
            matcher: (ctx) => ctx.path === "/sign-in/sso",
            handler: createAuthMiddleware(async (ctx) => {
              const providerId = textOf(ctx.body, "providerId");
              const email = textOf(ctx.body, "email");
              // Identity providers' origins are trusted on this path (for the plugin's own calls), and Better Auth
              // checks the redirect targets against the same list: so they must be paths on this site.
              for (const key of ["callbackURL", "errorCallbackURL", "newUserCallbackURL"]) {
                const target = textOf(ctx.body, key);
                if (target && safeRedirectPath(target) !== target) {
                  throw new APIError("FORBIDDEN", { message: "Invalid callback URL", code: "INVALID_CALLBACK_URL" });
                }
              }
              // Sign-in by organization or bare domain isn't offered: it would sidestep the exact-domain rule.
              if (textOf(ctx.body, "organizationSlug") || (!providerId && !email)) throw unavailable();
              const provider = providerId
                ? await providerPolicy(db, providerId)
                : await signInProviderForDomain(db, emailDomain(email ?? ""));
              if (!canSignInThrough(provider)) throw unavailable();
              if (email && emailDomain(email) !== provider.domain) throw unavailable();
              if (!(await publicIssuer(provider.providerId))) throw unavailable();
            }),
          },
          {
            // 3. Password and email-link sign-in, refused at an enforced domain (the page hiding them is cosmetic).
            matcher: (ctx) => LOCAL_SIGN_IN_PATHS.has(ctx.path ?? ""),
            handler: createAuthMiddleware(async (ctx) => {
              const email = textOf(ctx.body, "email");
              if (!email || !(await enforcedProviderForDomain(db, emailDomain(email), { fresh: true }))) return;
              await refused(ctx, email, ctx.path === "/sign-in/email" ? "password" : "email_link");
              throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED" });
            }),
          },
          {
            // 4. A refused session takes no authenticated action.
            matcher: (ctx) => !isSessionGuardExempt(ctx.path),
            handler: createAuthMiddleware(async (ctx) => {
              // Cached on the request, so the endpoint's own session read reuses it.
              const current = (await getSessionFromCtx(ctx).catch(() => null)) as SessionShape;
              const email = current?.user?.email;
              if (!email || !current?.session) return;
              const verdict = await guardEnforcedSession(db, { userEmail: email, session: current.session });
              if (verdict.ok) return;
              await revoke(ctx, current.session.token);
              await refused(ctx, email, "session");
              throw new APIError("UNAUTHORIZED", { message: SSO_REQUIRED_MESSAGE, code: "SSO_SESSION_REFUSED" });
            }),
          },
        ],
        after: [
          {
            // 5. The session read every page and API call makes.
            matcher: (ctx) => ctx.path === "/get-session",
            handler: createAuthMiddleware(async (ctx) => {
              const returned = ctx.context.returned as SessionShape | undefined;
              const email = returned?.user?.email;
              if (!email || !returned?.session) return;
              const verdict = await guardEnforcedSession(db, { userEmail: email, session: returned.session });
              if (verdict.ok) return;
              await revoke(ctx, returned.session.token);
              await refused(ctx, email, "session");
              // What callers expect for "not signed in".
              return ctx.json(null);
            }),
          },
          {
            // 6. A session made another way at an enforced domain (an email link carries no email in its body).
            matcher: (ctx) => !isSsoCallbackPath(ctx.path),
            handler: createAuthMiddleware(async (ctx) => {
              const made = ctx.context.newSession as SessionShape | undefined;
              const email = made?.user?.email;
              if (!email || !made?.session || made.session.authenticationMethod === "sso") return;
              if (!(await enforcedProviderForDomain(db, emailDomain(email), { fresh: true }))) return;
              await revoke(ctx, made.session.token);
              await refused(ctx, email, ctx.path === "/sign-in/email" ? "password" : "email_link");
              if (ctx.request?.method === "GET") throw ctx.redirect(signInPage("sso_required"));
              throw new APIError("FORBIDDEN", { message: SSO_REQUIRED_MESSAGE, code: "SSO_REQUIRED" });
            }),
          },
          {
            // 7. Someone signed in through a provider is a member of its workspace.
            matcher: (ctx) => isSsoCallbackPath(ctx.path),
            handler: createAuthMiddleware(async (ctx) => {
              const made = ctx.context.newSession as SessionShape | undefined;
              const providerId = callbackProviderId(ctx);
              const user = made?.user;
              if (!providerId || !user?.id || !user.email) return;
              const provider = await providerPolicy(db, providerId);
              if (!provider || emailDomain(user.email) !== provider.domain) return;
              try {
                await join(ctx, provider, { id: user.id, email: user.email, name: user.name });
              } catch (error) {
                // The session is made; the app sends someone without a membership to the right page.
                console.error(
                  JSON.stringify({
                    msg: "sso member not added",
                    providerId,
                    error: error instanceof Error ? error.message : String(error),
                  }),
                );
              }
            }),
          },
        ],
      },
    };

    const plugin = sso({
      providersLimit: 10,
      // Our own membership step (7), so the role can be viewer and the join is audited.
      organizationProvisioning: { disabled: true },
      // A verified domain is what permits creating and linking accounts. The record names us (policy.ts).
      domainVerification: { enabled: true, tokenPrefix: SSO_DNS_TOKEN_PREFIX },
      schema: { ssoProvider: { additionalFields: PROVIDER_FIELDS } },
      saml: {
        enableInResponseToValidation: true,
        allowIdpInitiated: false,
        requireTimestamps: true,
        algorithms: { onDeprecated: "reject" },
      },
      // Inside the callback's transaction, after the plugin locked the provider's row.
      resolveUser: async (input, { database }) => {
        const row = (await database.findOne({
          model: "ssoProvider",
          where: [{ field: "providerId", value: input.providerId }],
        })) as { domain?: string; domainVerified?: boolean; status?: string } | null;
        if (!canSignInThrough(row as { domainVerified: boolean; status: string } | null)) {
          return { action: "reject", code: "SSO_UNAVAILABLE", message: SSO_UNAVAILABLE_MESSAGE };
        }
        if (emailDomain(input.providerUser.email) !== row?.domain) {
          return {
            action: "reject",
            code: "SSO_DOMAIN_MISMATCH",
            message: "This identity provider doesn't cover that email address.",
          };
        }
        return { action: "continue" };
      },
    }) as unknown as BetterAuthPlugin;

    return {
      plugins: [policy, plugin],
      disabledPaths: SSO_DISABLED_PATHS,
      adapter: (factory) => sealedSsoAdapter(factory, deps.sealer),
      // The identity providers' origins exist for one reader: the plugin's guard on the calls it makes. Better Auth
      // checks redirect targets and request origins against the same list on every endpoint, so they're added only
      // on the SSO paths, never where a callbackURL could name them. Without a request (this server's own in-process
      // calls, registering a provider) only the operator's own list.
      trustedOrigins: async (request) =>
        isSsoPluginRequest(request)
          ? [...(await verifiedProviderOrigins(db)), ...trustedIdpOrigins()]
          : request
            ? []
            : trustedIdpOrigins(),
      vouchForNewUser: async (user, context) => {
        const providerId = callbackProviderId(context);
        if (!providerId) return null;
        const provider = await providerPolicy(db, providerId);
        if (!canSignInThrough(provider) || emailDomain(user.email) !== provider.domain) return null;
        // The organization proved the domain and its provider vouched for the address: it's verified.
        return { emailVerified: true };
      },
      sessionFields: async (session, context) => {
        const providerId = callbackProviderId(context);
        if (!providerId) return undefined;
        const provider = await providerPolicy(db, providerId);
        // Through the callback's own transaction: someone it just made isn't committed yet.
        const adapter = (
          context as { context?: { internalAdapter?: { findUserById(id: string): Promise<{ email: string } | null> } } }
        )?.context?.internalAdapter;
        const u = await adapter?.findUserById(session.userId);
        if (!canSignInThrough(provider) || !u || emailDomain(u.email) !== provider.domain) {
          throw new APIError("FORBIDDEN", { message: SSO_UNAVAILABLE_MESSAGE, code: "SSO_DOMAIN_MISMATCH" });
        }
        return {
          authenticationMethod: "sso",
          ssoProviderId: provider.providerId,
          authenticatedAt: new Date(),
          activeOrganizationId: provider.organizationId,
        };
      },
    };
  };
}

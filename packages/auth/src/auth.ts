/**
 * Better Auth for OpenDash, shaped for email-first sign-up:
 * an account is created only when someone opens the emailed link, and the password is chosen afterwards. So no
 * password ever exists before the address is proven (account pre-hijacking). Also: organizations with
 * teams, org- and user-owned API keys, and production guards on the secret, base URL, origins and cookies.
 * SSO and SCIM live in ee/.
 */

import { hkdfSync } from "node:crypto";
import { getIP } from "@better-auth/core/utils/ip";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { type Kek, kekFromEnv, track } from "@opendash/core";
import { uuidv7, withSystem } from "@opendash/db";
import { type AuthDatabase, authTables, getAuthDatabase } from "@opendash/db/auth";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { and, eq, gt, sql } from "drizzle-orm";
import { authAudit } from "./audit";
import { type AuthExtensionSource, SESSION_PROVENANCE_FIELDS } from "./extension";
import { isOwnerRole, recordKeyMaker, revokeOrgKeys, revokeUserKeys } from "./keys";
import { ACCOUNT_LIMITS, accountKey, ENDPOINT_LIMITS, type LimitDecision, postgresLimiter } from "./limits";
import { type AuthMail, defaultMailer, type Mailer } from "./mailer";
import { authBaseUrl, resolveTrustedOrigins } from "./origins";
import { schemaPlugins } from "./plugins";
import { provisionOrg, type SystemRunner } from "./provision";
import { authRoutes, EMAIL_LINK_TTL_SECONDS } from "./routes";
import { anyAccount } from "./tenant-context";
import { twoFactorLinkRedirect } from "./two-factor";

export interface CreateAuthOptions {
  /** Signs sessions and email-verification links. Defaults to BETTER_AUTH_SECRET; required in every environment. */
  secret?: string;
  /** opendash_auth connection. Defaults to DATABASE_AUTH_URL. */
  database?: AuthDatabase;
  /** Runs product-side provisioning as opendash_system. Defaults to withSystem. */
  system?: SystemRunner;
  /** Wraps each new org's data key. Defaults to OPENDASH_KEK. */
  kek?: Kek | (() => Kek);
  mailer?: Mailer;
  /**
   * Only invited emails can register, once the instance has its first account. Default: on unless
   * OPENDASH_INVITE_ONLY=0.
   */
  inviteOnly?: boolean;
  baseURL?: string;
  /** Rate limiting is on in production; tests turn it on explicitly. */
  rateLimit?: boolean;
  /**
   * Ends what the membership gave in the product (routines it got or owned), after Better Auth removed it: someone
   * removed, or leaving. A failure is logged, never thrown: the membership is already gone, and the product's own
   * checks (a routine's run, a send) find that too.
   */
  memberRemoved?: (orgId: string, userId: string) => Promise<void>;
  /**
   * What an enterprise build adds (single sign-on and directory sync, from ee/ through apps/web/enterprise.ts). A
   * function gets the core's own pieces it may use (AuthCore).
   */
  extension?: AuthExtensionSource;
}

const normalizeEmail = (email: string) => email.trim().toLowerCase();

const list = (name: string) =>
  (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

function flag(name: string, unset: boolean): boolean {
  const value = process.env[name]?.trim();
  if (!value) return unset;
  if (value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 0 or 1`);
}

/**
 * Whether only invited people can register. On unless the operator opts out with OPENDASH_INVITE_ONLY=0: an instance
 * anyone can reach would otherwise let any visitor make workspaces on its model keys and connect sources on its
 * network. An instance nobody has joined yet takes one sign-up, its first account; everyone after joins by
 * invitation. The sign-in screen reads the same answer (apps/web/lib/auth.ts).
 */
export const inviteOnlyFromEnv = (): boolean => flag("OPENDASH_INVITE_ONLY", true);

// Better Auth's built-in fallback secret. It refuses it only when NODE_ENV=production.
const BETTER_AUTH_DEFAULT_SECRET = "better-auth-secret-12345678901234567890";

/**
 * The secret signs email-verification links (HS256 JWTs). With Better Auth's public default, anyone could forge a
 * link, verify an email they don't own and then accept an invitation addressed to it. So a real secret is required
 * in every environment, not only production.
 */
function resolveSecret(explicit: string | undefined): string {
  const secret = (explicit ?? process.env.BETTER_AUTH_SECRET)?.trim();
  if (!secret || secret.length < 32 || secret === BETTER_AUTH_DEFAULT_SECRET) {
    throw new Error("BETTER_AUTH_SECRET must be a random value of at least 32 characters (openssl rand -base64 32)");
  }
  return secret;
}

/** Refuse to boot a production auth server with weak or missing settings, instead of failing on a request. */
function validateProductionEnvironment(): void {
  if (process.env.NODE_ENV !== "production") return;
  authBaseUrl();
  resolveTrustedOrigins({} as Request);
}

export function createAuth(options: CreateAuthOptions = {}) {
  validateProductionEnvironment();
  const secret = resolveSecret(options.secret);
  const database = options.database ?? getAuthDatabase();
  const db = database.db;
  const t = authTables;
  // Resolved now, not when the first organization is created: a missing OPENDASH_KEK fails here with a clear error,
  // and in production at startup (apps/web/instrumentation.ts), instead of halfway through creating a workspace.
  const keyEncryptionKey = typeof options.kek === "function" ? options.kek() : (options.kek ?? kekFromEnv());
  const inviteOnly = options.inviteOnly ?? inviteOnlyFromEnv();
  const baseURL = options.baseURL ?? authBaseUrl();
  const limitsOn = options.rateLimit ?? process.env.NODE_ENV === "production";
  // Client IP for rate limiting. Behind a proxy that appends to X-Forwarded-For, list the proxy's addresses so the
  // client's own entry is used; without them a multi-entry header isn't trusted.
  const ipAddress = {
    trustedProxies: list("OPENDASH_TRUSTED_PROXIES"),
    ...(list("OPENDASH_CLIENT_IP_HEADERS").length ? { ipAddressHeaders: list("OPENDASH_CLIENT_IP_HEADERS") } : {}),
  };
  const limiter = postgresLimiter(database);
  // The audit log's rows for what Better Auth does, written as the system role right after it (audit.ts).
  const audits = authAudit({ db, system: options.system ?? withSystem, ipAddress });
  const extension =
    (typeof options.extension === "function"
      ? options.extension({
          audit: audits,
          deriveSecret: (purpose) =>
            Buffer.from(hkdfSync("sha256", secret, "opendash", `opendash:${purpose}`, 32)).toString("base64url"),
          memberRemoved: (orgId, userId) => removed(orgId, userId),
        })
      : options.extension) ?? {};
  const extraOrigins = extension.trustedOrigins;
  const keysEnded = (orgId: string, count: number) =>
    count > 0
      ? audits.record([orgId], {
          action: "api_key.revoked",
          actor: { type: "system" },
          detail: { owner: "organization", count },
        })
      : Promise.resolve();
  const tooMany = (decision: LimitDecision) =>
    new APIError(
      "TOO_MANY_REQUESTS",
      { message: "Too many attempts. Try again later, or sign in with an email link.", code: "TOO_MANY_ATTEMPTS" },
      { "X-Retry-After": String(decision.retryAfter ?? 60) },
    );
  const mailer = options.mailer ?? defaultMailer(new URL(baseURL).host);
  // Emails go out after the response, so a request takes the same time whether or not an account exists or the
  // provider is slow. Failures are logged without the address; people can ask again.
  const deliver = (mail: AuthMail): void => {
    mailer.send(mail).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ msg: "auth email failed", kind: mail.kind, error: message }));
    });
  };
  const provision = (orgId: string, name: string) =>
    provisionOrg({ orgId, name }, { kek: keyEncryptionKey, system: options.system });
  const pageUrl = (path: string) => new URL(path, baseURL).toString();

  async function userExists(email: string): Promise<boolean> {
    const [row] = await db
      .select({ id: t.user.id })
      .from(t.user)
      .where(sql`lower(${t.user.email}) = ${normalizeEmail(email)}`)
      .limit(1);
    return Boolean(row);
  }

  async function registrationAllowed(email: string): Promise<boolean> {
    if (!inviteOnly) return true;
    const normalized = normalizeEmail(email);
    const [invited] = await db
      .select({ id: t.invitation.id })
      .from(t.invitation)
      .where(
        and(
          eq(t.invitation.status, "pending"),
          gt(t.invitation.expiresAt, new Date()),
          sql`lower(${t.invitation.email}) = ${normalized}`,
        ),
      )
      .limit(1);
    if (invited) return true;
    // Nobody has joined yet: the first sign-up is the instance's own. Like an invitee, it proves the address:
    // accounts are made only through the email link (emailAndPassword below).
    return !(await anyAccount(database));
  }

  const removed = async (orgId: string, userId: string) => {
    await options.memberRemoved?.(orgId, userId).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        JSON.stringify({ msg: "member removal not finished in the product", orgId, userId, error: message }),
      );
    });
  };

  return betterAuth({
    appName: "OpenDash",
    secret,
    baseURL,
    // Vendor telemetry is off in everything we ship (AGENTS.md).
    telemetry: { enabled: false },
    // Real transactions: Better Auth's multi-step writes (an invitation accepted, a membership changed) then commit or
    // roll back whole. Without this its "transactions" run step by step and a failure leaves half the change.
    database: (extension.adapter ?? ((adapter) => adapter))(
      drizzleAdapter(db, { provider: "pg", schema: authTables, transaction: true }),
    ),
    databaseHooks: {
      user: {
        create: {
          // The registration gate. Every way of creating a user passes through here, including the email link and
          // single sign-on (whose extension may vouch for someone at its verified domain).
          // The code makes the email-link endpoint redirect to the "link expired" page instead of failing.
          before: async (user, context) => {
            const vouched = (await extension.vouchForNewUser?.(user, context)) ?? null;
            if (!vouched && !(await registrationAllowed(user.email))) {
              throw APIError.from("FORBIDDEN", {
                message: "Registration requires an invitation.",
                code: "REGISTRATION_REQUIRES_INVITATION",
              });
            }
            return { data: { ...user, ...vouched, email: normalizeEmail(user.email) } };
          },
          // Product analytics (off without POSTHOG_KEY): the person's id and how they came, never their address. Not
          // waited on, here or below: signing up doesn't wait for PostHog.
          after: async (user, context) => {
            void track({ event: "signed_up", userId: user.id, properties: { method: signUpMethod(context?.path) } });
          },
        },
      },
      session: {
        create: {
          // Pick an active organization so the session always resolves to a tenant. A session made by single sign-on
          // gets its provider's organization and where it came from, from the extension.
          before: async (session, context) => {
            const fields = await extension.sessionFields?.(session, context);
            if (fields?.activeOrganizationId) return { data: { ...session, ...fields } };
            const [m] = await db
              .select({ orgId: t.member.organizationId })
              .from(t.member)
              .where(eq(t.member.userId, session.userId))
              .orderBy(t.member.createdAt)
              .limit(1);
            if (!m && !fields) return undefined;
            return { data: { ...session, ...fields, ...(m ? { activeOrganizationId: m.orgId } : {}) } };
          },
        },
      },
    },
    // Where a session came from (single sign-on enforcement reads it). Only the server's hooks write these.
    session: { additionalFields: SESSION_PROVENANCE_FIELDS },
    ...(extension.disabledPaths?.length ? { disabledPaths: extension.disabledPaths } : {}),
    emailAndPassword: {
      enabled: true,
      // Passwords are for signing in. Accounts are created only through the email link (magicLink below), and the
      // first password is set after that, so nobody can choose a password for an address they don't control.
      disableSignUp: true,
      requireEmailVerification: true,
      minPasswordLength: 10,
      resetPasswordTokenExpiresIn: EMAIL_LINK_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      // A reset ends every credential the account had, not only its sessions: a key made with a borrowed session
      // mustn't outlive it (keys.ts).
      // Sessions before keys, as the operator's reset does (recovery.ts): a key made with a session meanwhile is either
      // deleted here or finds its session gone (hooks.after). A failure fails the reset, saying so, rather than report
      // a reset that left keys working; the sessions go first, so a failure never leaves them either.
      onPasswordReset: async ({ user }) => {
        let keys = 0;
        try {
          await db.delete(t.session).where(eq(t.session.userId, user.id));
          keys = await revokeUserKeys(db, user.id);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(
            JSON.stringify({ msg: "api keys not revoked on password reset", userId: user.id, error: message }),
          );
          throw error;
        }
        const who = { type: "user" as const, id: user.id, name: user.name || user.email };
        await audits.forUser(user.id, {
          action: "password.reset",
          actor: who,
          target: { type: "user", id: user.id, name: who.name },
        });
        if (keys > 0)
          await audits.forUser(user.id, {
            action: "api_key.revoked",
            actor: who,
            detail: { owner: "user", count: keys },
          });
      },
      sendResetPassword: async ({ user, url }) => deliver({ to: user.email, kind: "reset-password", url }),
    },
    // No verification emails, ever. Better Auth's verify-email link marks an address verified but keeps whatever
    // password the account already had, which is the pre-hijacking path. Accounts are verified by the email link
    // instead, which strips any access set up before the address was proven. An unverified account signing in gets
    // EMAIL_NOT_VERIFIED, and the sign-in page sends it an email link.
    emailVerification: { sendOnSignUp: false, sendOnSignIn: false, autoSignInAfterVerification: false },
    trustedOrigins: extraOrigins
      ? async (request?: Request) => [...resolveTrustedOrigins(request), ...(await extraOrigins(request))]
      : resolveTrustedOrigins,
    // Better Auth's per-IP limits (sign-in and sign-up 3 per 10 s, reset 3 per minute, email links 5 per minute),
    // counted in Postgres so they hold across restarts and web replicas (src/limits.ts).
    rateLimit: {
      enabled: limitsOn,
      customStorage: limiter.betterAuthStorage,
      ...(extension.rateLimitRules ? { customRules: extension.rateLimitRules } : {}),
    },
    // Per-account limits (src/limits.ts). Each attempt is counted before it runs, so parallel requests can't slip
    // past; a successful sign-in clears the account's sign-in counters.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const limits = ENDPOINT_LIMITS[ctx.path];
        const email = typeof ctx.body?.email === "string" ? normalizeEmail(ctx.body.email) : "";
        if (!limitsOn || !limits || !email) return;
        const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), { advanced: { ipAddress } });
        const [perIp, overall] = limits;
        for (const [limit, key] of [
          [perIp, accountKey(perIp, email, ip)],
          [overall, accountKey(overall, email)],
        ] as const) {
          const decision = await limiter.consume(key, ACCOUNT_LIMITS[limit]);
          if (!decision.allowed) throw tooMany(decision);
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A key made with a session that's gone by the time it's written (a reset or the operator's two-factor reset
        // ran meanwhile) goes too, so a borrowed session can't race recovery into a key that outlives it (keys.ts).
        if (ctx.path === "/api-key/create") {
          const asker = ctx.context.session as { session?: { id?: string }; user?: { id?: string } } | null | undefined;
          const sessionId = asker?.session?.id;
          const made = ctx.context.returned as { id?: string; configId?: string } | null | undefined;
          if (!made?.id) return;
          // An org key records who made it, so recovering their account ends it too (keys.ts).
          const maker = asker?.user?.id ?? (typeof ctx.body?.userId === "string" ? ctx.body.userId : undefined);
          if (made.configId === "org" && maker) await recordKeyMaker(db, made.id, maker);
          if (!sessionId) return;
          // `for share` waits for a recovery deleting the session to commit, then finds it gone.
          const [live] = await db
            .select({ id: t.session.id })
            .from(t.session)
            .where(eq(t.session.id, sessionId))
            .for("share");
          if (!live) await db.delete(t.apikey).where(eq(t.apikey.id, made.id));
          return;
        }
        // Leaving fires no organization hook: an owner who leaves ends the workspace's keys too (keys.ts).
        if (ctx.path === "/organization/leave") {
          const left = ctx.context.returned as
            | { role?: string; organizationId?: string; userId?: string }
            | null
            | undefined;
          if (left?.organizationId && isOwnerRole(left.role)) {
            await keysEnded(left.organizationId, await revokeOrgKeys(db, left.organizationId));
          }
          if (left?.organizationId && left.userId) await removed(left.organizationId, left.userId);
          return;
        }
        if (!limitsOn || ctx.path !== "/sign-in/email") return;
        const returned = ctx.context.returned as { statusCode?: number } | null | undefined;
        const email = typeof ctx.body?.email === "string" ? normalizeEmail(ctx.body.email) : "";
        if (!email || !returned || returned.statusCode !== undefined) return;
        const ip = getIP(ctx.request ?? ctx.headers ?? new Headers(), { advanced: { ipAddress } });
        await limiter.reset([accountKey("signInPerIp", email, ip), accountKey("signIn", email)]);
      }),
    },
    advanced: {
      ipAddress,
      database: { generateId: () => uuidv7() },
      // Pinned explicitly so a later config change can't silently weaken them.
      defaultCookieAttributes: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production" },
      // Better Auth skips origin checks when NODE_ENV=test by default; keep them on everywhere.
      disableOriginCheck: false,
    },
    plugins: [
      ...schemaPlugins({
        organizationHooks: {
          // Better Auth has already written the organization and its owner. If the product side can't be set up,
          // undo the organization so nobody is left with a workspace that has no app.org row or data key.
          afterCreateOrganization: async ({ organization, user }) => {
            try {
              await provision(organization.id, organization.name);
            } catch (error) {
              await db.delete(t.organization).where(eq(t.organization.id, organization.id));
              throw error;
            }
            void track({ event: "workspace_created", userId: user.id, orgId: organization.id });
          },
          afterCreateInvitation: async ({ invitation, inviter, organization }) => {
            void track({
              event: "teammate_invited",
              userId: inviter.id,
              orgId: organization.id,
              properties: { role: invitation.role ?? "member" },
            });
          },
          afterAcceptInvitation: async ({ member, user, organization }) => {
            void track({
              event: "invitation_accepted",
              userId: user.id,
              orgId: organization.id,
              properties: { role: member.role },
            });
          },
          // An owner who stops being one may have made any of the workspace's keys, so they all end (keys.ts).
          afterRemoveMember: async ({ member, organization }) => {
            if (isOwnerRole(member.role)) await keysEnded(organization.id, await revokeOrgKeys(db, organization.id));
            await removed(organization.id, member.userId);
          },
          afterUpdateMemberRole: async ({ member, previousRole, organization }) => {
            if (isOwnerRole(previousRole) && !isOwnerRole(member.role)) {
              await keysEnded(organization.id, await revokeOrgKeys(db, organization.id));
            }
          },
        },
        sendInvitationEmail: async ({ id, email, organization, inviter }) =>
          deliver({
            to: email,
            kind: "invitation",
            url: pageUrl(authRoutes.invitation(id)),
            context: { organization: organization.name, inviter: inviter.user.name },
          }),
      }),
      magicLink({
        expiresIn: EMAIL_LINK_TTL_SECONDS,
        sendMagicLink: async ({ email, url }) => {
          const existing = await userExists(email);
          // Don't email strangers on an invite-only instance. The response is the same either way, so this doesn't
          // reveal who is invited; the user.create.before hook still has the final say.
          if (!existing && !(await registrationAllowed(email))) return;
          // The email points at our Continue page, carrying the same query; its button opens the one-time link.
          const link = new URL(url);
          deliver({
            to: email,
            kind: existing ? "sign-in" : "sign-up",
            url: pageUrl(`${authRoutes.continue}${link.search}`),
          });
        },
      }),
      // After the two-factor plugin's challenge on the email-link path: send the browser to the code page.
      twoFactorLinkRedirect(),
      // An enterprise build's plugins (single sign-on), before the audit log's so it records what they decided.
      ...(extension.plugins ?? []),
      // After the two-factor plugins, so the sign-ins it records are final (audit.ts).
      audits.plugin(),
      // Must be last.
      nextCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** How an account came to be, from the endpoint that made it: for the signed_up event, a fixed word. */
export function signUpMethod(path: string | undefined): "email_link" | "sso" | "scim" | "other" {
  if (!path) return "other";
  if (path.startsWith("/sso/")) return "sso";
  if (path.startsWith("/scim/")) return "scim";
  if (path.startsWith("/magic-link/")) return "email_link";
  return "other";
}

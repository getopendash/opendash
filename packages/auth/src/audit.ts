/**
 * The audit log's rows for what Better Auth does: sign-ins, two-factor, sessions ended, members and invitations, API
 * keys. Better Auth writes those in its own schema, as its own role, and runs its hooks after the write, so no app row
 * can share its transaction: each row is written as the system role right after, in the same request, into every
 * organization it concerns (a person's sign-in goes to each workspace they belong to). A row that can't be written is
 * logged, never thrown: the action has already happened, and failing the request would only hide that from the person.
 *
 * The plugin goes after the two-factor plugins, so a sign-in it sees is the final word: a password sign-in waiting for
 * its code has no session yet, and is recorded when the code is accepted.
 */
import { getIP } from "@better-auth/core/utils/ip";
import { type AuditActor, type AuditEvent, auditSystem } from "@opendash/core";
import { type AuthDatabase, authTables as t } from "@opendash/db/auth";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { eq, sql } from "drizzle-orm";
import type { SystemRunner } from "./provision";

/** The client-IP settings auth.ts gives Better Auth (trusted proxies, the headers to read). */
type IpOptions = { trustedProxies?: string[]; ipAddressHeaders?: string[] };

interface Who {
  id: string;
  name?: string | null;
  email?: string | null;
  twoFactorEnabled?: boolean | null;
}

const SIGN_IN_METHOD: Record<string, "password" | "email_link" | "two_factor" | "sso"> = {
  "/sign-in/email": "password",
  "/magic-link/verify": "email_link",
  "/two-factor/verify-totp": "two_factor",
  "/two-factor/verify-backup-code": "two_factor",
  "/two-factor/verify-otp": "two_factor",
  // Single sign-on (ee/): the identity provider's OIDC callback and SAML assertion consumer, as Better Auth names them.
  "/sso/callback/:providerId": "sso",
  "/sso/saml2/sp/acs/:providerId": "sso",
};

const PATHS = new Set([
  ...Object.keys(SIGN_IN_METHOD),
  "/two-factor/disable",
  "/revoke-session",
  "/revoke-sessions",
  "/revoke-other-sessions",
  "/organization/invite-member",
  "/organization/cancel-invitation",
  "/organization/accept-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
  "/organization/leave",
  "/api-key/create",
  "/api-key/delete",
]);

/** A user id no account has, for a lookup that must cost the same either way. */
const NO_USER = "00000000-0000-0000-0000-000000000000";

const statusOf = (returned: unknown): number | undefined =>
  returned && typeof returned === "object" ? (returned as { statusCode?: number }).statusCode : undefined;
/** The endpoint answered and didn't refuse (a redirect counts as an answer). */
const answered = (returned: unknown) => returned != null && (statusOf(returned) ?? 200) < 400;

const person = (u: Who | null | undefined): AuditActor | null =>
  u?.id ? { type: "user", id: u.id, name: u.name || u.email || null } : null;

export function authAudit(deps: { db: AuthDatabase["db"]; system: SystemRunner; ipAddress: IpOptions }) {
  const { db, system } = deps;

  /** `always`: open the transaction even with nothing to write (a refused sign-in's timing, below). */
  async function record(orgIds: string[], event: AuditEvent & { actor: AuditActor }, always = false): Promise<void> {
    const orgs = [...new Set(orgIds.filter(Boolean))];
    if (!orgs.length && !always) return;
    try {
      await system(async (tx) => {
        for (const orgId of orgs) await auditSystem(tx, orgId, event);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ msg: "audit row not written", action: event.action, error: message }));
    }
  }

  async function orgsOf(userId: string): Promise<string[]> {
    const rows = await db.select({ orgId: t.member.organizationId }).from(t.member).where(eq(t.member.userId, userId));
    return rows.map((r) => r.orgId);
  }

  const forUser = async (userId: string, event: AuditEvent & { actor: AuditActor }) =>
    record(await orgsOf(userId), event);

  async function userNamed(userId: string | undefined): Promise<Who | null> {
    if (!userId) return null;
    const [u] = await db
      .select({ id: t.user.id, name: t.user.name, email: t.user.email })
      .from(t.user)
      .where(eq(t.user.id, userId))
      .limit(1);
    return u ?? null;
  }

  /** Where a request came from, for a sign-in row: the client's address (behind the configured proxies) and agent. */
  const requestFacts = (ctx: { request?: Request; headers?: Headers }) => ({
    ip: getIP(ctx.request ?? ctx.headers ?? new Headers(), { advanced: { ipAddress: deps.ipAddress } }) || null,
    userAgent: (ctx.request?.headers ?? ctx.headers)?.get("user-agent") ?? null,
  });

  /** What a key was, read before /api-key/delete removes it: by request, since the after hook only has its id. */
  const deleting = new WeakMap<object, { configId: string; referenceId: string; name: string | null }>();
  /** A member's role before /organization/update-member-role changes it (Better Auth's own hook lacks who did it). */
  const roleBefore = new WeakMap<object, string>();

  const plugin = (): BetterAuthPlugin => ({
    id: "opendash-audit",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/organization/update-member-role",
          handler: createAuthMiddleware(async (ctx) => {
            const memberId = typeof ctx.body?.memberId === "string" ? ctx.body.memberId : "";
            const holder = ctx.request ?? ctx.headers;
            if (!memberId || !holder) return;
            const [m] = await db
              .select({ role: t.member.role })
              .from(t.member)
              .where(eq(t.member.id, memberId))
              .limit(1);
            if (m) roleBefore.set(holder, m.role);
          }),
        },
        {
          matcher: (context) => context.path === "/api-key/delete",
          handler: createAuthMiddleware(async (ctx) => {
            const keyId = typeof ctx.body?.keyId === "string" ? ctx.body.keyId : "";
            const holder = ctx.request ?? ctx.headers;
            if (!keyId || !holder) return;
            const [key] = await db
              .select({ configId: t.apikey.configId, referenceId: t.apikey.referenceId, name: t.apikey.name })
              .from(t.apikey)
              .where(eq(t.apikey.id, keyId))
              .limit(1);
            if (key) deleting.set(holder, key);
          }),
        },
      ],
      after: [
        {
          matcher: (context) => PATHS.has(context.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            const path = ctx.path;
            const returned = ctx.context.returned;
            const session = ctx.context.session as { user?: Who } | null | undefined;
            const method = SIGN_IN_METHOD[path];
            // Some endpoints (inviting) don't leave their session where after-hooks look: read it from the request.
            const asker =
              session?.user || method
                ? session
                : ((await getSessionFromCtx(ctx).catch(() => null)) as { user?: Who } | null | undefined);
            const actor = person(asker?.user);
            const where = requestFacts(ctx);

            if (method) {
              const signedIn = ctx.context.newSession as { user?: Who } | null | undefined;
              // Turning two-factor on is the code verified while already signed in.
              if (path === "/two-factor/verify-totp" && actor && session?.user && !session.user.twoFactorEnabled) {
                if (answered(returned)) {
                  await forUser(actor.id as string, {
                    action: "two_factor.enabled",
                    actor,
                    target: { type: "user", id: actor.id, name: actor.name },
                    ...where,
                  });
                }
                return;
              }
              const who = person(signedIn?.user);
              if (who && !(method === "two_factor" && actor)) {
                await forUser(who.id as string, {
                  action: "signin.succeeded",
                  actor: who,
                  detail: { method },
                  ...where,
                });
                return;
              }
              const status = statusOf(returned) ?? 0;
              const email = typeof ctx.body?.email === "string" ? ctx.body.email.trim().toLowerCase() : "";
              if (path === "/sign-in/email" && email && status >= 400) {
                const [u] = await db
                  .select({ id: t.user.id, name: t.user.name, email: t.user.email })
                  .from(t.user)
                  .where(sql`lower(${t.user.email}) = ${email}`)
                  .limit(1);
                // The same work whether or not the address has an account (its workspaces looked up, a transaction
                // opened), so the refusal's timing doesn't say which: only the rows written differ.
                const orgs = await orgsOf(u?.id ?? NO_USER);
                await record(
                  orgs,
                  {
                    action: "signin.failed",
                    actor: person(u) ?? { type: "user" },
                    detail: { method: "password", reason: status === 429 ? "rate_limited" : "bad_credentials" },
                    ...where,
                  },
                  true,
                );
              }
              return;
            }

            if (!answered(returned)) return;
            const body = (returned ?? {}) as Record<string, unknown>;
            if (path === "/two-factor/disable" && actor) {
              await forUser(actor.id as string, {
                action: "two_factor.disabled",
                actor,
                target: { type: "user", id: actor.id, name: actor.name },
                ...where,
              });
            } else if (path.startsWith("/revoke-") && actor) {
              await forUser(actor.id as string, {
                action: "sessions.revoked",
                actor,
                detail: { count: null },
                ...where,
              });
            } else if (path === "/organization/invite-member" && actor) {
              const inv = body as { id?: string; email?: string; role?: string; organizationId?: string };
              await record([inv.organizationId ?? ""], {
                action: "member.invited",
                actor,
                target: { type: "invitation", id: inv.id, name: inv.email },
                detail: { role: (inv.role ?? "member") as never },
              });
            } else if (path === "/organization/cancel-invitation" && actor) {
              const inv = ((body.invitation as object | undefined) ?? body) as {
                id?: string;
                email?: string;
                role?: string;
                organizationId?: string;
              };
              await record([inv.organizationId ?? ""], {
                action: "invitation.cancelled",
                actor,
                target: { type: "invitation", id: inv.id, name: inv.email },
                detail: { role: (inv.role ?? "member") as never },
              });
            } else if (path === "/organization/accept-invitation" && actor) {
              const member = body.member as { id?: string; organizationId?: string; role?: string } | undefined;
              await record([member?.organizationId ?? ""], {
                action: "member.joined",
                actor,
                target: { type: "member", id: member?.id, name: actor.name },
                detail: { role: (member?.role ?? "member") as never },
              });
            } else if (path === "/organization/remove-member" && actor) {
              const member = body.member as
                | { id?: string; userId?: string; organizationId?: string; role?: string }
                | undefined;
              const gone = await userNamed(member?.userId);
              await record([member?.organizationId ?? ""], {
                action: "member.removed",
                actor,
                target: { type: "user", id: member?.userId, name: gone?.name || gone?.email || null },
                detail: { role: (member?.role ?? "member") as never },
              });
            } else if (path === "/organization/update-member-role" && actor) {
              const member = body as { id?: string; userId?: string; organizationId?: string; role?: string };
              const holder = ctx.request ?? ctx.headers;
              const from = holder ? roleBefore.get(holder) : undefined;
              const changed = await userNamed(member.userId);
              await record([member.organizationId ?? ""], {
                action: "member.role_changed",
                actor,
                target: { type: "user", id: member.userId, name: changed?.name || changed?.email || null },
                fields: ["role"],
                detail: { from: (from ?? "unknown") as never, to: (member.role ?? "member") as never },
              });
            } else if (path === "/organization/leave" && actor) {
              const left = body as { organizationId?: string; role?: string };
              await record([left.organizationId ?? ""], {
                action: "member.left",
                actor,
                detail: { role: (left.role ?? "member") as never },
              });
            } else if (path === "/api-key/create") {
              const key = body as {
                id?: string;
                name?: string | null;
                configId?: string;
                referenceId?: string;
                expiresAt?: string | Date | null;
              };
              if (!key.id || !key.referenceId) return;
              const owner = key.configId === "org" ? "organization" : "user";
              const days = key.expiresAt
                ? Math.round((new Date(key.expiresAt).getTime() - Date.now()) / 86_400_000)
                : null;
              const event = {
                action: "api_key.created" as const,
                actor: actor ?? { type: "system" as const },
                target: { type: "api_key" as const, id: key.id, name: key.name ?? null },
                detail: { owner, expiresInDays: days } as const,
              };
              if (owner === "organization") await record([key.referenceId], event);
              else await forUser(key.referenceId, event);
            } else if (path === "/api-key/delete") {
              const holder = ctx.request ?? ctx.headers;
              const key = holder ? deleting.get(holder) : undefined;
              if (!key) return;
              const keyId = typeof ctx.body?.keyId === "string" ? ctx.body.keyId : null;
              const owner = key.configId === "org" ? "organization" : "user";
              const event = {
                action: "api_key.revoked" as const,
                actor: actor ?? { type: "system" as const },
                target: { type: "api_key" as const, id: keyId, name: key.name },
                detail: { owner, count: 1 } as const,
              };
              if (owner === "organization") await record([key.referenceId], event);
              else await forUser(key.referenceId, event);
            }
          }),
        },
      ],
    },
  });

  return { record, forUser, orgsOf, userNamed, requestFacts, plugin };
}

export type AuthAudit = ReturnType<typeof authAudit>;

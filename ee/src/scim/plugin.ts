/**
 * Directory sync in the auth server: `@better-auth/scim` with plugin-managed connections, one per workspace (the
 * workspace is its provisioning domain), and OpenDash's rules:
 *  - **Who** may be added: only people at the workspace's verified single sign-on domains, so a directory can't claim
 *    strangers. Someone with an account there is linked (their profile stays theirs); anyone else is created,
 *    verified, with no password: they sign in through single sign-on.
 *  - **Roles** come from groups (scim_group_role): admin, member or viewer, the highest a person's groups give. Someone the
 *    directory adds in no mapped group is a viewer. It changes only roles it gave (scim_member_role): a role set by
 *    hand stays until a mapped group says otherwise, and leaving a mapped group takes away only what it gave. Owner is
 *    never given and never changed.
 *  - **Deprovisioning** (`active: false`, or deleted) ends the membership as removing a member does. The last owner is
 *    kept (and the row says so), so a directory can't leave a workspace without one. Someone no directory still has as
 *    active loses their sessions too (the plugin does that, even for a kept owner, who can sign in again). A person
 *    is in one workspace's directory at most: their domain is one workspace's.
 * Each change is audited after its transaction commits, as the directory.
 */
import { queueAfterTransactionHook } from "@better-auth/core/context";
import { scim } from "@better-auth/scim";
import type { AuthCore, AuthExtension } from "@opendash/auth";
import { isOwnerRole } from "@opendash/auth";
import type { ScimRole } from "@opendash/core/enterprise";
import type { AuthDatabase } from "@opendash/db/auth";
import { authTables as t } from "@opendash/db/auth";
import type { BetterAuthPlugin, DBTransactionAdapter } from "better-auth";
import { APIError } from "better-auth/api";
import { and, eq, sql } from "drizzle-orm";
import { emailDomain } from "../sso/policy";

const ROLES: readonly ScimRole[] = ["viewer", "member", "admin"];
const highest = (roles: readonly string[]): ScimRole | null =>
  [...ROLES].reverse().find((r) => roles.includes(r)) ?? null;

/** Who the audit log names for what the directory did. */
export const DIRECTORY = { type: "scim" as const, name: "Directory sync" };

/** The request bodies and rate a directory gets: Okta pushes in bursts. */
export const SCIM_RATE_LIMIT = { "/scim/v2/*": { window: 60, max: 600 } };

type Member = { id: string; role: string; organizationId: string; userId: string };

/** The role the directory last gave each person (auth.scim_member_role), as a model, so it's read in the sync's own transaction. */
const GIVEN_ROLES: BetterAuthPlugin = {
  id: "opendash-scim-roles",
  schema: {
    scimMemberRole: {
      fields: {
        organizationId: { type: "string", required: true },
        userId: { type: "string", required: true },
        role: { type: "string", required: true },
        updatedAt: { type: "date", required: true },
      },
    },
  },
};

export function scimAuthExtension(deps: { database: AuthDatabase }): (core: AuthCore) => AuthExtension {
  const { db } = deps.database;

  /** A domain this workspace proved for single sign-on (its claim). */
  async function verifiedHere(orgId: string, domain: string): Promise<boolean> {
    if (!domain) return false;
    const [claim] = await db
      .select({ domain: t.ssoDomain.domain })
      .from(t.ssoDomain)
      .where(and(eq(t.ssoDomain.domain, domain), eq(t.ssoDomain.organizationId, orgId)));
    return Boolean(claim);
  }

  return (core) => {
    const after = (work: () => Promise<void>) =>
      queueAfterTransactionHook(async () => {
        await work().catch((error: unknown) => {
          console.error(
            JSON.stringify({
              msg: "directory sync follow-up failed",
              error: error instanceof Error ? error.message : "",
            }),
          );
        });
      });

    async function nameOf(database: DBTransactionAdapter, userId: string) {
      const u = (await database.findOne({ model: "user", where: [{ field: "id", value: userId }] })) as {
        name?: string;
        email?: string;
      } | null;
      return u?.name || u?.email || null;
    }

    const plugin = scim({
      connections: [],
      // The tokens are kept as HMAC digests under a key derived from the auth secret: nothing more to set up.
      managedConnections: { credentialHashSecret: core.deriveSecret("scim-credentials"), maxActiveCredentials: 2 },
      // Microsoft Entra sends a legacy Group schema marker when it creates a group.
      compatibility: { microsoftEntra: { acceptLegacyGroupSchema: true } },
      identity: {
        resolveUser: async (input) => {
          const orgId = input.provisioningDomainId;
          const email = input.resource.primaryEmail.trim().toLowerCase();
          if (!(await verifiedHere(orgId, emailDomain(email)))) {
            await core.audit.record([orgId], {
              action: "scim.refused",
              actor: DIRECTORY,
              target: { type: "user", name: email.slice(0, 200) },
              detail: { reason: "domain_not_verified" },
            });
            throw new APIError("FORBIDDEN", {
              message: "Only people at this workspace's verified single sign-on domains can be added.",
            });
          }
          const [existing] = await db
            .select({ id: t.user.id })
            .from(t.user)
            .where(sql`lower(${t.user.email}) = ${email}`)
            .limit(1);
          // At a domain the workspace proved, an address that already has an account is that person: linked, and their
          // name and address stay theirs to change.
          return existing ? { action: "link", userId: existing.id, profile: "preserve" } : { action: "create" };
        },
      },
      projection: {
        roles: {
          map: async (input) => {
            const [row] = await db
              .select({ role: t.scimGroupRole.role })
              .from(t.scimGroupRole)
              .where(
                and(
                  eq(t.scimGroupRole.organizationId, input.provisioningDomainId),
                  eq(t.scimGroupRole.groupId, input.source.id),
                ),
              );
            return row ? [row.role] : undefined;
          },
          exists: async (input) => (ROLES as readonly string[]).includes(input.role),
        },
        reconcileUser: async (state, { database }) => {
          const orgId = state.provisioningDomainId;
          const member = (await database.findOne({
            model: "member",
            where: [
              { field: "organizationId", value: orgId },
              { field: "userId", value: state.userId },
            ],
          })) as Member | null;
          if (!state.active) {
            if (!member) return;
            if (isOwnerRole(member.role)) {
              const members = (await database.findMany({
                model: "member",
                where: [{ field: "organizationId", value: orgId }],
              })) as Member[];
              if (members.filter((m) => isOwnerRole(m.role)).length <= 1) {
                const name = await nameOf(database, state.userId);
                after(() =>
                  core.audit.record([orgId], {
                    action: "scim.owner_kept",
                    actor: DIRECTORY,
                    target: { type: "user", id: state.userId, name },
                  }),
                );
                return;
              }
            }
            const name = await nameOf(database, state.userId);
            await database.delete({ model: "member", where: [{ field: "id", value: member.id }] });
            await database.deleteMany({
              model: "scimMemberRole",
              where: [
                { field: "organizationId", value: orgId },
                { field: "userId", value: state.userId },
              ],
            });
            after(async () => {
              await core.memberRemoved(orgId, state.userId);
              await core.audit.record([orgId], {
                action: "member.removed",
                actor: DIRECTORY,
                target: { type: "user", id: state.userId, name },
                detail: { role: member.role as ScimRole | "owner" },
              });
            });
            return;
          }
          // The role the directory last gave here, if any: it changes only roles it gave.
          const given = (await database.findOne({
            model: "scimMemberRole",
            where: [
              { field: "organizationId", value: orgId },
              { field: "userId", value: state.userId },
            ],
          })) as { id: string; role: string } | null;
          const remember = async (role: ScimRole) => {
            if (given) {
              await database.update({
                model: "scimMemberRole",
                where: [{ field: "id", value: given.id }],
                update: { role, updatedAt: new Date() },
              });
            } else {
              await database.create({
                model: "scimMemberRole",
                data: { organizationId: orgId, userId: state.userId, role, updatedAt: new Date() },
              });
            }
          };
          const granted = highest(state.grants.map((g) => g.role));
          const name = await nameOf(database, state.userId);
          if (!member) {
            const role = granted ?? "viewer";
            const made = (await database.create({
              model: "member",
              data: { organizationId: orgId, userId: state.userId, role, createdAt: new Date() },
            })) as Member;
            await remember(role);
            after(() =>
              core.audit.record([orgId], {
                action: "member.joined",
                actor: DIRECTORY,
                target: { type: "member", id: made.id, name },
                detail: { role },
              }),
            );
            return;
          }
          // Owner is given and taken by hand only.
          if (isOwnerRole(member.role)) return;
          // A mapped group decides. With none, a role the directory gave falls back to viewer; one set by hand stays.
          const role = granted ?? (given && given.role === member.role ? "viewer" : null);
          if (!role) return;
          if (role !== given?.role) await remember(role);
          if (role === member.role) return;
          await database.update({ model: "member", where: [{ field: "id", value: member.id }], update: { role } });
          after(() =>
            core.audit.record([orgId], {
              action: "member.role_changed",
              actor: DIRECTORY,
              target: { type: "user", id: state.userId, name },
              fields: ["role"],
              detail: { from: member.role as ScimRole, to: role },
            }),
          );
        },
      },
    }) as unknown as BetterAuthPlugin;

    return {
      plugins: [plugin, GIVEN_ROLES],
      rateLimitRules: SCIM_RATE_LIMIT,
      // The plugin creates the person (POST /Users) through Better Auth's registration gate: the directory vouches
      // for someone at the workspace's verified domain, as single sign-on does, so they can sign in through it.
      vouchForNewUser: async (user, context) => {
        const ctx = context as { path?: string; context?: { scimConnection?: { provisioningDomainId?: string } } };
        if (ctx?.path !== "/scim/v2/Users") return null;
        const orgId = ctx.context?.scimConnection?.provisioningDomainId;
        if (!orgId || !(await verifiedHere(orgId, emailDomain(user.email)))) return null;
        return { emailVerified: true };
      },
    };
  };
}

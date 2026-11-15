/**
 * Directory sync's settings: one connection per workspace, made, rotated and disconnected here through the plugin's
 * server-only endpoints (never reachable over HTTP), and the groups' roles.
 *  - Connecting needs a verified single sign-on domain: only people there are added.
 *  - A token is shown once and lasts a year. A new one ends the old ones at once.
 *  - Disconnecting revokes every token: nobody is added or removed until a new one, and people already added stay.
 *    (The plugin's own decommission would reconcile everyone as gone; that's not what disconnecting means here.)
 *  - Connecting and mapping groups need a license in production; a new token and disconnecting don't: they only take
 *    a directory's access away.
 * Each change is audited right after it, as the acting member.
 */
import { type AuditEvent, audit } from "@opendash/core";
import type { Enterprise, EnterpriseScim, ScimRole, SsoCaller } from "@opendash/core/enterprise";
import { sql, type TenantTx, uuidv7, uuidv7Floor } from "@opendash/db";
import type { AuthDatabase } from "@opendash/db/auth";
import { authTables as t } from "@opendash/db/auth";
import { and, eq } from "drizzle-orm";

const SCOPES = ["scim.users.read", "scim.users.write", "scim.groups.read", "scim.groups.write"] as const;
const TOKEN_DAYS = 365;
const MANAGERS = new Set(["owner", "admin"]);
const isManager = (role: string) => role.split(",").some((r) => MANAGERS.has(r.trim()));

const fail = (code: string, message: string): { ok: false; code: string; message: string } => ({
  ok: false,
  code,
  message,
});

interface Connection {
  connectionId: string;
  status: string;
}
interface Credential {
  credentialId: string;
  status: string;
  createdAt: string | Date;
  expiresAt: string | Date;
  lastUsedAt: string | Date | null;
}

export interface ScimManageDeps {
  database: AuthDatabase;
  auth: () => { api: unknown };
  tenant: <T>(ctx: { orgId: string; userId: string }, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  gate: () => Pick<Enterprise, "canChange">;
  origin: string;
}

const iso = (d: string | Date | null) => (d ? new Date(d).toISOString() : null);

export function scimManager(deps: ScimManageDeps): EnterpriseScim {
  const { db } = deps.database;

  /** The plugin's server-only endpoints by name. */
  const plugin = (name: string) => {
    const endpoint = (deps.auth().api as Record<string, unknown>)[name];
    if (typeof endpoint !== "function") throw new Error(`The SCIM plugin has no ${name} endpoint`);
    return async <T>(body: Record<string, unknown>) =>
      (await (endpoint as (i: unknown) => Promise<unknown>)({ body })) as T;
  };

  async function recordFor(caller: SsoCaller, event: AuditEvent) {
    try {
      await deps.tenant({ orgId: caller.orgId, userId: caller.userId }, (tx) => audit(tx, event));
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "audit row not written",
          action: event.action,
          error: error instanceof Error ? error.message : "",
        }),
      );
    }
  }

  /** The workspace's connection (the one not decommissioned), and its credentials. */
  async function current(orgId: string): Promise<{ connection: Connection; credentials: Credential[] } | null> {
    const { connections } = await plugin("listSCIMManagedConnections")<{ connections: Connection[] }>({
      provisioningDomainId: orgId,
    });
    const connection = connections.find((c) => c.status === "active");
    if (!connection) return null;
    const state = await plugin("getSCIMManagedConnection")<{ connection: Connection; credentials: Credential[] }>({
      connectionId: connection.connectionId,
      provisioningDomainId: orgId,
    });
    return { connection, credentials: state.credentials ?? [] };
  }

  const live = (c: Credential) => c.status === "active" && new Date(c.expiresAt).getTime() > Date.now();

  async function revokeAll(orgId: string, userId: string, connectionId: string, keep?: string): Promise<number> {
    const state = await current(orgId);
    let revoked = 0;
    for (const credential of state?.credentials.filter(live) ?? []) {
      if (credential.credentialId === keep) continue;
      await plugin("revokeSCIMManagedCredential")({
        connectionId,
        provisioningDomainId: orgId,
        credentialId: credential.credentialId,
        actorId: userId,
      });
      revoked += 1;
    }
    return revoked;
  }

  const domainsOf = async (orgId: string) =>
    (
      await db.select({ domain: t.ssoDomain.domain }).from(t.ssoDomain).where(eq(t.ssoDomain.organizationId, orgId))
    ).map((r) => r.domain);

  const expiry = () => new Date(Date.now() + TOKEN_DAYS * 86_400_000);

  return {
    async status(caller) {
      const [state, domains] = await Promise.all([current(caller.orgId), domainsOf(caller.orgId)]);
      const token = state?.credentials.filter(live).sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
      const groups = await db.execute<{ id: string; name: string; members: number; role: ScimRole | null }>(sql`
        select g.id, g.display_name as name,
               (select count(*)::int from auth.scim_group_member m where m.group_id = g.id) as members, r.role
        from auth.scim_group g
        left join auth.scim_group_role r on r.group_id = g.id and r.organization_id = ${caller.orgId}
        where g.provisioning_domain_id = ${caller.orgId}
        order by lower(g.display_name)
        limit 200`);
      const [{ people } = { people: 0 }] = await db.execute<{ people: number }>(sql`
        select count(*)::int as people from auth.scim_user where provisioning_domain_id = ${caller.orgId} and active`);
      const recent = await deps.tenant({ orgId: caller.orgId, userId: caller.userId }, (tx) =>
        tx.execute<{ at: string; action: string; target: string | null; detail: Record<string, unknown> }>(sql`
          select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as at, action,
                 target_name as target, detail
          from app.audit_log
          where org_id = ${caller.orgId} and (actor_type = 'scim' or action like 'scim.%')
            and id >= ${uuidv7Floor(new Date(Date.now() - 30 * 86_400_000))}::uuid
          order by id desc limit 10`),
      );
      return {
        baseUrl: `${deps.origin}/api/auth/scim/v2`,
        connected: Boolean(token),
        token: token
          ? {
              createdAt: iso(token.createdAt) ?? "",
              expiresAt: iso(token.expiresAt) ?? "",
              lastUsedAt: iso(token.lastUsedAt),
            }
          : null,
        domains,
        groups: groups.map((g) => ({ groupId: g.id, name: g.name, members: g.members, role: g.role })),
        people,
        recent: [...recent],
      };
    },

    async connect(caller) {
      if (!deps.gate().canChange("scim"))
        return fail("LICENSE_REQUIRED", "Directory sync needs an Enterprise license.");
      if (!isManager(caller.role)) return fail("FORBIDDEN", "Only owners and admins can connect a directory.");
      if (!(await domainsOf(caller.orgId)).length) {
        return fail("NO_DOMAIN", "Verify your domain in Single sign-on first: only people there are added.");
      }
      const state = await current(caller.orgId);
      if (state?.credentials.some(live))
        return fail("CONNECTED", "A directory is connected. Make a new token instead.");
      const expiresAt = expiry();
      let token: string;
      if (state) {
        // Disconnected earlier: the same connection (its people and groups) gets a new token.
        ({ token } = await plugin("rotateSCIMManagedCredential")<{ token: string }>({
          connectionId: state.connection.connectionId,
          provisioningDomainId: caller.orgId,
          actorId: caller.userId,
          scopes: SCOPES,
          expiresAt,
        }));
      } else {
        ({ token } = await plugin("createSCIMManagedConnection")<{ token: string }>({
          creationRequestId: uuidv7(),
          provisioningDomainId: caller.orgId,
          actorId: caller.userId,
          scopes: SCOPES,
          expiresAt,
        }));
      }
      await recordFor(caller, {
        action: "scim.connected",
        target: { type: "scim_connection", name: "Directory" },
        detail: { expiresInDays: TOKEN_DAYS },
      });
      return { ok: true, value: { token, expiresAt: expiresAt.toISOString() } };
    },

    async rotate(caller) {
      if (!isManager(caller.role)) return fail("FORBIDDEN", "Only owners and admins can make a directory token.");
      const state = await current(caller.orgId);
      if (!state) return fail("NOT_CONNECTED", "No directory is connected.");
      const expiresAt = expiry();
      const made = await plugin("rotateSCIMManagedCredential")<{ token: string; credential: Credential }>({
        connectionId: state.connection.connectionId,
        provisioningDomainId: caller.orgId,
        actorId: caller.userId,
        scopes: SCOPES,
        expiresAt,
      });
      // The plugin keeps the old token working beside the new one; here a new token means the old one stops.
      const revoked = await revokeAll(
        caller.orgId,
        caller.userId,
        state.connection.connectionId,
        made.credential.credentialId,
      );
      await recordFor(caller, {
        action: "scim.token_rotated",
        target: { type: "scim_connection", name: "Directory" },
        fields: ["token"],
        detail: { expiresInDays: TOKEN_DAYS, ended: revoked },
      });
      return { ok: true, value: { token: made.token, expiresAt: expiresAt.toISOString() } };
    },

    async disconnect(caller) {
      if (!isManager(caller.role)) return fail("FORBIDDEN", "Only owners and admins can disconnect the directory.");
      const state = await current(caller.orgId);
      if (!state) return fail("NOT_CONNECTED", "No directory is connected.");
      const revoked = await revokeAll(caller.orgId, caller.userId, state.connection.connectionId);
      await recordFor(caller, {
        action: "scim.disconnected",
        target: { type: "scim_connection", name: "Directory" },
        detail: { ended: revoked },
      });
      return { ok: true, value: { tokensRevoked: revoked } };
    },

    async mapGroup(caller, groupId, role) {
      if (!deps.gate().canChange("scim"))
        return fail("LICENSE_REQUIRED", "Mapping groups needs an Enterprise license.");
      if (!isManager(caller.role)) return fail("FORBIDDEN", "Only owners and admins can map groups.");
      if (role !== null && !["admin", "member", "viewer"].includes(role)) return fail("INVALID", "That isn't a role.");
      const [group] = await db
        .select({ id: t.scimGroup.id, name: t.scimGroup.displayName })
        .from(t.scimGroup)
        .where(and(eq(t.scimGroup.id, groupId), eq(t.scimGroup.provisioningDomainId, caller.orgId)));
      if (!group) return fail("NOT_FOUND", "There's no such group from your directory.");
      if (role) {
        await db
          .insert(t.scimGroupRole)
          .values({ organizationId: caller.orgId, groupId, role, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [t.scimGroupRole.organizationId, t.scimGroupRole.groupId],
            set: { role, updatedAt: new Date() },
          });
      } else {
        await db
          .delete(t.scimGroupRole)
          .where(and(eq(t.scimGroupRole.organizationId, caller.orgId), eq(t.scimGroupRole.groupId, groupId)));
      }
      await recordFor(caller, {
        action: "scim.mapping_updated",
        target: { type: "scim_group", id: groupId, name: group.name },
        fields: ["role"],
        detail: { role: role ?? "none" },
      });
      // Applied to the group's people now, not at the directory's next push.
      await plugin("reconcileSCIMProjection")({ provisioningDomainId: caller.orgId });
      return { ok: true, value: null };
    },
  };
}

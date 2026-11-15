/**
 * Deleting a workspace, and deleting an account (the erasure a person can ask for). Better Auth's own endpoints for
 * both stay off: its organization delete removed every member and then failed on the product's rows, leaving the
 * workspace's keys working. These are the only way either happens.
 *
 * A workspace goes in one statement: deleting its auth.organization row takes its members, invitations, teams and
 * identity providers (Better Auth's tables) and, through app.org's foreign key, every tenant table's rows. Nobody
 * can sign in to half of one. What no foreign key reaches (its event and query history, its queued jobs) is purged
 * by the worker from the record a trigger writes in the same transaction (`@opendash/db`'s org-deletion).
 *
 * An account goes with everything that is the person's alone: their sign-ins, sessions, two-factor, API keys and
 * memberships, a workspace only they were in, and in each workspace they leave what a departing member loses (the
 * `memberRemoved` hook). What they made inside a shared workspace is that workspace's, and stays, under an id that no
 * longer names anyone. Someone who is the only owner of a workspace others are in can't go until it has another
 * owner or is deleted: nobody else could run it.
 */

import { auditSystem, loggableError } from "@opendash/core";
import { isUuid, withSystem } from "@opendash/db";
import { type AuthDatabase, authTables as t } from "@opendash/db/auth";
import { verifyPassword } from "better-auth/crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { isOwnerRole, revokeOrgKeys, revokeUserKeys } from "./keys";
import type { SystemRunner } from "./provision";

type Db = AuthDatabase["db"];
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Directory sync's tables (ee/) carry the organization as their provisioning domain, with no foreign key to it. */
const DIRECTORY_TABLES = ["scim_user", "scim_group", "scim_managed_connection", "scim_connection_binding"] as const;

async function deleteOrganizationIn(tx: Tx, orgId: string): Promise<boolean> {
  await revokeOrgKeys(tx, orgId);
  for (const table of DIRECTORY_TABLES) {
    await tx.execute(sql`delete from auth.${sql.identifier(table)} where provisioning_domain_id = ${orgId}`);
  }
  const gone = await tx.delete(t.organization).where(eq(t.organization.id, orgId)).returning({ id: t.organization.id });
  return gone.length > 0;
}

/**
 * Deletes a workspace and everything in it, at once. False when there's no such workspace (deleted already): asking
 * twice is safe. The caller has checked who's asking (an owner); this checks nothing about them.
 */
export async function deleteOrganization(database: AuthDatabase, orgId: string): Promise<boolean> {
  if (!isUuid(orgId)) return false;
  return database.db.transaction((tx) => deleteOrganizationIn(tx, orgId));
}

export interface AccountWorkspace {
  id: string;
  name: string;
  role: string;
  members: number;
  owners: number;
}

/** What deleting an account would do to each workspace the person is in. */
export interface AccountDeletionPlan {
  /** Only they are in it: it's deleted with the account. */
  deleted: AccountWorkspace[];
  /** Others stay in it, and it keeps an owner: they leave it. */
  left: AccountWorkspace[];
  /** They're its only owner and others are in it: the account can't be deleted until that changes. */
  blocking: AccountWorkspace[];
}

async function planIn(db: Pick<Db, "execute">, userId: string): Promise<AccountDeletionPlan> {
  const rows = await db.execute<{ id: string; name: string; role: string; members: number; owners: number }>(sql`
    select o.id::text as id, o.name, m.role,
           (select count(*)::int from auth.member x where x.organization_id = o.id) as members,
           (select count(*)::int from auth.member x where x.organization_id = o.id
              and 'owner' = any(string_to_array(replace(coalesce(x.role, ''), ' ', ''), ','))) as owners
    from auth.member m join auth.organization o on o.id = m.organization_id
    where m.user_id = ${userId}::uuid
    order by o.name`);
  const plan: AccountDeletionPlan = { deleted: [], left: [], blocking: [] };
  for (const w of [...rows]) {
    if (w.members <= 1) plan.deleted.push(w);
    else if (isOwnerRole(w.role) && w.owners <= 1) plan.blocking.push(w);
    else plan.left.push(w);
  }
  return plan;
}

/** What deleting this account would do, to show before it's confirmed. */
export async function accountDeletionPlan(database: AuthDatabase, userId: string): Promise<AccountDeletionPlan> {
  if (!isUuid(userId)) return { deleted: [], left: [], blocking: [] };
  return planIn(database.db, userId);
}

export type AccountDeletion =
  | { deleted: true; plan: AccountDeletionPlan }
  | { deleted: false; reason: "not_found" }
  | { deleted: false; reason: "sole_owner"; plan: AccountDeletionPlan };

/**
 * Deletes an account. In one transaction: the plan is read again under a lock on the person's memberships (so a
 * workspace can't lose its last owner to two people leaving at once), their keys and pending challenges go, the
 * workspaces only they were in are deleted, and their user row takes the rest (sign-ins, sessions, two-factor,
 * memberships). `memberRemoved` then runs for each workspace they left, as it does when a member is removed: it's
 * the product's part (their routines, their own connections), and a failure there is the caller's to log, the
 * account is gone either way.
 */
export async function deleteAccount(
  database: AuthDatabase,
  userId: string,
  hooks: {
    memberRemoved?: (orgId: string, userId: string) => Promise<void>;
    /** Writes the audit rows (as the system role); the default is the deployment's. */
    system?: SystemRunner;
  } = {},
): Promise<AccountDeletion> {
  if (!isUuid(userId)) return { deleted: false, reason: "not_found" };
  const result = await database.db.transaction(async (tx): Promise<AccountDeletion> => {
    const [user] = await tx.select({ id: t.user.id, email: t.user.email }).from(t.user).where(eq(t.user.id, userId));
    if (!user) return { deleted: false, reason: "not_found" };
    // Every membership of the workspaces they're in, locked: who owns what can't change under the plan.
    await tx.execute(sql`
      select 1 from auth.member where organization_id in (
        select organization_id from auth.member where user_id = ${userId}::uuid)
      order by id for update`);
    const plan = await planIn(tx, userId);
    if (plan.blocking.length) return { deleted: false, reason: "sole_owner", plan };

    await revokeUserKeys(tx, userId);
    // An owner leaving ends the workspace's keys, as it does when one is removed (keys.ts).
    for (const w of plan.left) if (isOwnerRole(w.role)) await revokeOrgKeys(tx, w.id);
    for (const w of plan.deleted) await deleteOrganizationIn(tx, w.id);
    // Links and challenges under way: rows that hold their id, or were sent to their address.
    await tx
      .delete(t.verification)
      .where(
        or(
          eq(t.verification.value, userId),
          sql`position(lower(${user.email}) in lower(${t.verification.value})) > 0`,
          sql`position(lower(${user.email}) in lower(${t.verification.identifier})) > 0`,
        ),
      );
    // Invitations still waiting for this address, in any workspace.
    await tx
      .delete(t.invitation)
      .where(and(sql`lower(${t.invitation.email}) = lower(${user.email})`, eq(t.invitation.status, "pending")));
    const left = plan.left.map((w) => w.id);
    if (left.length) {
      await tx.delete(t.member).where(and(eq(t.member.userId, userId), inArray(t.member.organizationId, left)));
    }
    await tx.delete(t.user).where(eq(t.user.id, userId));
    return { deleted: true, plan };
  });
  if (result.deleted) {
    const system = hooks.system ?? withSystem;
    for (const w of result.plan.left) {
      // Each workspace they left records it, with no name: the account it named is gone.
      await system((tx) =>
        auditSystem(tx, w.id, {
          action: "member.left",
          actor: { type: "user", id: userId, name: "A deleted account" },
          detail: { role: (isOwnerRole(w.role) ? "owner" : w.role) as never },
        }),
      ).catch((error: unknown) => {
        console.error(
          JSON.stringify({ msg: "audit row not written", action: "member.left", error: loggableError(error) }),
        );
      });
      await hooks.memberRemoved?.(w.id, userId);
    }
  }
  return result;
}

/**
 * Whether this is the account's password, for confirming something that can't be undone: "none" when the account
 * has no password (someone who only signs in through their identity provider), who confirms another way.
 */
export async function confirmPassword(
  database: AuthDatabase,
  userId: string,
  password: string,
): Promise<"ok" | "wrong" | "none"> {
  if (!isUuid(userId)) return "wrong";
  const [credential] = await database.db
    .select({ hash: t.account.password })
    .from(t.account)
    .where(and(eq(t.account.userId, userId), eq(t.account.providerId, "credential")))
    .limit(1);
  if (!credential?.hash) return "none";
  if (typeof password !== "string" || !password || password.length > 256) return "wrong";
  return (await verifyPassword({ hash: credential.hash, password })) ? "ok" : "wrong";
}

/** What OpenDash holds about an account outside any workspace's data: for the person's own export. */
export interface AccountExport {
  account: { id: string; name: string; email: string; emailVerified: boolean; twoFactor: boolean; createdAt: string };
  /** How they sign in: a password, an identity provider. Never the credential itself. */
  signIns: { provider: string; since: string }[];
  sessions: { createdAt: string; expiresAt: string; ip: string | null; userAgent: string | null }[];
  workspaces: { id: string; name: string; role: string; since: string }[];
  /** Their API keys by name and dates. Never the key. */
  apiKeys: { name: string | null; createdAt: string; expiresAt: string | null; lastUsedAt: string | null }[];
}

export async function accountExport(database: AuthDatabase, userId: string): Promise<AccountExport | null> {
  if (!isUuid(userId)) return null;
  const db = database.db;
  const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
  const [user] = await db.select().from(t.user).where(eq(t.user.id, userId)).limit(1);
  if (!user) return null;
  const [accounts, sessions, members, keys] = await Promise.all([
    db
      .select({ provider: t.account.providerId, since: t.account.createdAt })
      .from(t.account)
      .where(eq(t.account.userId, userId)),
    db
      .select({
        createdAt: t.session.createdAt,
        expiresAt: t.session.expiresAt,
        ip: t.session.ipAddress,
        userAgent: t.session.userAgent,
      })
      .from(t.session)
      .where(eq(t.session.userId, userId)),
    db
      .select({ id: t.organization.id, name: t.organization.name, role: t.member.role, since: t.member.createdAt })
      .from(t.member)
      .innerJoin(t.organization, eq(t.organization.id, t.member.organizationId))
      .where(eq(t.member.userId, userId)),
    db
      .select({
        name: t.apikey.name,
        createdAt: t.apikey.createdAt,
        expiresAt: t.apikey.expiresAt,
        lastUsedAt: t.apikey.lastRequest,
      })
      .from(t.apikey)
      .where(and(eq(t.apikey.configId, "user"), eq(t.apikey.referenceId, userId))),
  ]);
  return {
    account: {
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: Boolean(user.emailVerified),
      twoFactor: Boolean(user.twoFactorEnabled),
      createdAt: iso(user.createdAt) ?? "",
    },
    signIns: accounts.map((a) => ({ provider: a.provider, since: iso(a.since) ?? "" })),
    sessions: sessions.map((s) => ({
      createdAt: iso(s.createdAt) ?? "",
      expiresAt: iso(s.expiresAt) ?? "",
      ip: s.ip ?? null,
      userAgent: s.userAgent ?? null,
    })),
    workspaces: members.map((m) => ({
      id: m.id,
      name: m.name,
      role: m.role ?? "member",
      since: iso(m.since) ?? "",
    })),
    apiKeys: keys.map((k) => ({
      name: k.name ?? null,
      createdAt: iso(k.createdAt) ?? "",
      expiresAt: iso(k.expiresAt),
      lastUsedAt: iso(k.lastUsedAt),
    })),
  };
}

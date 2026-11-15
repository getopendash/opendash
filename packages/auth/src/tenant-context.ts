import { isUuid, type TenantCtx } from "@opendash/db";
import { type AuthDatabase, authTables } from "@opendash/db/auth";
import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Auth } from "./auth";

/**
 * Entry paths:
 *   - web session: the session's active organization, after a membership check;
 *   - org-owned API key (odo_…): acts as the organization;
 *   - user-owned API key (odu_…): acts as the user in the org named by X-Org-Id, after a membership check.
 * Anything else resolves to null. Callers turn the result into withTenant(ctx, …).
 */
export type TenantPrincipal =
  | { kind: "session"; ctx: TenantCtx; role: string }
  | { kind: "org_api_key"; ctx: TenantCtx; keyId: string }
  | { kind: "user_api_key"; ctx: TenantCtx; keyId: string; role: string };

export class TenantAccessDenied extends Error {
  override name = "TenantAccessDenied";
}

async function membership(database: AuthDatabase, userId: string, orgId: string): Promise<string | null> {
  const [row] = await database.db
    .select({ role: authTables.member.role })
    .from(authTables.member)
    .where(and(eq(authTables.member.userId, userId), eq(authTables.member.organizationId, orgId)))
    .limit(1);
  return row?.role ?? null;
}

/**
 * Where a browser request stands, for routing the web app:
 *   - signed-out: send to sign-in;
 *   - needs-password: opened an email link but hasn't chosen a password yet;
 *   - needs-organization: signed in with no workspace, or a pending invitation to accept;
 *   - tenant: in a workspace, after the same membership check as resolveTenant.
 */
export type Viewer =
  | { kind: "signed-out" }
  | { kind: "needs-password"; user: ViewerUser }
  | { kind: "needs-organization"; user: ViewerUser; pendingInvitationId: string | null }
  /** The session's active organization isn't theirs any more (they were removed): never treated as its tenant. */
  | { kind: "left-organization"; user: ViewerUser }
  | { kind: "tenant"; user: ViewerUser; ctx: TenantCtx; role: string };

export interface ViewerUser {
  id: string;
  email: string;
  name: string;
}

export async function resolveViewer(auth: Auth, database: AuthDatabase, headers: Headers): Promise<Viewer> {
  const session = await auth.api.getSession({ headers });
  if (!session) return { kind: "signed-out" };
  const user = { id: session.user.id, email: session.user.email, name: session.user.name };
  const t = authTables;

  // A password, or any sign-in method other than a password (SSO later), means the account is set up.
  const accounts = await database.db
    .select({ providerId: t.account.providerId, password: t.account.password })
    .from(t.account)
    .where(eq(t.account.userId, user.id));
  if (!accounts.some((a) => a.providerId !== "credential" || a.password)) return { kind: "needs-password", user };

  let orgId = session.session.activeOrganizationId ?? null;
  if (!orgId) {
    const [first] = await database.db
      .select({ orgId: t.member.organizationId })
      .from(t.member)
      .where(eq(t.member.userId, user.id))
      .orderBy(asc(t.member.createdAt))
      .limit(1);
    orgId = first?.orgId ?? null;
  }
  if (!orgId) {
    const [invitation] = await database.db
      .select({ id: t.invitation.id })
      .from(t.invitation)
      .where(
        and(
          eq(t.invitation.status, "pending"),
          gt(t.invitation.expiresAt, new Date()),
          sql`lower(${t.invitation.email}) = ${user.email.toLowerCase()}`,
        ),
      )
      .orderBy(desc(t.invitation.createdAt))
      .limit(1);
    return { kind: "needs-organization", user, pendingInvitationId: invitation?.id ?? null };
  }
  const role = await membership(database, user.id, orgId);
  // Removed from it, or it was deleted: the web app says so and moves the session on (the API refuses, 403).
  if (!role) return { kind: "left-organization", user };
  return { kind: "tenant", user, ctx: { orgId, userId: user.id }, role };
}

/** What an invitation link shows before anyone signs in: enough to recognise it, nothing more. */
export interface InvitationPreview {
  id: string;
  email: string;
  role: string;
  organization: { id: string; name: string; slug: string; members: number };
  inviter: { name: string; email: string };
}

export async function invitationPreview(database: AuthDatabase, id: string): Promise<InvitationPreview | null> {
  if (!isUuid(id)) return null;
  const t = authTables;
  const [row] = await database.db
    .select({
      id: t.invitation.id,
      email: t.invitation.email,
      role: t.invitation.role,
      orgId: t.organization.id,
      orgName: t.organization.name,
      slug: t.organization.slug,
      inviterName: t.user.name,
      inviterEmail: t.user.email,
    })
    .from(t.invitation)
    .innerJoin(t.organization, eq(t.organization.id, t.invitation.organizationId))
    .innerJoin(t.user, eq(t.user.id, t.invitation.inviterId))
    .where(and(eq(t.invitation.id, id), eq(t.invitation.status, "pending"), gt(t.invitation.expiresAt, new Date())))
    .limit(1);
  if (!row) return null;
  const [count] = await database.db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.member)
    .where(eq(t.member.organizationId, row.orgId));
  return {
    id: row.id,
    email: row.email,
    role: row.role ?? "member",
    organization: { id: row.orgId, name: row.orgName, slug: row.slug ?? "", members: count?.n ?? 0 },
    inviter: { name: row.inviterName, email: row.inviterEmail },
  };
}

export async function resolveTenant(
  auth: Auth,
  database: AuthDatabase,
  headers: Headers,
): Promise<TenantPrincipal | null> {
  const apiKey = headers.get("x-api-key");
  if (apiKey) {
    const configId = apiKey.startsWith("odo_") ? "org" : apiKey.startsWith("odu_") ? "user" : null;
    if (!configId) throw new TenantAccessDenied("Unknown API key type");
    const result = await auth.api.verifyApiKey({ body: { key: apiKey, configId } });
    if (!result.valid || !result.key) throw new TenantAccessDenied("Invalid API key");
    const { id: keyId, referenceId } = result.key;
    if (configId === "org") return { kind: "org_api_key", ctx: { orgId: referenceId, userId: null }, keyId };

    const orgId = headers.get("x-org-id");
    if (!orgId || !isUuid(orgId)) throw new TenantAccessDenied("User API keys need an X-Org-Id header");
    const role = await membership(database, referenceId, orgId);
    if (!role) throw new TenantAccessDenied("Not a member of that organization");
    return { kind: "user_api_key", ctx: { orgId, userId: referenceId }, keyId, role };
  }

  const session = await auth.api.getSession({ headers });
  if (!session) return null;
  const orgId = session.session.activeOrganizationId;
  if (!orgId) throw new TenantAccessDenied("No active organization");
  // Defence in depth: the organization plugin checks membership when the active org is set; check it again.
  const role = await membership(database, session.user.id, orgId);
  if (!role) throw new TenantAccessDenied("Not a member of the active organization");
  return { kind: "session", ctx: { orgId, userId: session.user.id }, role };
}

/** The organizations someone belongs to, by name: the workspace switcher's list. */
export async function memberships(
  database: AuthDatabase,
  userId: string,
): Promise<{ id: string; name: string; slug: string }[]> {
  if (!isUuid(userId)) return [];
  const t = authTables;
  const rows = await database.db
    .select({ id: t.organization.id, name: t.organization.name, slug: t.organization.slug })
    .from(t.member)
    .innerJoin(t.organization, eq(t.organization.id, t.member.organizationId))
    .where(eq(t.member.userId, userId))
    .orderBy(asc(t.organization.name));
  return rows.map((o) => ({ id: o.id, name: o.name, slug: o.slug ?? "" }));
}

/** How many members an organization has. */
export async function memberCount(database: AuthDatabase, orgId: string): Promise<number> {
  if (!isUuid(orgId)) return 0;
  const t = authTables;
  const [row] = await database.db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.member)
    .where(eq(t.member.organizationId, orgId));
  return row?.n ?? 0;
}

/**
 * Whether anyone has an account yet. An invite-only instance takes one sign-up while nobody has (its first account),
 * and keeps its sign-up page open until then.
 */
export async function anyAccount(database: AuthDatabase): Promise<boolean> {
  const [anyone] = await database.db.select({ id: authTables.user.id }).from(authTables.user).limit(1);
  return Boolean(anyone);
}

/**
 * The names of an organization's members, by user id. Only members of that organization are returned, so a user id
 * from elsewhere names nobody. Lets the app show who shared a conversation (the app role can't read auth tables).
 */
export async function memberNames(
  database: AuthDatabase,
  orgId: string,
  userIds: string[],
  options: { emailWhenNameless?: boolean } = {},
): Promise<Record<string, string>> {
  const ids = userIds.filter(isUuid);
  if (!isUuid(orgId) || !ids.length) return {};
  const t = authTables;
  const rows = await database.db
    .select({ id: t.user.id, name: t.user.name, email: t.user.email })
    .from(t.member)
    .innerJoin(t.user, eq(t.user.id, t.member.userId))
    .where(and(eq(t.member.organizationId, orgId), inArray(t.member.userId, ids)));
  // Someone who signed up by an email link may have no name: inside the workspace their address stands in; for an
  // outsider (a public link) `emailWhenNameless: false` names nobody instead.
  const fallback = options.emailWhenNameless ?? true;
  return Object.fromEntries(
    rows.flatMap((r) => (r.name.trim() ? [[r.id, r.name]] : fallback ? [[r.id, r.email]] : [])),
  );
}

/** A member of the workspace as a picker shows them: their name (their address when they have none) and role. */
export interface OrgPerson {
  id: string;
  name: string;
  email: string;
  role: string;
}

/**
 * Everyone in the workspace, by name, at most 500: who a record's work can be given to, and who a dashboard can be
 * shared with (found by name or address; its viewers only ever to view).
 */
export async function orgPeople(database: AuthDatabase, orgId: string): Promise<OrgPerson[]> {
  if (!isUuid(orgId)) return [];
  const t = authTables;
  const rows = await database.db
    .select({ id: t.user.id, name: t.user.name, email: t.user.email, role: t.member.role })
    .from(t.member)
    .innerJoin(t.user, eq(t.user.id, t.member.userId))
    .where(eq(t.member.organizationId, orgId))
    .limit(500);
  return rows
    .map((r) => ({ id: r.id, name: r.name.trim() || r.email, email: r.email, role: r.role }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

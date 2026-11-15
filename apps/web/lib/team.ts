import "server-only";
import { headers } from "next/headers";
import { getAuth } from "./auth";
import type { Invitation, Member, Role } from "./roles";

export * from "./roles";

/** The organization's members and pending invitations (expired ones too, to resend), through Better Auth. */
export async function teamOf(orgId: string): Promise<{ members: Member[]; invitations: Invitation[] }> {
  const org = await getAuth().api.getFullOrganization({
    query: { organizationId: orgId },
    headers: await headers(),
  });
  const members = (org?.members ?? []).map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.name,
    email: m.user.email,
    role: m.role as Role,
    joinedAt: new Date(m.createdAt).toISOString(),
  }));
  const names = new Map(members.map((m) => [m.userId, m.name || m.email]));
  const now = Date.now();
  const invitations = (org?.invitations ?? [])
    .filter((i) => i.status === "pending")
    .map((i) => ({
      id: i.id,
      email: i.email,
      role: i.role as Role,
      expiresAt: new Date(i.expiresAt).toISOString(),
      expired: new Date(i.expiresAt).getTime() <= now,
      inviterId: i.inviterId,
      inviter: names.get(i.inviterId) ?? null,
    }))
    .sort((a, b) => a.email.localeCompare(b.email));
  return { members, invitations };
}

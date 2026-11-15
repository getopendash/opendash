import "server-only";
import { listProjects, type ProjectActor } from "@opendash/core";
import { withTenant } from "@opendash/db";

/** The project actor for core: the person, and their organization role, which core can't read. */
export const actorOf = (viewer: { ctx: { orgId: string }; user: { id: string }; role: string }): ProjectActor => ({
  orgId: viewer.ctx.orgId,
  userId: viewer.user.id,
  orgRole: viewer.role,
});

/** The sidebar's projects: the ones this person is in (an admin's view of every project is All projects). */
export async function sidebarProjects(orgId: string, userId: string, orgRole: string) {
  const actor = { orgId, userId, orgRole };
  const all = await withTenant({ orgId, userId }, (tx) => listProjects(tx, actor));
  return all.filter((p) => p.role !== null).map((p) => ({ id: p.id, name: p.name }));
}

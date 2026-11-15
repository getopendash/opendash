import "server-only";
import { listProjects, listThreads } from "@opendash/core";
import { type TenantTx, withTenant } from "@opendash/db";
import { withAuthors } from "./ask";
import { actorOf } from "./projects";

const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };

/** A project's conversations this person can read, with who started each. */
export const projectThreadsFor = async (orgId: string, userId: string, projectId: string) =>
  withAuthors(orgId, await listThreads(deps, { orgId, userId }, { scope: "all", projectId, limit: 200 }));

/**
 * The projects this person can see, and which they can add to (where a conversation can move, a project's name on its
 * pages).
 */
export async function projectChoices(viewer: { ctx: { orgId: string }; user: { id: string }; role: string }) {
  const actor = actorOf(viewer);
  const all = await withTenant({ orgId: actor.orgId, userId: actor.userId }, (tx) => listProjects(tx, actor));
  return all.map((p) => ({
    id: p.id,
    name: p.name,
    canAdd: (p.role === "manager" || p.role === "editor") && viewer.role !== "viewer",
  }));
}

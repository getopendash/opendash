"use server";

import { searchWorkspace, type WorkspaceSearch } from "@opendash/core";
import { type TenantTx, withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";

/** The palette's results for the signed-in person. The query itself is never logged. */
export async function searchAction(q: string): Promise<WorkspaceSearch | null> {
  if (typeof q !== "string") return null;
  const viewer = await requireTenant();
  const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };
  return searchWorkspace(deps, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, q.slice(0, 200));
}

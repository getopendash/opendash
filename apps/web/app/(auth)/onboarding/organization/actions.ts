"use server";

import { adoptOrgTz } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";

/**
 * Just made: the workspace takes its creator's time zone, from their browser, so its routines run and its metrics are
 * checked at their hours from the start. Only while it's still the default; a zone someone chose stays.
 */
export async function adoptWorkspaceTzAction(tz: string): Promise<{ ok: boolean }> {
  if (typeof tz !== "string" || tz.length > 64) return { ok: false };
  const viewer = await requireTenant();
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  return { ok: await withTenant(viewer.ctx, (tx) => adoptOrgTz(tx, actor, tz)) };
}

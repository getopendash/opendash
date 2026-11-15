"use server";

import { refreshDefinitionChecks, releaseDraft } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";
import { queue } from "@/lib/sources";

/**
 * Releases a definition's draft from its page: the version the person saw, once its tests passed. One saved
 * meanwhile (the analyst's next) is refused, to be seen first. A dataset released over an earlier version has its
 * source's definitions tested again, so the released metrics on it read their new figures. Owners and admins.
 */
export async function releaseDraftAction(
  id: string,
  expectedVersion: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins release definitions." };
  if (!isUuid(id) || !Number.isInteger(expectedVersion)) return { ok: false, message: "That draft doesn't exist." };
  const boss = await queue();
  const r = await withTenant(viewer.ctx, async (tx) => {
    const released = await releaseDraft(
      tx,
      { orgId: viewer.ctx.orgId, userId: viewer.user.id },
      { id, expectedVersion },
    );
    if (released.ok && released.kind === "dataset") {
      await refreshDefinitionChecks({ boss }, tx, { orgId: viewer.ctx.orgId, connectionId: released.connectionId });
    }
    return released;
  });
  if (!r.ok) return { ok: false, message: r.problems.join(" ") };
  revalidatePath("/knowledge", "layout");
  revalidatePath("/", "layout");
  return { ok: true };
}

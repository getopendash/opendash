"use server";

import { discardDraft } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

/**
 * Discards a metric's or dataset's draft: it's back at its released version, as approved. Only the draft
 * the person saw: one saved meanwhile (the analyst's next) is refused, to be seen first. Owners and admins.
 */
export async function discardDraftAction(
  id: string,
  expectedVersion: number,
): Promise<{ ok: true; version: number } | { ok: false; message: string }> {
  const viewer = await requireTenant();
  if (!canVerify(viewer.role)) return { ok: false, message: "Only owners and admins discard drafts." };
  if (!isUuid(id) || !Number.isInteger(expectedVersion)) return { ok: false, message: "That draft doesn't exist." };
  const r = await withTenant(viewer.ctx, (tx) =>
    discardDraft(tx, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, { id, expectedVersion }),
  );
  if (!r.ok) return { ok: false, message: r.problems.join(" ") };
  revalidatePath("/knowledge", "layout");
  return { ok: true, version: r.version };
}

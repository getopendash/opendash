"use server";

import { DISMISS_REASONS, type DismissReason, dismissInsight } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canVerify } from "@/lib/knowledge";

type Result = { ok: true } | { ok: false; message: string };

const refresh = () => {
  revalidatePath("/insights", "layout");
  revalidatePath("/");
};

/** Dismisses an insight, with why: one of the workspace's for everyone (owners and admins), or one's own. */
export async function dismissInsightAction(id: string, reason: DismissReason): Promise<Result> {
  const viewer = await requireTenant();
  if (!isUuid(id) || !DISMISS_REASONS.includes(reason)) return { ok: false, message: "That can't be dismissed." };
  const done = await withTenant(viewer.ctx, (tx) =>
    dismissInsight(
      tx,
      { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canVerify(viewer.role) },
      id,
      reason,
    ),
  );
  if (!done) {
    return {
      ok: false,
      message: canVerify(viewer.role)
        ? "It isn't open any more."
        : "Only owners and admins dismiss the workspace's insights.",
    };
  }
  refresh();
  return { ok: true };
}

"use server";

import { unlinkMySlack } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";

/** Your own Slack account, unlinked: your next question there asks you to link again. */
export async function unlinkMySlackAction(): Promise<{ ok: true } | { ok: false; message: string }> {
  const viewer = await requireTenant();
  const userId = viewer.ctx.userId;
  if (!userId) return { ok: false, message: "Only a person links a Slack account." };
  await withTenant(viewer.ctx, (tx) => unlinkMySlack(tx, viewer.ctx.orgId, userId));
  revalidatePath("/settings/security");
  return { ok: true };
}

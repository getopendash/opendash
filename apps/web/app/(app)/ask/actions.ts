"use server";

import { setThreadStar } from "@opendash/core";
import { isUuid, type TenantTx, withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";

const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };

/** The conversations list's star: marks or unmarks a conversation the signed-in person can read, for their Starred list. */
export async function starThreadAction(
  threadId: string,
  starred: boolean,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isUuid(threadId) || typeof starred !== "boolean") return { ok: false, message: "That can't be starred." };
  const viewer = await requireTenant();
  try {
    if (await setThreadStar(deps, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, threadId, starred)) {
      return { ok: true };
    }
    return { ok: false, message: "That conversation isn't there any more." };
  } catch (error) {
    console.error(JSON.stringify({ msg: "star failed", error: String(error) }));
    return { ok: false, message: "Couldn't save the star. Try again." };
  }
}

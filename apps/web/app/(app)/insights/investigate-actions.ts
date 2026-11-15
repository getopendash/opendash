"use server";

import { deploymentKeys, startInvestigation } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/auth";
import { canAsk } from "@/lib/roles";
import { queue } from "@/lib/sources";

type Result = { ok: true; status: string } | { ok: false; message: string };

/**
 * Investigate on an insight: starts its investigation as background work, within the month's
 * background budget (held, saying why, when it's spent). Anyone who can ask.
 */
export async function investigateInsightAction(insightId: string): Promise<Result> {
  const viewer = await requireTenant();
  if (!canAsk(viewer.role)) return { ok: false, message: "Your role can't start investigations." };
  if (!isUuid(insightId)) return { ok: false, message: "That insight doesn't exist." };
  const out = await startInvestigation(
    { withTenant: (orgId, fn) => withTenant({ orgId }, fn), boss: await queue(), deploymentKeys: deploymentKeys() },
    { orgId: viewer.ctx.orgId, insightId, requestedBy: viewer.user.id },
  );
  revalidatePath("/insights");
  if (out.status === "not_investigable")
    return { ok: false, message: "Only an open insight about a metric's change can be investigated." };
  return { ok: true, status: out.status };
}

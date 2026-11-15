"use server";

import { type CommonValuesAnswer, getContextItem, requestCommonValues, type TermSpec } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";
import { queue } from "@/lib/sources";

/**
 * The most common values of the column a term maps to, read live from its source when someone
 * asks; OpenDash keeps none. Queued for a worker the first time in a while, so the page asks again until they're read.
 */
export async function termCommonValues(termId: string): Promise<CommonValuesAnswer> {
  if (!isUuid(termId)) return { status: "failed", message: "That term doesn't exist." };
  const viewer = await requireTenant();
  const boss = await queue();
  return withTenant(viewer.ctx, async (tx) => {
    const term = await getContextItem(tx, viewer.ctx.orgId, termId);
    const column = term?.kind === "term" ? (term.spec as TermSpec).maps_to?.column : undefined;
    if (!term?.connectionId || !column) return { status: "failed", message: "This term isn't mapped to a column." };
    return requestCommonValues(
      { boss },
      tx,
      { orgId: viewer.ctx.orgId, userId: viewer.ctx.userId ?? null },
      { connectionId: term.connectionId, column },
    );
  });
}

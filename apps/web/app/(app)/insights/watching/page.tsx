import { openInsightCount, orgTz, watchedByRoutines } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { WatchingView } from "@/components/insights/watching-view";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";

export const metadata: Metadata = { title: "Watching · OpenDash" };
export const dynamic = "force-dynamic";

/** Insights → Watching: every metric a routine watches, with the routines that watch it. */
export default async function WatchingPage() {
  const viewer = await requireTenant();
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  const { rows, open, tz } = await withTenant(viewer.ctx, async (tx) => ({
    rows: await watchedByRoutines(tx, actor),
    open: await openInsightCount(tx, actor),
    tz: await orgTz(tx, actor.orgId),
  }));
  return <WatchingView rows={rows} openCount={open} tz={tz} canManage={actor.canManage} />;
}

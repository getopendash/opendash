import { getAuthDatabase, memberNames } from "@opendash/auth";
import { listRoutines, needsManager, orgTz, othersPrivateCount } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { RoutinesView } from "@/components/routines/routines-view";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/roles";

export const metadata: Metadata = { title: "Routines · OpenDash" };
export const dynamic = "force-dynamic";

/** Routines: the team's and the viewer's, each as its sentence. */
export default async function RoutinesPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const [{ tab }, viewer] = await Promise.all([searchParams, requireTenant()]);
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  const { routines, tz, othersPrivate } = await withTenant(viewer.ctx, async (tx) => ({
    routines: await listRoutines(tx, actor),
    tz: await orgTz(tx, actor.orgId),
    othersPrivate: actor.canManage ? await othersPrivateCount(tx, actor) : 0,
  }));
  const owners = [...new Set(routines.map((r) => r.ownerId))];
  const names = owners.length ? await memberNames(getAuthDatabase(), viewer.ctx.orgId, owners) : {};
  return (
    <RoutinesView
      rows={routines.map((r) => ({
        routine: r,
        team: needsManager({ key: r.key, ownerId: r.ownerId, userIds: r.userIds, slack: r.slack }),
        owner: r.ownerId === viewer.user.id ? "You" : (names[r.ownerId] ?? "Someone who left"),
      }))}
      tab={tab === "yours" ? "yours" : "team"}
      me={viewer.user.id}
      tz={tz}
      canManage={actor.canManage}
      othersPrivate={othersPrivate}
    />
  );
}

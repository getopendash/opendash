import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActivityList } from "@/components/runs/activity-list";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Activity · OpenDash" };
export const dynamic = "force-dynamic";

/** The workspace's recent runs, background work included, each opening its trace. Owners and admins. */
export default async function ActivityPage() {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/members");
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Activity" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Activity</h1>
          <p className="text-body text-muted">
            The workspace's recent runs: background work, like drafting, investigations and weekly reviews, and the
            conversations you can read. Open one to see its trace. Someone's private conversation isn't listed.
          </p>
        </div>
        <ActivityList />
      </SettingsFrame>
    </>
  );
}

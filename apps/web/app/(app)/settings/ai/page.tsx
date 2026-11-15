import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AiSettings } from "@/components/ai/ai-settings";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "AI · OpenDash" };

/** The models the team can ask with, and the keys that pay for them. Owners and admins. */
export default async function AiModelsPage() {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/members");
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "AI" }]} />
      <SettingsFrame>
        <AiSettings />
      </SettingsFrame>
    </>
  );
}

import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ConnectionsSettings } from "@/components/connections/connections-settings";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { mcpOn } from "@/lib/mcp";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Connections · OpenDash" };

/** Settings → Connections: the MCP servers approved here. Owners and admins. */
export default async function ConnectionsPage() {
  if (!mcpOn()) notFound();
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/my-connections");
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Connections" }]} />
      <SettingsFrame>
        <ConnectionsSettings />
      </SettingsFrame>
    </>
  );
}

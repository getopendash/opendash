import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ServerPage } from "@/components/connections/server-page";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { mcpOn } from "@/lib/mcp";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Connection · OpenDash" };

/** One MCP server's page: its sign-in, whose account it uses, and its tools. Owners and admins. */
export default async function ServerSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  if (!mcpOn()) notFound();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/my-connections");
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Settings", href: "/settings/members" },
          { label: "Connections", href: "/settings/connections" },
          { label: "Server" },
        ]}
      />
      <SettingsFrame>
        <ServerPage serverId={id} />
      </SettingsFrame>
    </>
  );
}

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { MyConnections } from "@/components/connections/my-connections";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { mcpOn } from "@/lib/mcp";

export const metadata: Metadata = { title: "My connections · OpenDash" };

/** Settings → My connections: the services the analyst and dashboards use as you. Everyone. */
export default async function MyConnectionsPage() {
  if (!mcpOn()) notFound();
  await requireTenant();
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "My connections" }]} />
      <SettingsFrame>
        <MyConnections />
      </SettingsFrame>
    </>
  );
}

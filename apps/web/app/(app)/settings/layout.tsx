import { isOwnerRole } from "@opendash/auth";
import type { ReactNode } from "react";
import { SectionNav } from "@/components/shell/section-nav";
import { licensingShown } from "@/enterprise";
import { mcpOn } from "@/lib/mcp";
import { canManageTeam, teamOf } from "@/lib/team";
import { currentWorkspace } from "@/lib/workspace";

/**
 * Settings: its pages listed inside the sheet beside the page, the workspace's then your own. Usage, AI
 * models, Connections, Health, Activity, Slack, single sign-on, directory sync and the audit log are for owners and
 * admins; License for owners, unless this is the licensor's own service; Workspace (its data, deleting it) for
 * owners; Your data (your own, deleting your account) for everyone. Connections and My connections show unless MCP is turned off (OPENDASH_MCP=0).
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const ws = await currentWorkspace();
  const { members } = await teamOf(ws.org.id);
  const admin = canManageTeam(ws.role);
  const connections = mcpOn();
  return (
    <SectionNav
      title="Settings"
      groups={[
        {
          title: "Workspace",
          items: [
            { label: "Members", href: "/settings/members", count: members.length },
            { label: "Goals", href: "/settings/goals" },
            ...(admin
              ? [
                  { label: "Usage", href: "/settings/usage" },
                  { label: "AI", href: "/settings/ai" },
                  ...(connections ? [{ label: "Connections", href: "/settings/connections" }] : []),
                  { label: "Health", href: "/settings/health" },
                  { label: "Activity", href: "/settings/activity" },
                  { label: "Slack", href: "/settings/slack" },
                  { label: "Single sign-on", href: "/settings/single-sign-on" },
                  { label: "Directory sync", href: "/settings/directory-sync" },
                  { label: "Audit log", href: "/settings/audit-log" },
                ]
              : []),
            ...(isOwnerRole(ws.role) && licensingShown() ? [{ label: "License", href: "/settings/license" }] : []),
            ...(isOwnerRole(ws.role) ? [{ label: "Workspace", href: "/settings/workspace" }] : []),
          ],
        },
        {
          title: "Your account",
          items: [
            { label: "Security", href: "/settings/security" },
            { label: "Your data", href: "/settings/account" },
            ...(connections ? [{ label: "My connections", href: "/settings/my-connections" }] : []),
          ],
        },
      ]}
    >
      {children}
    </SectionNav>
  );
}

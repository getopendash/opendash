import { slackIdentities, slackWorkspace } from "@opendash/core";
import { withTenant } from "@opendash/db";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { SlackSettings } from "@/components/slack/slack-settings";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";
import { slackPublicUrl, slackSetup } from "@/lib/slack";
import { canManageTeam, teamOf } from "@/lib/team";

export const metadata: Metadata = { title: "Slack · OpenDash" };

/** How an Add to Slack ended, from its callback (?slack=…). */
const NOTICES: Record<string, { tone: "success" | "danger"; text: string }> = {
  connected: { tone: "success", text: "Slack is connected. People link their account the first time they ask." },
  cancelled: { tone: "danger", text: "Slack wasn't connected: the install was cancelled." },
  failed: { tone: "danger", text: "Slack wasn't connected: the install didn't come back from here. Try again." },
  taken: { tone: "danger", text: "Slack wasn't connected: that workspace is connected to another OpenDash workspace." },
  another_here: {
    tone: "danger",
    text: "Slack wasn't connected: another Slack workspace is connected here. Disconnect it first.",
  },
  enterprise: {
    tone: "danger",
    text: "Slack wasn't connected: OpenDash is added to one Slack workspace, not an Enterprise Grid organization. Add it from the workspace instead.",
  },
  unavailable: { tone: "danger", text: "Adding to Slack isn't set up for this deployment." },
  confirm: { tone: "success", text: "Back from Slack: checking what it connects…" },
  not_this_browser: {
    tone: "danger",
    text: "Slack wasn't connected: it came back to another browser or account, or after 10 minutes. Press Add to Slack again here.",
  },
  not_allowed: { tone: "danger", text: "Slack wasn't connected: only an owner or admin connects it." },
};

/** Slack for this workspace. Owners and admins. */
export default async function SlackSettingsPage({ searchParams }: { searchParams: Promise<{ slack?: string }> }) {
  const notice = NOTICES[(await searchParams).slack ?? ""] ?? null;
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) redirect("/settings/members");
  const [{ members }, data] = await Promise.all([
    teamOf(viewer.ctx.orgId),
    withTenant(viewer.ctx, async (tx) => ({
      workspace: await slackWorkspace(tx, viewer.ctx.orgId),
      people: await slackIdentities(tx, viewer.ctx.orgId),
    })),
  ]);
  const name = (userId: string | null) => members.find((m) => m.userId === userId)?.name || null;
  const address = slackPublicUrl();
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Slack" }]} />
      <SettingsFrame>
        <SlackSettings
          notice={notice}
          setup={slackSetup()}
          address={address}
          workspace={
            data.workspace
              ? {
                  teamName: data.workspace.teamName,
                  teamDomain: data.workspace.teamDomain,
                  connectedBy: name(data.workspace.connectedBy),
                  connectedAt: data.workspace.connectedAt,
                  removed: data.workspace.removed,
                }
              : null
          }
          people={data.people.map((p) => ({
            slackUserId: p.slackUserId,
            name: name(p.userId) ?? p.slackUserName ?? "Someone",
            slackName: p.slackUserName,
            linkedAt: p.linkedAt,
          }))}
        />
      </SettingsFrame>
    </>
  );
}

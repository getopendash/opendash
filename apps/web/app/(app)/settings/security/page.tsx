import { mySlackIdentity, slackWorkspace } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { headers } from "next/headers";
import { TwoFactorCard } from "@/components/account/two-factor-card";
import { TopBar } from "@/components/shell/top-bar";
import { SlackLinkCard } from "@/components/slack/slack-link-card";
import { SettingsFrame } from "@/components/team/settings-frame";
import { getAuth, requireTenant } from "@/lib/auth";

/** The person's own Security settings, in every workspace they belong to, and their Slack link in this one. */
export default async function SecurityPage() {
  const viewer = await requireTenant();
  const userId = viewer.ctx.userId;
  const [session, slack] = await Promise.all([
    getAuth().api.getSession({ headers: await headers() }),
    withTenant(viewer.ctx, async (tx) => {
      const workspace = await slackWorkspace(tx, viewer.ctx.orgId);
      if (!workspace || workspace.removed) return null;
      return {
        teamName: workspace.teamName,
        mine: userId ? await mySlackIdentity(tx, viewer.ctx.orgId, userId) : null,
      };
    }),
  ]);
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Security" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Security</h1>
          <p className="text-body text-muted">
            How you sign in to OpenDash. These settings are yours, in every workspace you belong to.
          </p>
        </div>
        <TwoFactorCard enabled={Boolean(session?.user.twoFactorEnabled)} />
        {slack ? (
          <SlackLinkCard
            teamName={slack.teamName}
            linked={slack.mine ? { slackUserName: slack.mine.slackUserName, linkedAt: slack.mine.linkedAt } : null}
          />
        ) : null}
      </SettingsFrame>
    </>
  );
}

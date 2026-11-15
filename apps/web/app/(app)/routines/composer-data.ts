import "server-only";
import { type ComposerChoices, composerChoices, listSlackChannels, slackWorkspaceToken } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";
import { canAsk, canManageTeam } from "@/lib/roles";
import type { ComposerSlack } from "@/lib/routine-draft";
import { slackDeps } from "@/lib/slack";
import { teamOf } from "@/lib/team";
import { currentWorkspace } from "@/lib/workspace";

/**
 * The connected Slack's channels (owners and admins post to them): read from Slack as the page opens, its token never
 * leaving the server. Slack slow or down, the rest of the composer still works.
 */
async function composerSlack(orgId: string): Promise<ComposerSlack> {
  const w = await slackWorkspaceToken(slackDeps, orgId).catch(() => null);
  if (!w) return { kind: "off" };
  try {
    return { kind: "ready", teamId: w.teamId, teamName: w.teamName, channels: await listSlackChannels(w.token) };
  } catch {
    return { kind: "problem", message: "Slack couldn't be reached to list its channels. Reload to try again." };
  }
}

/** What the composer offers the signed-in person: the metrics, dashboards and sources, whom they may email and post to. */
export async function composerData(): Promise<{
  actor: { orgId: string; userId: string; canManage: boolean };
  /** Not a viewer: a question, a written summary, working out why and Describe it are theirs. */
  canAsk: boolean;
  choices: ComposerChoices;
  members: { userId: string; name: string }[];
  workspace: string;
  slack: ComposerSlack;
}> {
  const viewer = await requireTenant();
  const actor = { orgId: viewer.ctx.orgId, userId: viewer.user.id, canManage: canManageTeam(viewer.role) };
  const [choices, ws] = await Promise.all([
    withTenant(viewer.ctx, (tx) => composerChoices(tx, actor)),
    currentWorkspace(),
  ]);
  // Anyone may email themselves; owners and admins, anyone in the workspace.
  const members = actor.canManage
    ? (await teamOf(actor.orgId)).members.map((m) => ({ userId: m.userId, name: m.name || m.email }))
    : [{ userId: viewer.user.id, name: viewer.user.name || viewer.user.email }];
  const slack: ComposerSlack = actor.canManage ? await composerSlack(actor.orgId) : { kind: "off" };
  return { actor, canAsk: canAsk(viewer.role), choices, members, workspace: ws.org.name, slack };
}

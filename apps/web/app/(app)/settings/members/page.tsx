import type { Metadata } from "next";
import { Members } from "@/components/team/members";
import { requireTenant } from "@/lib/auth";
import { canManageTeam, type Role, teamOf } from "@/lib/team";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Members · OpenDash" };

/** The organization's members and invitations (?invite opens the invite dialog). */
export default async function MembersPage({ searchParams }: { searchParams: Promise<{ invite?: string }> }) {
  const [{ invite }, viewer, ws] = await Promise.all([searchParams, requireTenant(), currentWorkspace()]);
  const { members, invitations } = await teamOf(viewer.ctx.orgId);
  const canManage = canManageTeam(viewer.role);
  return (
    <Members
      org={ws.org.name}
      me={viewer.user.id}
      myRole={viewer.role as Role}
      members={members}
      invitations={canManage ? invitations : []}
      canManage={canManage}
      openInvite={invite !== undefined}
    />
  );
}

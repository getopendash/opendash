"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { getAuth, requireTenant } from "@/lib/auth";
import { assignable, canManageTeam, type Role, teamOf } from "@/lib/team";

const codeOf = (error: unknown) =>
  (error as { body?: { code?: string } })?.body?.code ?? (error as { code?: string })?.code ?? "";
const messageOf = (error: unknown) => (error as { body?: { message?: string } })?.body?.message;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_INVITES = 20;

/** Why an invitation couldn't go out, in our words. */
function inviteProblem(email: string, error: unknown): string {
  const code = codeOf(error);
  if (code.includes("ALREADY_A_MEMBER")) return `${email} is already a member.`;
  if (code.includes("ALREADY_INVITED")) return `${email} already has an invitation; resend it from the list.`;
  if (code.includes("NOT_ALLOWED") || code.includes("PERMISSION")) return "You can't invite with that role.";
  return messageOf(error) ?? `Couldn't invite ${email}.`;
}

async function guard() {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) return { viewer, message: "Only owners and admins manage the team." };
  return { viewer, message: null };
}

/** Invites people by email with a role; each gets a link that expires in 7 days. */
export async function invitePeople(
  emails: string[],
  role: Role,
): Promise<{ sent: string[]; problems: string[] } | { message: string }> {
  const { viewer, message } = await guard();
  if (message) return { message };
  if (!assignable(viewer.role).includes(role) || role === "owner") {
    return { message: "Invite as an admin, a member or a viewer." };
  }
  const list = [...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
  if (!list.length) return { message: "Add an email." };
  if (list.length > MAX_INVITES) return { message: `Invite at most ${MAX_INVITES} people at once.` };
  const bad = list.filter((e) => !EMAIL.test(e));
  if (bad.length) return { message: `${bad.join(", ")} ${bad.length === 1 ? "isn't an email" : "aren't emails"}.` };
  const requestHeaders = await headers();
  const sent: string[] = [];
  const problems: string[] = [];
  for (const email of list) {
    try {
      await getAuth().api.createInvitation({
        body: { email, role, organizationId: viewer.ctx.orgId },
        headers: requestHeaders,
      });
      sent.push(email);
    } catch (error) {
      problems.push(inviteProblem(email, error));
    }
  }
  revalidatePath("/settings/members");
  return { sent, problems };
}

/**
 * Sends an invitation's email again, with a fresh week. An expired one is replaced (Better Auth only extends one that's
 * still open), so the list keeps one row per person.
 */
export async function resendInvitation(invitationId: string): Promise<{ message?: string }> {
  const { viewer, message } = await guard();
  if (message) return { message };
  const { invitations } = await teamOf(viewer.ctx.orgId);
  const invitation = invitations.find((i) => i.id === invitationId);
  if (!invitation) return { message: "That invitation was accepted or cancelled." };
  if (!assignable(viewer.role).includes(invitation.role) || invitation.role === "owner") {
    return { message: "That invitation can't be resent." };
  }
  const requestHeaders = await headers();
  try {
    if (invitation.expired) {
      await getAuth().api.cancelInvitation({ body: { invitationId }, headers: requestHeaders });
    }
    await getAuth().api.createInvitation({
      body: { email: invitation.email, role: invitation.role, organizationId: viewer.ctx.orgId, resend: true },
      headers: requestHeaders,
    });
  } catch (error) {
    return { message: inviteProblem(invitation.email, error) };
  }
  revalidatePath("/settings/members");
  return {};
}

export async function cancelInvitation(invitationId: string): Promise<{ message?: string }> {
  const { message } = await guard();
  if (message) return { message };
  try {
    await getAuth().api.cancelInvitation({ body: { invitationId }, headers: await headers() });
  } catch (error) {
    return { message: messageOf(error) ?? "Couldn't cancel that invitation." };
  }
  revalidatePath("/settings/members");
  return {};
}

/** Someone's own membership isn't changed from this page (leaving an organization is its own step). */
async function isSelf(orgId: string, userId: string, memberId: string) {
  const { members } = await teamOf(orgId);
  return members.some((m) => m.id === memberId && m.userId === userId);
}

/**
 * Changes a member's role. Better Auth also refuses what the person may not do: an admin changing an owner or making
 * one, and an organization left without an owner.
 */
export async function changeRole(memberId: string, role: Role): Promise<{ message?: string }> {
  const { viewer, message } = await guard();
  if (message) return { message };
  if (!assignable(viewer.role).includes(role)) return { message: "Only an owner makes owners." };
  if (await isSelf(viewer.ctx.orgId, viewer.user.id, memberId)) return { message: "You can't change your own role." };
  try {
    await getAuth().api.updateMemberRole({
      body: { memberId, role, organizationId: viewer.ctx.orgId },
      headers: await headers(),
    });
  } catch (error) {
    return { message: messageOf(error) ?? "Couldn't change that role." };
  }
  revalidatePath("/settings/members");
  return {};
}

export async function removeMember(memberId: string): Promise<{ message?: string }> {
  const { viewer, message } = await guard();
  if (message) return { message };
  if (await isSelf(viewer.ctx.orgId, viewer.user.id, memberId)) return { message: "You can't remove yourself here." };
  try {
    await getAuth().api.removeMember({
      body: { memberIdOrEmail: memberId, organizationId: viewer.ctx.orgId },
      headers: await headers(),
    });
  } catch (error) {
    return { message: messageOf(error) ?? "Couldn't remove that member." };
  }
  revalidatePath("/settings/members");
  return {};
}

// Settings → Members' actions, with the session and Better Auth stood in. Only owners and admins manage the
// team; only an owner makes owners; nobody changes or removes themselves here; invitations go to the signed-in
// workspace, whatever the browser sends, to at most 20 well-formed, distinct addresses; and an invitation is resent
// only when it's this workspace's. Better Auth refuses more on its side; these are ours.
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const ORG = "org-acme";
const session = vi.hoisted(() => ({ role: "admin", userId: "u-maya" }));
const api = vi.hoisted(() => ({
  createInvitation: vi.fn(async () => ({})),
  cancelInvitation: vi.fn(async () => ({})),
  updateMemberRole: vi.fn(async () => ({})),
  removeMember: vi.fn(async () => ({})),
}));
const team = vi.hoisted(() => ({
  members: [
    { id: "m-maya", userId: "u-maya", name: "Maya", email: "maya@acme.test", role: "admin", joinedAt: "" },
    { id: "m-sam", userId: "u-sam", name: "Sam", email: "sam@acme.test", role: "member", joinedAt: "" },
  ],
  invitations: [
    {
      id: "inv-priya",
      email: "priya@acme.test",
      role: "member",
      expiresAt: "",
      expired: false,
      inviterId: "u-maya",
      inviter: "Maya",
    },
  ],
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth", () => ({
  requireTenant: async () => ({ role: session.role, user: { id: session.userId }, ctx: { orgId: ORG } }),
  getAuth: () => ({ api }),
}));
vi.mock("@/lib/team", async () => ({
  ...(await import("../lib/roles")),
  teamOf: async () => team,
}));

const actions = await import("../app/(app)/settings/members/actions");

beforeEach(() => {
  vi.clearAllMocks();
  session.role = "admin";
  session.userId = "u-maya";
});

describe("managing the team", () => {
  it("is for owners and admins only: a member's or a viewer's every action is refused before Better Auth hears it", async () => {
    for (const role of ["member", "viewer"]) {
      session.role = role;
      const refused = "Only owners and admins manage the team.";
      expect(await actions.invitePeople(["ines@acme.test"], "member")).toEqual({ message: refused });
      expect(await actions.resendInvitation("inv-priya")).toEqual({ message: refused });
      expect(await actions.cancelInvitation("inv-priya")).toEqual({ message: refused });
      expect(await actions.changeRole("m-sam", "admin")).toEqual({ message: refused });
      expect(await actions.removeMember("m-sam")).toEqual({ message: refused });
    }
    expect(Object.values(api).every((f) => f.mock.calls.length === 0)).toBe(true);
  });

  it("makes owners only as an owner, and never changes or removes the person doing it", async () => {
    expect(await actions.invitePeople(["ines@acme.test"], "owner")).toEqual({
      message: "Invite as an admin, a member or a viewer.",
    });
    expect(await actions.changeRole("m-sam", "owner")).toEqual({ message: "Only an owner makes owners." });
    expect(await actions.changeRole("m-maya", "member")).toEqual({ message: "You can't change your own role." });
    expect(await actions.removeMember("m-maya")).toEqual({ message: "You can't remove yourself here." });
    expect(api.updateMemberRole).not.toHaveBeenCalled();
    expect(api.removeMember).not.toHaveBeenCalled();
    // An owner may.
    session.role = "owner";
    expect(await actions.changeRole("m-sam", "owner")).toEqual({});
    expect(api.updateMemberRole).toHaveBeenCalledWith({
      body: { memberId: "m-sam", role: "owner", organizationId: ORG },
      headers: expect.any(Headers),
    });
  });

  it("invites distinct, well-formed addresses, at most 20, into the signed-in workspace", async () => {
    expect(await actions.invitePeople([" Ines@Acme.test ", "ines@acme.test", "theo@acme.test"], "viewer")).toEqual({
      sent: ["ines@acme.test", "theo@acme.test"],
      problems: [],
    });
    expect(api.createInvitation).toHaveBeenCalledTimes(2);
    expect(api.createInvitation).toHaveBeenCalledWith({
      body: { email: "ines@acme.test", role: "viewer", organizationId: ORG },
      headers: expect.any(Headers),
    });
    expect(await actions.invitePeople(["not an email"], "member")).toEqual({ message: "not an email isn't an email." });
    expect(await actions.invitePeople([], "member")).toEqual({ message: "Add an email." });
    const many = Array.from({ length: 21 }, (_, i) => `p${i}@acme.test`);
    expect(await actions.invitePeople(many, "member")).toEqual({ message: "Invite at most 20 people at once." });
    expect(api.createInvitation).toHaveBeenCalledTimes(2);
  });

  it("says why an invitation didn't go, in its own words", async () => {
    api.createInvitation.mockRejectedValueOnce({ body: { code: "USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION" } });
    expect(await actions.invitePeople(["sam@acme.test"], "member")).toEqual({
      sent: [],
      problems: ["sam@acme.test is already a member."],
    });
  });

  it("resends only this workspace's invitations, and an owner's never by an admin", async () => {
    expect(await actions.resendInvitation("inv-elsewhere")).toEqual({
      message: "That invitation was accepted or cancelled.",
    });
    expect(api.createInvitation).not.toHaveBeenCalled();
    expect(await actions.resendInvitation("inv-priya")).toEqual({});
    expect(api.createInvitation).toHaveBeenCalledWith({
      body: { email: "priya@acme.test", role: "member", organizationId: ORG, resend: true },
      headers: expect.any(Headers),
    });
    team.invitations.push({ ...team.invitations[0], id: "inv-owner", role: "owner" } as never);
    expect(await actions.resendInvitation("inv-owner")).toEqual({ message: "That invitation can't be resent." });
    team.invitations.pop();
  });
});

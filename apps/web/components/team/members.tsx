"use client";

import { Button, Chip, Description, Dropdown, Label, ListBox, Select, toast } from "@heroui/react";
import { Ellipsis, Mail, UserMinus, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { cancelInvitation, changeRole, removeMember, resendInvitation } from "@/app/(app)/settings/members/actions";
import { TopBar } from "@/components/shell/top-bar";
import { shortDate } from "@/lib/format";
import { assignable, type Invitation, type Member, ROLE_INFO, ROLES, type Role } from "@/lib/roles";
import { InviteDialog } from "./invite-dialog";
import { SettingsFrame } from "./settings-frame";

const initials = (name: string) =>
  name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");

const DAY = 86_400_000;
function expiry(i: Invitation, now: number) {
  if (i.expired) return null;
  const days = Math.round((new Date(i.expiresAt).getTime() - now) / DAY);
  return days <= 0 ? "Expires today" : days === 1 ? "Expires tomorrow" : `Expires ${shortDate(i.expiresAt)}`;
}

function counts(members: Member[]) {
  const by = ROLES.map((r) => [r, members.filter((m) => m.role === r).length] as const).filter(([, n]) => n);
  const words = by.map(([r, n]) => `${n} ${ROLE_INFO[r].label.toLowerCase()}${n === 1 ? "" : "s"}`);
  return `${members.length} ${members.length === 1 ? "member" : "members"} · ${words.join(", ")}`;
}

/** The members, their roles, pending invitations, and inviting more. */
export function Members({
  org,
  me,
  myRole,
  members,
  invitations,
  canManage,
  openInvite,
}: {
  org: string;
  me: string;
  myRole: Role;
  members: Member[];
  invitations: Invitation[];
  canManage: boolean;
  /** Arrived from "Invite your team": open the dialog. */
  openInvite: boolean;
}) {
  const router = useRouter();
  const [inviting, setInviting] = useState(openInvite && canManage);
  const [pending, start] = useTransition();
  const [now] = useState(() => Date.now());
  const roles = assignable(myRole);
  const run = (fn: () => Promise<{ message?: string }>, done?: string) =>
    start(async () => {
      const r = await fn();
      if (r.message) toast.danger(r.message);
      else if (done) toast.success(done);
      router.refresh();
    });
  const who = (m: Member) => m.name || m.email;
  return (
    <>
      <TopBar
        crumbs={[{ label: "Settings" }, { label: "Members" }]}
        action={
          canManage ? (
            <Button size="sm" onPress={() => setInviting(true)}>
              <UserPlus className="size-3.5" aria-hidden />
              Invite people
            </Button>
          ) : null
        }
      />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Members</h1>
          <p className="text-body text-muted">
            People in {org} and what they can do.{" "}
            {canManage ? "Owners and admins invite people and change roles." : "Owners and admins manage the team."}
          </p>
        </div>
        <div className="flex flex-col gap-8">
          <div className="overflow-x-auto rounded-2xl border border-border bg-surface-secondary p-1">
            <table className="w-full border-collapse text-body">
              <thead>
                <tr className="text-left text-small text-muted">
                  <th className="px-3 py-2 font-normal">Name</th>
                  <th className="w-40 px-3 py-2 font-normal">Role</th>
                  <th className="hidden w-32 px-3 py-2 font-normal @2xl/page:table-cell">Joined</th>
                  <th className="w-12 px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="bg-surface">
                {members.map((m) => {
                  const self = m.userId === me;
                  // An admin can't change an owner; nobody changes themself here.
                  const editable = canManage && !self && (m.role !== "owner" || myRole === "owner");
                  return (
                    <tr key={m.id} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-3">
                          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-default text-small font-medium text-muted">
                            {initials(who(m))}
                          </span>
                          <span className="flex min-w-0 flex-col">
                            <span className="flex items-center gap-2">
                              <span className="truncate">{who(m)}</span>
                              {self ? (
                                <Chip size="sm" variant="soft">
                                  You
                                </Chip>
                              ) : null}
                            </span>
                            <span className="truncate text-small text-muted-tertiary">{m.email}</span>
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {editable ? (
                          <Select
                            aria-label={`${who(m)}'s role`}
                            selectedKey={m.role}
                            isDisabled={pending}
                            onSelectionChange={(k) =>
                              String(k) !== m.role &&
                              run(
                                () => changeRole(m.id, String(k) as Role),
                                `${who(m)} is now ${ROLE_INFO[String(k) as Role].label.toLowerCase()}.`,
                              )
                            }
                            className="w-fit"
                          >
                            <Select.Trigger className="h-7 min-w-24">
                              <Select.Value />
                              <Select.Indicator />
                            </Select.Trigger>
                            <Select.Popover className="w-72">
                              <ListBox>
                                {roles.map((r) => (
                                  <ListBox.Item key={r} id={r} textValue={ROLE_INFO[r].label}>
                                    <span className="flex flex-col gap-0.5">
                                      <Label>{ROLE_INFO[r].label}</Label>
                                      <Description>{ROLE_INFO[r].description}</Description>
                                    </span>
                                    <ListBox.ItemIndicator />
                                  </ListBox.Item>
                                ))}
                              </ListBox>
                            </Select.Popover>
                          </Select>
                        ) : (
                          <span className="text-muted">{ROLE_INFO[m.role]?.label ?? m.role}</span>
                        )}
                      </td>
                      <td className="hidden px-3 py-2.5 text-muted @2xl/page:table-cell">{shortDate(m.joinedAt)}</td>
                      <td className="px-3 py-2.5 text-right">
                        {editable ? (
                          <Dropdown>
                            <Button isIconOnly size="sm" variant="ghost" aria-label={`More for ${who(m)}`}>
                              <Ellipsis className="size-4" aria-hidden />
                            </Button>
                            <Dropdown.Popover placement="bottom end" className="min-w-48">
                              <Dropdown.Menu
                                onAction={(key) =>
                                  key === "remove" &&
                                  run(() => removeMember(m.id), `${who(m)} was removed from ${org}.`)
                                }
                              >
                                <Dropdown.Item id="remove" textValue={`Remove from ${org}`} variant="danger">
                                  <UserMinus className="size-4" aria-hidden />
                                  <Label>Remove from {org}</Label>
                                </Dropdown.Item>
                              </Dropdown.Menu>
                            </Dropdown.Popover>
                          </Dropdown>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="px-3 pt-2.5 pb-1.5 text-small text-muted">{counts(members)}</p>
          </div>
          {canManage && invitations.length ? (
            <section className="flex flex-col gap-3">
              <h2 className="flex items-baseline gap-2 text-heading">
                Pending invitations{" "}
                <span className="text-body font-normal text-muted-tertiary">{invitations.length}</span>
              </h2>
              <div className="overflow-x-auto rounded-2xl border border-border bg-surface-secondary p-1">
                <table className="w-full border-collapse text-body">
                  <thead>
                    <tr className="text-left text-small text-muted">
                      <th className="px-3 py-2 font-normal">Email</th>
                      <th className="w-40 px-3 py-2 font-normal">Role</th>
                      <th className="hidden w-40 px-3 py-2 font-normal @2xl/page:table-cell">Status</th>
                      <th className="w-44 px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="bg-surface">
                    {invitations.map((i) => (
                      <tr key={i.id} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-2.5">
                          <div className="flex items-center gap-3">
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border text-muted">
                              <Mail className="size-3.5" aria-hidden />
                            </span>
                            <span className="flex min-w-0 flex-col">
                              <span className="truncate">{i.email}</span>
                              <span className="truncate text-small text-muted-tertiary">
                                Invited by {i.inviterId === me ? "you" : (i.inviter ?? "a former member")}
                              </span>
                            </span>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 text-muted">{ROLE_INFO[i.role]?.label ?? i.role}</td>
                        <td className="hidden px-3 py-2.5 text-muted @2xl/page:table-cell">
                          {i.expired ? (
                            <span className="flex items-center gap-2">
                              <Chip size="sm" variant="soft" color="warning">
                                Expired
                              </Chip>
                              {shortDate(i.expiresAt)}
                            </span>
                          ) : (
                            expiry(i, now)
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={pending}
                              onPress={() => run(() => resendInvitation(i.id), `Sent again to ${i.email}.`)}
                            >
                              Resend
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              isDisabled={pending}
                              onPress={() => run(() => cancelInvitation(i.id), `Cancelled ${i.email}'s invitation.`)}
                            >
                              Cancel
                            </Button>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ) : null}
          {canManage ? (
            <InviteDialog
              org={org}
              roles={roles.filter((r) => r !== "owner")}
              members={members.map((m) => m.email.toLowerCase())}
              invited={invitations.filter((i) => !i.expired).map((i) => i.email.toLowerCase())}
              isOpen={inviting}
              onOpenChange={setInviting}
            />
          ) : null}
        </div>
      </SettingsFrame>
    </>
  );
}

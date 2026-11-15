import type { InvitationPreview } from "@opendash/auth";

/** The organization an invitation is for. */
export function OrgCard({ invitation, host }: { invitation: InvitationPreview; host: string }) {
  const { organization, role } = invitation;
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface px-3 py-3">
      <span className="flex size-8 items-center justify-center rounded-xl bg-avatar-sky text-body font-semibold text-avatar-foreground">
        {organization.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body font-medium">{organization.name}</span>
        <span className="truncate text-small text-muted">
          {host}/{organization.slug} · {organization.members} {organization.members === 1 ? "member" : "members"}
        </span>
      </div>
      <span className="text-small text-muted">Role: {role.charAt(0).toUpperCase() + role.slice(1)}</span>
    </div>
  );
}

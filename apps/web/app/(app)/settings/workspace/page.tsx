import { confirmPassword, getAuthDatabase, isOwnerRole } from "@opendash/auth";
import { notFound } from "next/navigation";
import { DeleteWorkspaceCard } from "@/components/data/delete-workspace-card";
import { ExportCard } from "@/components/data/export-card";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { currentWorkspace } from "@/lib/workspace";

/** The workspace's own data, for its owners: taking it out as a file, and deleting the workspace. */
export default async function WorkspaceDataPage() {
  const ws = await currentWorkspace();
  if (!isOwnerRole(ws.role)) notFound();
  // Whether to ask for a password: an account that only signs in through an identity provider has none.
  const hasPassword = (await confirmPassword(getAuthDatabase(), ws.user.id, "")) !== "none";
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Workspace" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Workspace</h1>
          <p className="text-body text-muted">
            {ws.org.name}'s data: take a copy, or delete the workspace. Owners only.
          </p>
        </div>
        <ExportCard id="export-workspace-title" title="Download this workspace's data" href="/api/export/workspace">
          A zip of what you can read here: its knowledge, conversations and the queries behind them, dashboards,
          routines, tasks, members and settings, one file a table. No passwords, keys or tokens, and nobody else's
          private conversations. The download is recorded in the audit log.
        </ExportCard>
        <DeleteWorkspaceCard name={ws.org.name} members={ws.members} hasPassword={hasPassword} />
      </SettingsFrame>
    </>
  );
}

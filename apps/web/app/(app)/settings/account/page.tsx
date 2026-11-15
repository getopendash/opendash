import { accountDeletionPlan, confirmPassword, getAuthDatabase } from "@opendash/auth";
import { DeleteAccountCard } from "@/components/data/delete-account-card";
import { ExportCard } from "@/components/data/export-card";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { requireTenant } from "@/lib/auth";

/** A person's own data: taking it out as a file, and deleting their account. Theirs, in every workspace. */
export default async function YourDataPage() {
  const viewer = await requireTenant();
  const database = getAuthDatabase();
  const [plan, password] = await Promise.all([
    accountDeletionPlan(database, viewer.user.id),
    confirmPassword(database, viewer.user.id, ""),
  ]);
  const names = (workspaces: { name: string }[]) => workspaces.map((w) => w.name);
  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Your data" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <h1 className="text-display">Your data</h1>
          <p className="text-body text-muted">
            What OpenDash holds about you, in every workspace you belong to: take a copy, or delete your account.
          </p>
        </div>
        <ExportCard id="export-account-title" title="Download your data" href="/api/export/account">
          A zip of your account (never your password or keys) and, for each workspace you're in, what you made there and
          what is about you: your conversations and the queries behind them, your dashboards, tasks, feedback and
          settings.
        </ExportCard>
        <DeleteAccountCard
          email={viewer.user.email}
          plan={{ deleted: names(plan.deleted), left: names(plan.left), blocking: names(plan.blocking) }}
          hasPassword={password !== "none"}
        />
      </SettingsFrame>
    </>
  );
}

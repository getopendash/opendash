import { EnterpriseRequired } from "@opendash/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DirectorySync } from "@/components/scim/directory-sync";
import { TopBar } from "@/components/shell/top-bar";
import { SettingsFrame } from "@/components/team/settings-frame";
import { enterprise, licensingShown } from "@/enterprise";
import { ssoCaller } from "@/lib/sso";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Directory sync · OpenDash" };
export const dynamic = "force-dynamic";

const WHAT = [
  "People added and removed by Okta, Entra ID or any SCIM 2.0 directory",
  "Groups map to admin, member or viewer",
  "Someone deactivated loses this workspace and their sessions at once",
];

/**
 * Settings → Directory sync, for owners and admins. Without a license a connected directory keeps syncing and the page
 * is read-only, but a new token and Disconnect still work: they only take access away.
 */
export default async function DirectorySyncPage() {
  const scim = enterprise().scim;
  const access = await ssoCaller();
  if (!scim || !access || !canManageTeam(access.caller.role)) redirect("/settings/members");
  const licensed = enterprise().canChange("scim");
  const status = await scim.status(access.caller);

  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Directory sync" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-display">Directory sync</h1>
            {licensingShown() ? (
              <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-small font-medium text-accent-soft-foreground">
                Enterprise
              </span>
            ) : null}
          </div>
          <p className="max-w-reading text-body text-muted">
            Your identity provider adds people, changes their role and removes them, over SCIM 2.0.
            {status.domains.length ? (
              <>
                {" "}
                People are added only at <strong>{status.domains.join(", ")}</strong>, which you verified.
              </>
            ) : null}
          </p>
        </div>
        {!licensed && !status.connected ? (
          <EnterpriseRequired title="Directory sync needs an Enterprise license" items={WHAT}>
            In development and tests it works without a key. Set <code>OPENDASH_LICENSE_KEY</code> and restart to turn
            it on here.
          </EnterpriseRequired>
        ) : (
          <DirectorySync status={status} licensed={licensed} />
        )}
      </SettingsFrame>
    </>
  );
}

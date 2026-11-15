import { EnterpriseRequired } from "@opendash/ui";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { ActivateCard, SsoSettings } from "@/components/sso/sso-settings";
import { SettingsFrame } from "@/components/team/settings-frame";
import { enterprise, licensingShown } from "@/enterprise";
import { ssoCaller } from "@/lib/sso";
import { canManageTeam } from "@/lib/team";

export const metadata: Metadata = { title: "Single sign-on · OpenDash" };
export const dynamic = "force-dynamic";

const WHAT = [
  "OIDC and SAML 2.0 identity providers: Okta, Entra ID, Google Workspace and others",
  "DNS proof of your domain, then a test sign-in before anyone depends on it",
  "Require it for everyone at your domain, with a way back in if the provider fails",
];

/**
 * Settings → Single sign-on: the workspace's identity providers and their lifecycle, for owners and admins. Without a
 * license, what's set up keeps working and shows read-only (Disable stays: it's the way back in). Someone else who just
 * came back through a provider to test it sees only the step to activate it.
 */
export default async function SingleSignOnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v : null);
  const access = await ssoCaller();
  if (!access) redirect("/settings/members");
  const { sso, caller, session } = access;
  const manager = canManageTeam(caller.role);
  if (!manager) {
    if (!session.providerId) redirect("/settings/members");
    return (
      <>
        <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Single sign-on" }]} />
        <SettingsFrame>
          <ActivateCard providerId={session.providerId} />
        </SettingsFrame>
      </>
    );
  }
  const licensed = enterprise().canChange("sso");
  const { providers, maxAuthAgeHours, origin } = await sso.list(caller);

  return (
    <>
      <TopBar crumbs={[{ label: "Settings", href: "/settings/members" }, { label: "Single sign-on" }]} />
      <SettingsFrame>
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-display">Single sign-on</h1>
            {licensingShown() ? (
              <span className="inline-flex h-5 items-center rounded-full bg-accent-soft px-2 text-small font-medium text-accent-soft-foreground">
                Enterprise
              </span>
            ) : null}
          </div>
          <p className="max-w-reading text-body text-muted">
            People at your company's domain sign in through your identity provider. Require it once a test sign-in has
            worked.
          </p>
        </div>
        {!licensed && !providers.length ? (
          <EnterpriseRequired title="Single sign-on needs an Enterprise license" items={WHAT}>
            In development and tests it works without a key. Set <code>OPENDASH_LICENSE_KEY</code> and restart to turn
            it on here.
          </EnterpriseRequired>
        ) : (
          <SsoSettings
            providers={providers}
            licensed={licensed}
            origin={origin}
            maxAuthAgeHours={maxAuthAgeHours}
            session={session}
            tested={one(params.tested)}
            testFailed={
              one(params.test_failed)
                ? { providerId: one(params.test_failed) as string, error: one(params.error) }
                : null
            }
          />
        )}
      </SettingsFrame>
    </>
  );
}

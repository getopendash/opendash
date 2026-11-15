import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { CreateOrganizationForm } from "@/components/auth/create-organization-form";
import { OnboardingStepper } from "@/components/auth/onboarding-stepper";
import { SignedInAs } from "@/components/auth/signed-in-as";
import { authSettings, currentViewer, nextStep } from "@/lib/auth";

export const metadata: Metadata = { title: "Create your organization · OpenDash" };

/** Step 1 of onboarding. Reached by anyone signed in without an organization or a pending invitation. */
export default async function CreateOrganizationPage() {
  const viewer = await currentViewer();
  // New workspaces start here; people already in one can add another from the workspace switcher.
  if (viewer.kind !== "needs-organization" && viewer.kind !== "tenant") redirect(nextStep(viewer) ?? "/");
  const { host } = await authSettings();
  return (
    <AuthScreen aside={<SignedInAs email={viewer.user.email} />}>
      <div className="flex flex-col gap-6">
        <OnboardingStepper current={1} />
        <AuthHeading title="Create your organization">
          This is where your team's data, definitions and dashboards live. You can change it later.
        </AuthHeading>
        <CreateOrganizationForm host={host} />
      </div>
    </AuthScreen>
  );
}

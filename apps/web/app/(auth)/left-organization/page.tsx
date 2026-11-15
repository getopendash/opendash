import { DoorOpen } from "lucide-react";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { AuthHeading } from "@/components/auth/auth-heading";
import { AuthScreen } from "@/components/auth/auth-screen";
import { LeaveStaleOrganization } from "@/components/auth/leave-stale-organization";
import { SignedInAs } from "@/components/auth/signed-in-as";
import { currentViewer, nextStep } from "@/lib/auth";

export const metadata: Metadata = { title: "No longer a member · OpenDash" };

/** Someone was removed from the organization their session was in: say so, and move them on. */
export default async function LeftOrganizationPage() {
  const viewer = await currentViewer();
  if (viewer.kind !== "left-organization") redirect(nextStep(viewer) ?? "/");
  return (
    <AuthScreen aside={<SignedInAs email={viewer.user.email} />}>
      <div className="flex flex-col gap-6">
        <AuthHeading icon={DoorOpen} title="You're no longer in that workspace">
          An admin removed you, or the workspace was deleted. Your other workspaces are still yours.
        </AuthHeading>
        <LeaveStaleOrganization />
      </div>
    </AuthScreen>
  );
}

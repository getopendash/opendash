import type { Metadata } from "next";
import { TopBar } from "@/components/shell/top-bar";
import { ConnectionGuide } from "@/components/sources/connection-guide";
import { SourcePicker } from "@/components/sources/source-picker";
import { StepHeading } from "@/components/sources/step-heading";
import { authSettings } from "@/lib/auth";
import { canManageSources, egressAddresses } from "@/lib/sources";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Connect a source · OpenDash" };

/** Choose the kind of database. Onboarding's second step, and "Connect source" afterwards. */
export default async function ConnectSourcePage() {
  const ws = await currentWorkspace();
  const { edition } = await authSettings();
  return (
    <>
      <TopBar
        crumbs={[{ label: "Data", href: "/data/sources" }, { label: "Connect a source" }]}
        action={<ConnectionGuide egress={edition === "cloud" ? egressAddresses() : []} />}
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="mx-auto flex max-w-wizard flex-col gap-6">
          <StepHeading title="Connect your data">
            OpenDash queries your database in place, with a read-only user. Only the results of your questions are
            stored.
          </StepHeading>
          {canManageSources(ws.role) ? (
            <SourcePicker />
          ) : (
            <p className="text-body text-muted">Ask an owner or admin of {ws.org.name} to connect a data source.</p>
          )}
        </div>
      </div>
    </>
  );
}

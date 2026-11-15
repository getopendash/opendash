import { BUDGETS } from "@opendash/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { ConnectionGuide } from "@/components/sources/connection-guide";
import { SourceConnect } from "@/components/sources/source-connect";
import { authSettings } from "@/lib/auth";
import { canManageSources, egressAddresses } from "@/lib/sources";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Connect PostgreSQL · OpenDash" };

/** Connecting Postgres: the settings and the live check, then a warning if the user can change data. */
export default async function ConnectPostgresPage() {
  const ws = await currentWorkspace();
  if (!canManageSources(ws.role)) redirect("/data/sources/new");
  const { edition } = await authSettings();
  const egress = edition === "cloud" ? egressAddresses() : [];
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Data", href: "/data/sources" },
          { label: "Connect a source", href: "/data/sources/new" },
          { label: "PostgreSQL" },
        ]}
        action={<ConnectionGuide egress={egress} />}
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="mx-auto max-w-wizard">
          <SourceConnect kind="postgres" egress={egress} queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs} />
        </div>
      </div>
    </>
  );
}

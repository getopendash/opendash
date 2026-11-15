import { BUDGETS } from "@opendash/core";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TopBar } from "@/components/shell/top-bar";
import { ConnectionGuide } from "@/components/sources/connection-guide";
import { SourceConnect } from "@/components/sources/source-connect";
import { authSettings } from "@/lib/auth";
import { canManageSources, egressAddresses } from "@/lib/sources";
import { currentWorkspace } from "@/lib/workspace";

export const metadata: Metadata = { title: "Connect ClickHouse · OpenDash" };

/**
 * Connecting ClickHouse: the same flow as Postgres, with ClickHouse's port, SSL and read-only user.
 * `?preset=playground` starts it filled in with ClickHouse's public playground.
 */
export default async function ConnectClickHousePage({ searchParams }: { searchParams: Promise<{ preset?: string }> }) {
  const [ws, { preset }] = await Promise.all([currentWorkspace(), searchParams]);
  if (!canManageSources(ws.role)) redirect("/data/sources/new");
  const { edition } = await authSettings();
  const egress = edition === "cloud" ? egressAddresses() : [];
  return (
    <>
      <TopBar
        crumbs={[
          { label: "Data", href: "/data/sources" },
          { label: "Connect a source", href: "/data/sources/new" },
          { label: "ClickHouse" },
        ]}
        action={<ConnectionGuide egress={egress} kind="clickhouse" />}
      />
      <div className="flex-1 overflow-y-auto px-8 pt-8 pb-16">
        <div className="mx-auto max-w-wizard">
          <SourceConnect
            kind="clickhouse"
            egress={egress}
            queuedWarningMs={BUDGETS.connectionTest.queuedWarningMs}
            playground={preset === "playground"}
          />
        </div>
      </div>
    </>
  );
}

import type { Metadata } from "next";
import { TopBar } from "@/components/shell/top-bar";
import { VerifiedTable } from "@/components/verified/verified-table";
import { requireTenant } from "@/lib/auth";
import { verifiedListFor } from "@/lib/verified";

export const metadata: Metadata = { title: "Verified queries · OpenDash" };

/** The verified queries. Saved from answers, by owners and admins. */
export default async function VerifiedQueriesPage() {
  const viewer = await requireTenant();
  const items = await verifiedListFor(viewer.ctx.orgId);
  return (
    <>
      <TopBar crumbs={[{ label: "Knowledge", href: "/knowledge" }, { label: "Verified queries" }]} />
      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-16 @2xl/page:px-8">
        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-display">Verified queries</h1>
            <p className="text-body text-muted">
              Questions someone checked, with the metric query that answered them right. When a question like one of
              these comes up, the analyst follows it, adapting the period.
            </p>
          </div>
          {items.length ? (
            <VerifiedTable items={items} />
          ) : (
            <p className="rounded-2xl border border-dashed border-border px-6 py-12 text-center text-body text-muted">
              None yet. Owners and admins save one from an answer: Sources, then Queries, then Save as verified on a
              metric query.
            </p>
          )}
        </div>
      </div>
    </>
  );
}

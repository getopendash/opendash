import type { Metadata } from "next";
import { InsightsView } from "@/components/insights/insights-view";
import { requireTenant } from "@/lib/auth";
import { insightsFor, investigationsFor, openInsightsFor, watchedCountFor } from "@/lib/insights";
import { canVerify } from "@/lib/knowledge";
import { canAsk } from "@/lib/roles";

export const metadata: Metadata = { title: "Insights · OpenDash" };

/** Q1: what metric checks found (?status=closed for the dismissed and resolved). */
export default async function InsightsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const [{ status }, viewer] = await Promise.all([searchParams, requireTenant()]);
  const closed = status === "closed";
  const orgId = viewer.ctx.orgId;
  const [insights, openCount, watched] = await Promise.all([
    insightsFor({ orgId, userId: viewer.user.id }, closed ? "closed" : "open"),
    openInsightsFor({ orgId, userId: viewer.user.id }),
    watchedCountFor({ orgId, userId: viewer.user.id, canManage: canVerify(viewer.role) }),
  ]);
  const investigations = await investigationsFor(
    orgId,
    insights.map((i) => i.id),
  );
  return (
    <InsightsView
      insights={insights}
      investigations={investigations}
      closed={closed}
      openCount={openCount}
      watched={watched}
      canAsk={canAsk(viewer.role)}
      canManage={canVerify(viewer.role)}
      now={Date.now()}
    />
  );
}

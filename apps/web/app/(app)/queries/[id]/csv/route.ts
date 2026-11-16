import { getQueryCard } from "@opendash/core";
import { queryCsv } from "@opendash/core/csv";
import { type TenantTx, withTenant } from "@opendash/db";
import { requireTenant } from "@/lib/auth";

const deps = { withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => withTenant({ orgId }, fn) };

/**
 * A query's rows as CSV, for whoever can see its query card: the stored result (at most 100 rows), the same file Slack
 * attaches. Nothing re-runs.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireTenant();
  const card = await getQueryCard(deps, { orgId: viewer.ctx.orgId, userId: viewer.user.id }, id);
  if (card?.status !== "succeeded" || !card.columns.length) return new Response("Not found", { status: 404 });
  const { filename, text } = queryCsv(card);
  return new Response(text, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "no-store",
    },
  });
}

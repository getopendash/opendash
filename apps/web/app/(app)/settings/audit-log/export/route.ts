import { audit } from "@opendash/core";
import { withTenant } from "@opendash/db";
import { auditAccess, sinceDays, tenantRun } from "@/lib/audit-log";
import { requireTenant } from "@/lib/auth";
import { canManageTeam } from "@/lib/team";

/**
 * The audit log as CSV or JSON Lines (ee/): the range on the page, oldest first, each row with its place and hash in
 * the chain and the chain head first. Owners and admins, with a license that covers the audit chain. The export is
 * itself recorded once it has been written out, with how many rows went.
 */
export async function GET(request: Request) {
  const viewer = await requireTenant();
  if (!canManageTeam(viewer.role)) return new Response("Only owners and admins export the audit log.", { status: 403 });
  const access = auditAccess();
  const chain = access.chain;
  if (!chain) return new Response("Exporting the audit log needs an Enterprise license.", { status: 403 });
  const url = new URL(request.url);
  const format = url.searchParams.get("format") === "jsonl" ? "jsonl" : "csv";
  const asked = Number(url.searchParams.get("days"));
  const days = access.ranges.includes(asked) ? asked : 90;
  const orgId = viewer.ctx.orgId;
  const rows = chain.export(tenantRun(orgId, viewer.user.id), orgId, { format, since: sinceDays(days) });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await rows.next();
        if (!next.done) {
          controller.enqueue(encoder.encode(next.value));
          return;
        }
        await withTenant(viewer.ctx, (tx) =>
          audit(tx, { action: "audit.exported", detail: { format, rows: next.value.rows, days } }),
        );
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await rows.return({ rows: 0 });
    },
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(body, {
    headers: {
      "Content-Type": format === "jsonl" ? "application/x-ndjson; charset=utf-8" : "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="audit-log-${day}-${days}d.${format === "jsonl" ? "jsonl" : "csv"}"`,
      "Cache-Control": "no-store",
    },
  });
}

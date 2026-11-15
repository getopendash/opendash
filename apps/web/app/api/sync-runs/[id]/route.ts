import { getSyncRun } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { currentViewer } from "@/lib/auth";

/** A learning run's progress, polled by the source page while the worker runs it. Tenant-scoped. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await currentViewer();
  if (viewer.kind !== "tenant") return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
  const run = await withTenant(viewer.ctx, (tx) => getSyncRun(tx, viewer.ctx.orgId, id));
  if (!run) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(run, { headers: { "cache-control": "no-store" } });
}

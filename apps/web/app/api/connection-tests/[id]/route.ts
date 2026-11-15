import { getConnectionTest } from "@opendash/core";
import { isUuid, withTenant } from "@opendash/db";
import { currentViewer } from "@/lib/auth";

/** A connection test's progress, polled by the connect form while the worker runs it. Tenant-scoped like everything else. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const viewer = await currentViewer();
  if (viewer.kind !== "tenant") return Response.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await params;
  if (!isUuid(id)) return Response.json({ error: "not found" }, { status: 404 });
  const test = await withTenant(viewer.ctx, (tx) => getConnectionTest(tx, viewer.ctx.orgId, id));
  if (!test) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(test, { headers: { "cache-control": "no-store" } });
}

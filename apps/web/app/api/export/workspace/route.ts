import { getAuthDatabase, isOwnerRole, orgPeople } from "@opendash/auth";
import { audit, exportFolder } from "@opendash/core";
import { sql, withTenant } from "@opendash/db";
import { currentTenant } from "@/lib/auth";
import { exportDate, exportDownload } from "@/lib/data";

export const dynamic = "force-dynamic";

/**
 * A workspace's data, as a zip (Settings → Workspace): for its owners, signed in as themselves, never an API key.
 * It has what the owner asking can read there (their own, and what the workspace shares), its members, and a
 * manifest; no secrets. The download is recorded in the audit log.
 */
export async function GET() {
  const tenant = await currentTenant().catch(() => null);
  if (!tenant) return new Response("Sign in first.", { status: 401 });
  if (tenant.kind !== "session" || !tenant.ctx.userId || !isOwnerRole(tenant.role)) {
    return new Response("Only a workspace's owners export its data.", { status: 403 });
  }
  const { orgId, userId } = tenant.ctx;
  const members = await orgPeople(getAuthDatabase(), orgId);
  const name = await withTenant(tenant.ctx, async (tx) => {
    await audit(tx, { action: "data.exported", detail: { scope: "workspace" } });
    const [org] = await tx.execute<{ name: string }>(sql`select name from app.org where id = ${orgId}`);
    return org?.name ?? "workspace";
  });
  return exportDownload(
    `opendash-${exportFolder(name, "workspace").toLowerCase()}-${exportDate()}.zip`,
    [{ kind: "workspace", orgId, userId, folder: "" }],
    [{ name: "members.json", json: members.map((m) => ({ id: m.id, name: m.name, email: m.email, role: m.role })) }],
  );
}

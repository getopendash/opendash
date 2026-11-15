/**
 * Removing a source. The connection row stays, marked deleted, so threads and query runs that used it keep
 * their numbers and their sources; everything OpenDash learned or holds for it goes in the same transaction:
 * its catalog and value index, its schema snapshots, the team's queries mined from its history, its definitions, and
 * its password (and with it every check that used it).
 * A learning run under way is failed, and the sync refuses to write the catalog of a removed source (writeCatalog
 * and writeProfile lock the connection row; this takes it first), so nothing comes back afterwards.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { audit } from "../audit/write";

export async function removeSource(
  tx: TenantTx,
  ctx: { orgId: string },
  connectionId: string,
  /** The source's name, typed to confirm. */
  confirmName: string,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "name_mismatch" }> {
  if (!isUuid(connectionId)) return { ok: false, reason: "not_found" };
  const [c] = await tx.execute<{ name: string; dialect: string; secret_id: string | null }>(sql`
    select name, dialect, secret_id from app.connection
    where org_id = ${ctx.orgId} and id = ${connectionId} and deleted_at is null
    for update`);
  if (!c) return { ok: false, reason: "not_found" };
  if (confirmName.trim() !== c.name) return { ok: false, reason: "name_mismatch" };

  await tx.execute(sql`
    update app.sync_run set status = 'failed', finished_at = now(), message = 'This source was removed.'
    where org_id = ${ctx.orgId} and connection_id = ${connectionId} and status in ('queued', 'running')`);
  // Columns, tables and schemas (the value index cascades from its columns), then the snapshots.
  await tx.execute(sql`
    delete from app.catalog_object where org_id = ${ctx.orgId} and connection_id = ${connectionId}`);
  await tx.execute(sql`
    delete from app.schema_snapshot where org_id = ${ctx.orgId} and connection_id = ${connectionId}`);
  // The team's queries of it, mined from its history.
  await tx.execute(sql`
    delete from app.query_pattern where org_id = ${ctx.orgId} and connection_id = ${connectionId}`);
  // Its definitions are about it (their SQL is in its dialect): they go too, marked deleted so the answers that used
  // them keep naming them.
  await tx.execute(sql`
    update app.context_item set deleted_at = now(), updated_at = now()
    where org_id = ${ctx.orgId} and connection_id = ${connectionId} and deleted_at is null`);
  await tx.execute(sql`
    update app.connection set deleted_at = now(), secret_id = null, updated_at = now()
    where org_id = ${ctx.orgId} and id = ${connectionId}`);
  // The password last, once nothing points at it; the checks that used it go with it (connection_test cascades).
  if (c.secret_id) {
    await tx.execute(sql`delete from app.secret where org_id = ${ctx.orgId} and id = ${c.secret_id}`);
  }
  await audit(tx, {
    action: "source.deleted",
    target: { type: "connection", id: connectionId, name: c.name },
    detail: { dialect: c.dialect },
  });
  return { ok: true };
}

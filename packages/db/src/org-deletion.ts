/**
 * What's left of a deleted organization, and its removal. Deleting the auth organization takes app.org and, through
 * the foreign keys, every tenant table's rows in that one statement; a trigger records it in app.org_deletion. The
 * tables below have no foreign key to app.org (the partitioned ones can't carry one cheaply, and the audit chain
 * follows the audit log), so their rows are purged afterwards, in batches, by the worker as the system role.
 *
 * `test/org-deletion.test.ts` deletes an organization that has a row in every app table and fails if a table outside
 * this list still has one: a new table without a cascading foreign key must be added here.
 */
import { sql } from "drizzle-orm";
import type { SystemTx } from "./tenant";

/** The tables a deleted organization's rows are purged from, each keyed by (org_id, id) but for the chain's one row. */
export const ORG_PURGED_TABLES = ["run_event", "query_run", "usage_event", "audit_log", "audit_chain"] as const;

/** How many rows of one table a single purge statement removes: small enough for the system's statement timeout. */
export const ORG_PURGE_BATCH = 5_000;

/** The organizations deleted and not yet purged, oldest first. */
export async function unpurgedOrgs(tx: SystemTx, limit = 20): Promise<string[]> {
  const rows = await tx.execute<{ org_id: string }>(sql`
    select org_id::text as org_id from app.org_deletion where purged_at is null order by deleted_at limit ${limit}`);
  return rows.map((r) => r.org_id);
}

/**
 * Removes up to `batch` of a deleted organization's rows from each purged table, and says how many went: call it
 * again until it answers 0, then `markOrgPurged`. Each call is one short transaction of the caller's. It refuses an
 * organization that still exists, or one that was never deleted, whatever it's given: it deletes nothing for it.
 */
export async function purgeOrgRows(tx: SystemTx, orgId: string, batch = ORG_PURGE_BATCH): Promise<number> {
  const [gone] = await tx.execute<{ ok: boolean }>(sql`
    select exists (select 1 from app.org_deletion where org_id = ${orgId}::uuid)
       and not exists (select 1 from app.org where id = ${orgId}::uuid) as ok`);
  if (!gone?.ok) throw new Error("Only a deleted organization's rows are purged.");
  let removed = 0;
  for (const table of ORG_PURGED_TABLES) {
    const name = sql.identifier(table);
    if (table === "audit_log") {
      // Its rows are never deleted but by this function, which takes them only for organizations recorded as deleted.
      const [row] = await tx.execute<{ n: string | number }>(sql`select app.purge_deleted_audit_log(${batch}) as n`);
      removed += Number(row?.n ?? 0);
      continue;
    }
    const rows =
      table === "audit_chain"
        ? await tx.execute(sql`delete from app.${name} where org_id = ${orgId}::uuid returning 1`)
        : await tx.execute(sql`
            delete from app.${name} where org_id = ${orgId}::uuid and id in (
              select id from app.${name} where org_id = ${orgId}::uuid limit ${batch})
            returning 1`);
    removed += rows.length;
  }
  return removed;
}

/** Records that nothing of a deleted organization is left: its purge is done. */
export async function markOrgPurged(tx: SystemTx, orgId: string): Promise<void> {
  await tx.execute(sql`
    update app.org_deletion set purged_at = now() where org_id = ${orgId}::uuid and purged_at is null`);
}

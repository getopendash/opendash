/**
 * Routine runs that wait: a finding told after its investigation, or the day's roundup. A wait is a row
 * with its due time, never a sleeping job. It ends when its investigation settles, or at its due time, whichever comes
 * first; each release is one update that only a waiting row passes, so the two can't both run it.
 */
import { sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { GatewayDeps } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { routineRunQueue } from "../jobs/queues";
import type { SystemDeps } from "../ops/alerts";

async function queueRuns(tx: TenantTx, boss: PgBoss, orgId: string, ids: { id: string }[]): Promise<number> {
  for (const { id } of ids) {
    await enqueueOnce(boss, tx, routineRunQueue, { orgId, routineRunId: id }, { singletonKey: id });
  }
  return ids.length;
}

/** The runs that waited to tell this insight with its investigation: they go now. */
export async function releaseWaitingRuns(
  tx: TenantTx,
  boss: PgBoss,
  orgId: string,
  which: { insightId: string },
): Promise<number> {
  const released = await tx.execute<{ id: string }>(sql`
    update app.routine_run set status = 'queued', updated_at = now()
    where org_id = ${orgId} and status = 'waiting' and trigger_key = ${`found:${which.insightId}`}
    returning id`);
  return queueRuns(tx, boss, orgId, released);
}

/** The dispatcher's part (each minute): waiting runs whose time came (a roundup's 07:00, an investigation overdue). */
export async function releaseDueRuns(
  deps: SystemDeps & { withTenant: GatewayDeps["withTenant"]; boss: PgBoss },
  now = new Date(),
): Promise<number> {
  const orgs = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string }>(sql`
      select distinct org_id from app.routine_run
      where status = 'waiting' and due_at <= ${now.toISOString()}::timestamptz limit 50`),
  );
  let n = 0;
  for (const { org_id } of orgs) {
    n += await deps.withTenant(org_id, async (tx) => {
      const released = await tx.execute<{ id: string }>(sql`
        update app.routine_run set status = 'queued', updated_at = now()
        where org_id = ${org_id} and status = 'waiting' and due_at <= ${now.toISOString()}::timestamptz
        returning id`);
      return queueRuns(tx, deps.boss, org_id, released);
    });
  }
  return n;
}

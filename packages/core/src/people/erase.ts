/**
 * An account was deleted: what was that person's alone in a workspace they leave goes with it. Their private
 * conversations and dashboards (nobody else could read them, owners and admins included), the runs, events and query
 * results behind those conversations, and their own settings and marks. On top of what leaving a workspace already
 * ends (`memberLeft`: routines, shares; `mcp.personLeft`: their own connections).
 *
 * What they made that the workspace shares (a conversation shared with it or a project, a dashboard, a definition,
 * feedback) is the workspace's, and stays: it carries their id, which names nobody once the account is gone.
 */
import { sql, type TenantTx } from "@opendash/db";

export interface PersonErased {
  threads: number;
  dashboards: number;
}

export async function personErased(tx: TenantTx, orgId: string, userId: string): Promise<PersonErased> {
  // The history tables have no foreign key to a run (they're partitioned), so they go first, by the runs' ids.
  const mine = sql`
    select r.id from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    where r.org_id = ${orgId} and t.created_by = ${userId}::uuid and t.visibility = 'private'`;
  await tx.execute(sql`delete from app.run_event where org_id = ${orgId} and run_id in (${mine})`);
  await tx.execute(sql`
    delete from app.query_run where org_id = ${orgId} and requester_type = 'run' and requester_id in (${mine})`);
  // A dashboard made in a conversation points at it; one that's shared keeps living without it.
  await tx.execute(sql`
    update app.dashboard d set thread_id = null
    where d.org_id = ${orgId} and (d.owner_id is distinct from ${userId}::uuid or d.visibility <> 'private')
      and d.thread_id in (
        select id from app.thread where org_id = ${orgId} and created_by = ${userId}::uuid and visibility = 'private')`);
  const dashboards = await tx.execute(sql`
    delete from app.dashboard
    where org_id = ${orgId} and owner_id = ${userId}::uuid and visibility = 'private' returning id`);
  const threads = await tx.execute(sql`
    delete from app.thread
    where org_id = ${orgId} and created_by = ${userId}::uuid and visibility = 'private' returning id`);
  await tx.execute(sql`delete from app.member_pref where org_id = ${orgId} and user_id = ${userId}::uuid`);
  await tx.execute(sql`delete from app.user_mark where org_id = ${orgId} and user_id = ${userId}::uuid`);
  await tx.execute(sql`
    delete from app.project_member
    where org_id = ${orgId} and principal_type = 'user' and principal_id = ${userId}::uuid`);
  return { threads: threads.length, dashboards: dashboards.length };
}

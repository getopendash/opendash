/**
 * Stars (`user_mark`, mark `favorite`): a person's own marks on conversations and dashboards they can
 * read, for the Starred lists. A star is the person's alone; nobody else sees it. One kept on something they later
 * lose access to is harmless: every list still applies who may read it.
 */
import { sql, type TenantTx } from "@opendash/db";
// Types only from the ledger, and the rules from access.ts: nothing here imports what imports it.
import { dashboardReadableBy, threadReadableBy } from "../projects/access";
import { type LedgerDeps, LISTED_CHANNELS, type Viewer } from "./ledger";

/** Marks or unmarks, for this person: starring twice, or unstarring what isn't starred, is fine. */
async function mark(
  tx: TenantTx,
  orgId: string,
  userId: string,
  targetType: "thread" | "dashboard",
  id: string,
  on: boolean,
) {
  await tx.execute(
    on
      ? sql`insert into app.user_mark (org_id, user_id, target_type, target_id, mark)
            values (${orgId}, ${userId}, ${targetType}, ${id}, 'favorite') on conflict do nothing`
      : sql`delete from app.user_mark
            where org_id = ${orgId} and user_id = ${userId} and target_type = ${targetType} and target_id = ${id}
              and mark = 'favorite'`,
  );
}

/**
 * Stars or unstars a conversation for the person. False when there's no person (an organization API key) or the
 * conversation isn't one they can read; starring twice, or unstarring what isn't starred, is fine.
 */
export async function setThreadStar(
  deps: LedgerDeps,
  viewer: Viewer,
  threadId: string,
  starred: boolean,
): Promise<boolean> {
  const userId = viewer.userId;
  if (!userId) return false;
  return deps.withTenant(viewer.orgId, async (tx) => {
    const [readable] = await tx.execute<{ id: string }>(sql`
      select t.id from app.thread t
      where t.org_id = ${viewer.orgId} and t.id = ${threadId} and t.deleted_at is null
        and t.channel in ${LISTED_CHANNELS} and ${threadReadableBy(userId)}`);
    if (!readable) return false;
    await mark(tx, viewer.orgId, userId, "thread", threadId, starred);
    return true;
  });
}

/** Stars or unstars a dashboard, on the same terms: a person, and a dashboard they can read. */
export async function setDashboardStar(
  tx: TenantTx,
  viewer: Viewer,
  dashboardId: string,
  starred: boolean,
): Promise<boolean> {
  const userId = viewer.userId;
  if (!userId) return false;
  const [readable] = await tx.execute<{ id: string }>(sql`
    select d.id from app.dashboard d
    where d.org_id = ${viewer.orgId} and d.id = ${dashboardId} and d.deleted_at is null and ${dashboardReadableBy(userId)}`);
  if (!readable) return false;
  await mark(tx, viewer.orgId, userId, "dashboard", dashboardId, starred);
  return true;
}

/** Whether the person starred the dashboard (alias `d`). */
export const dashboardStarredBy = (userId: string | null) => sql`exists (
  select 1 from app.user_mark um
  where um.org_id = d.org_id and um.user_id = ${userId}::uuid and um.target_type = 'dashboard' and um.target_id = d.id
    and um.mark = 'favorite')`;

/** Whether the person starred the thread (alias `t`): a column for every list. */
export const threadStarredBy = (userId: string | null) => sql`exists (
  select 1 from app.user_mark um
  where um.org_id = t.org_id and um.user_id = ${userId}::uuid and um.target_type = 'thread' and um.target_id = t.id
    and um.mark = 'favorite')`;

/**
 * How skills are used: how many answers followed each, and which, read from what each run
 * recorded it followed (its outcome's context, `kind: skill`).
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { threadReadableBy } from "../projects/access";

/** How many answers followed each of these skills since `since` (the skills list's Answers): a count, nothing about whose. */
export async function skillFollowCounts(
  tx: TenantTx,
  orgId: string,
  ids: string[],
  since: Date,
): Promise<Map<string, number>> {
  const known = ids.filter(isUuid);
  if (!known.length) return new Map();
  const rows = await tx.execute<{ id: string; n: number }>(sql`
    select used->>'id' as id, count(*)::int as n from app.run r
    cross join lateral jsonb_array_elements(coalesce(r.outcome->'context', '[]'::jsonb)) used
    where r.org_id = ${orgId} and r.parent_run_id is null and r.queued_at >= ${since.toISOString()}::timestamptz
      and r.outcome->>'kind' = 'answer' and used->>'kind' = 'skill'
      and used->>'id' in (${sql.join(
        known.map((id) => sql`${id}`),
        sql`, `,
      )})
    group by 1`);
  return new Map(rows.map((r) => [r.id, r.n]));
}

/** The latest answers that followed a skill (a skill's Followed in), among the conversations this person can read. */
export async function answersFollowing(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  skillId: string,
  limit = 5,
): Promise<{ threadId: string; title: string; at: string; version: number }[]> {
  if (!isUuid(skillId)) return [];
  // Each conversation once, at its latest answer that followed it.
  const rows = await tx.execute<{ thread_id: string; title: string; at: string; version: number }>(sql`
    select * from (
      select distinct on (t.id) t.id as thread_id, t.title, r.queued_at as at, (used->>'version')::int as version
      from app.run r
      join app.thread t on t.org_id = r.org_id and t.id = r.thread_id and t.deleted_at is null
      cross join lateral jsonb_array_elements(coalesce(r.outcome->'context', '[]'::jsonb)) used
      where r.org_id = ${viewer.orgId} and r.parent_run_id is null and r.outcome->>'kind' = 'answer'
        and used->>'kind' = 'skill' and used->>'id' = ${skillId} and ${threadReadableBy(viewer.userId)}
      order by t.id, r.queued_at desc
    ) latest order by at desc limit ${limit}`);
  return rows.map((r) => ({
    threadId: r.thread_id,
    title: r.title,
    at: new Date(r.at).toISOString(),
    version: r.version,
  }));
}

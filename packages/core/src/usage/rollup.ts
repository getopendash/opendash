/**
 * usage_daily: the last `days` UTC days recomputed from usage_event in one transaction, so
 * running it again changes nothing. It's what usage looks like once the events are past their 13 months.
 */
import { type SystemTx, sql } from "@opendash/db";

export async function rollupUsage(
  deps: { withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T> },
  now: Date = new Date(),
  days = 2,
): Promise<{ rows: number; from: string }> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)));
  const day = from.toISOString().slice(0, 10);
  return deps.withSystem(async (tx) => {
    await tx.execute(sql`delete from app.usage_daily where day >= ${day}::date`);
    const rows = await tx.execute<{ org_id: string }>(sql`
      insert into app.usage_daily (org_id, day, kind, model, key_source, events, qty, cost_usd, unpriced, updated_at)
      select e.org_id, (app.uuidv7_ts(e.id) at time zone 'UTC')::date, e.kind, coalesce(e.model, 'unknown'),
        coalesce(e.key_source, 'deployment'), count(*)::int, coalesce(sum(e.qty), 0)::bigint,
        coalesce(sum(e.cost_usd), 0), (count(*) filter (where e.cost_usd is null))::int, ${now.toISOString()}::timestamptz
      from app.usage_event e
      where e.id >= app.uuidv7_floor(${from.toISOString()}::timestamptz)
      group by 1, 2, 3, 4, 5
      returning org_id`);
    return { rows: rows.length, from: day };
  });
}

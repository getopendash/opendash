/**
 * When sources are learned again on their own (a source's Overview and Settings → Sync). A schedule is a small RRULE subset in UTC, stored in
 * connection.sync_rrule with the next due time in next_sync_at (a long wait is a row, not a sleeping job):
 *   FREQ=DAILY;BYHOUR=h       daily at h:00 UTC (new sources: 02:00)
 *   FREQ=HOURLY;INTERVAL=6    every 6 hours, at 00:00, 06:00, 12:00 and 18:00 UTC
 *   (null)                    off: only Sync now
 * The sources.schedule job, every few minutes, finds the due sources across organizations and starts each one's
 * learning run in its own tenant transaction; doing it twice is harmless (one active run per source).
 */
import { type SystemTx, sql, type TenantTx } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { requestSync } from "./catalog";

export type SyncSchedule = { every: "off" } | { every: "6h" } | { every: "day"; hour: number };

export const DEFAULT_SYNC_RULE = "FREQ=DAILY;BYHOUR=2";

const HOUR = 3_600_000;

export function scheduleRule(schedule: SyncSchedule): string | null {
  if (schedule.every === "off") return null;
  if (schedule.every === "6h") return "FREQ=HOURLY;INTERVAL=6";
  const hour = Math.trunc(schedule.hour);
  if (!(hour >= 0 && hour <= 23)) throw new Error("A daily sync's hour is 0 to 23.");
  return `FREQ=DAILY;BYHOUR=${hour}`;
}

/** The schedule a rule stands for; anything this subset doesn't know reads as off. */
export function parseScheduleRule(rule: string | null): SyncSchedule {
  if (rule === "FREQ=HOURLY;INTERVAL=6") return { every: "6h" };
  const daily = rule ? /^FREQ=DAILY;BYHOUR=(\d{1,2})$/.exec(rule) : null;
  const hour = daily ? Number(daily[1]) : Number.NaN;
  return hour >= 0 && hour <= 23 ? { every: "day", hour } : { every: "off" };
}

/** The first time the rule fires strictly after `from`, or null when it's off. */
export function nextRun(rule: string | null, from: Date): Date | null {
  const s = parseScheduleRule(rule);
  if (s.every === "off") return null;
  const t = new Date(from.getTime());
  t.setUTCMinutes(0, 0, 0);
  if (s.every === "6h") {
    t.setUTCHours(Math.floor(t.getUTCHours() / 6) * 6);
    while (t.getTime() <= from.getTime()) t.setTime(t.getTime() + 6 * HOUR);
    return t;
  }
  t.setUTCHours(s.hour);
  while (t.getTime() <= from.getTime()) t.setTime(t.getTime() + 24 * HOUR);
  return t;
}

/** Sets a source's schedule (owners and admins) and when it's next due. */
export async function setSyncSchedule(
  tx: TenantTx,
  ctx: { orgId: string },
  connectionId: string,
  schedule: SyncSchedule,
): Promise<{ ok: true; nextSyncAt: string | null } | { ok: false; reason: "not_found" }> {
  const rule = scheduleRule(schedule);
  const next = nextRun(rule, new Date());
  const rows = await tx.execute<{ id: string }>(sql`
    update app.connection set sync_rrule = ${rule}, next_sync_at = ${next?.toISOString() ?? null}::timestamptz,
      updated_at = now()
    where org_id = ${ctx.orgId} and id = ${connectionId} and deleted_at is null
    returning id`);
  return rows.length ? { ok: true, nextSyncAt: next?.toISOString() ?? null } : { ok: false, reason: "not_found" };
}

const DISPATCH_BATCH = 200;

/**
 * The sources.schedule job: starts the learning runs that are due and moves each source's next_sync_at on. A
 * disabled or removed source is skipped; one that is already learning keeps its run and is still moved on.
 */
export async function dispatchScheduledSyncs(deps: {
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>;
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  boss: PgBoss;
}): Promise<{ started: number }> {
  const due = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from app.connection
      where next_sync_at <= now() and sync_rrule is not null and deleted_at is null and status <> 'disabled'
      order by next_sync_at limit ${DISPATCH_BATCH}`),
  );
  let started = 0;
  for (const c of due) {
    const ran = await deps.withTenant(c.org_id, async (tx) => {
      // Checked again under a row lock: another worker may have taken it, or it may have changed.
      const [row] = await tx.execute<{ sync_rrule: string | null }>(sql`
        select sync_rrule from app.connection
        where org_id = ${c.org_id} and id = ${c.id} and next_sync_at <= now() and sync_rrule is not null
          and deleted_at is null and status <> 'disabled'
        for update skip locked`);
      if (!row) return false;
      await requestSync({ boss: deps.boss }, tx, { orgId: c.org_id, userId: null }, c.id);
      const next = nextRun(row.sync_rrule, new Date());
      await tx.execute(sql`
        update app.connection set next_sync_at = ${next?.toISOString() ?? null}::timestamptz
        where org_id = ${c.org_id} and id = ${c.id}`);
      return true;
    });
    if (ran) started += 1;
  }
  return { started };
}

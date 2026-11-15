/**
 * The dispatcher's part (each minute, on system.tick): scheduled routines that are due get one run each,
 * keyed by the time it was due, and move to their next time; checks that are due are queued. Two separate tasks, so
 * one's backlog never holds up the other. At most 50 of each a minute; one that fails is logged and the rest still go.
 */
import { sql, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { GatewayDeps } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { metricCheckQueue, routineRunQueue } from "../jobs/queues";
import type { SystemDeps } from "../ops/alerts";
import { isTimeZone, latestOccurrence, nextOccurrence } from "./schedule";
import type { ScheduleSpec } from "./spec";

type Deps = SystemDeps & { withTenant: GatewayDeps["withTenant"]; boss: PgBoss };

/** How long a queued check holds off the dispatcher: past its job's expiry and retry; the check sets its own next. */
const CHECK_LEASE_MS = 60 * 60_000;

/**
 * Due scheduled routines: each gets the run for its latest due time (`at:<time>`, so after an outage only the latest
 * missed one runs, and a double dispatch is a no-op), and its next time from now.
 */
export async function queueDueRoutines(deps: Deps, now = new Date()): Promise<number> {
  const due = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from (
        select org_id, id, next_run_at, row_number() over (partition by org_id order by next_run_at, id) as nth
        from app.routine
        where trigger = 'schedule' and status = 'active' and deleted_at is null
          and next_run_at <= ${now.toISOString()}::timestamptz
      ) due
      -- Shared across workspaces: each one's first due routine before any one's second, so one can't hold the rest out.
      order by nth, next_run_at limit 50`),
  );
  for (const r of due) {
    try {
      await deps.withTenant(r.org_id, async (tx) => {
        const [row] = await tx.execute<{ spec: ScheduleSpec; tz: string }>(sql`
          select r.spec, o.tz from app.routine r join app.org o on o.id = r.org_id
          where r.org_id = ${r.org_id} and r.id = ${r.id} and r.status = 'active' and r.deleted_at is null
            and r.next_run_at <= ${now.toISOString()}::timestamptz
          for update of r skip locked`);
        if (!row) return;
        const tz = isTimeZone(row.tz) ? row.tz : "UTC";
        const at = latestOccurrence(row.spec.rule, tz, now);
        await tx.execute(sql`
          update app.routine set next_run_at = ${nextOccurrence(row.spec.rule, tz, now).toISOString()}, updated_at = now()
          where org_id = ${r.org_id} and id = ${r.id}`);
        const [run] = await tx.execute<{ id: string }>(sql`
          insert into app.routine_run (org_id, id, routine_id, trigger_key, spec_snapshot)
          values (${r.org_id}, ${uuidv7()}, ${r.id}, ${`at:${at.toISOString()}`},
            ${JSON.stringify(row.spec)}::jsonb)
          on conflict (org_id, routine_id, trigger_key) do nothing returning id`);
        if (run) {
          await enqueueOnce(
            deps.boss,
            tx,
            routineRunQueue,
            { orgId: r.org_id, routineRunId: run.id },
            {
              singletonKey: run.id,
            },
          );
        }
      });
    } catch (error) {
      deps.log?.error("routine not queued", {
        orgId: r.org_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return due.length;
}

/** Due checks: each queued once (one job per check at a time), held off the dispatcher while it runs. */
export async function queueDueChecks(deps: Deps, now = new Date()): Promise<number> {
  const due = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from (
        select org_id, id, next_check_at, row_number() over (partition by org_id order by next_check_at, id) as nth
        from app.metric_check
        where deleted_at is null and next_check_at <= ${now.toISOString()}::timestamptz
      ) due
      -- Shared across workspaces, as the routines are.
      order by nth, next_check_at limit 50`),
  );
  for (const c of due) {
    try {
      await deps.withTenant(c.org_id, async (tx) => {
        // Still due (another dispatcher, or Check now, may have taken it since it was read): held off, then queued.
        const [held] = await tx.execute<{ id: string }>(sql`
          update app.metric_check set next_check_at = ${new Date(now.getTime() + CHECK_LEASE_MS).toISOString()}
          where org_id = ${c.org_id} and id = ${c.id} and deleted_at is null
            and next_check_at <= ${now.toISOString()}::timestamptz
          returning id`);
        if (!held) return;
        await enqueueOnce(deps.boss, tx, metricCheckQueue, { orgId: c.org_id, checkId: c.id }, { singletonKey: c.id });
      });
    } catch (error) {
      deps.log?.error("check not queued", {
        orgId: c.org_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return due.length;
}

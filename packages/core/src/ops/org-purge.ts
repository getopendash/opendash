/**
 * What's left of deleted organizations, removed (the dispatcher's task, each minute). Deleting a workspace takes
 * everything its foreign keys reach at once (`deleteOrganization`, the auth package) and records it; here its queued
 * jobs go, then its rows in the tables no foreign key reaches, a batch at a time, and the record is marked done when
 * none are left. Row-driven and safe to run again: a tick that runs out of time leaves the rest to the next one.
 */
import { markOrgPurged, purgeOrgRows, unpurgedOrgs } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { QUEUE_SCHEMA } from "../jobs/boss";
import type { SystemDeps } from "./alerts";
import { logger } from "./log";

/** How long one tick spends purging: well inside the tick's own time (budgets.ts), with its other tasks. */
export const ORG_PURGE_BUDGET_MS = 15_000;

export async function purgeDeletedOrgs(
  deps: SystemDeps & { boss: PgBoss },
  now: () => number = Date.now,
): Promise<{ purged: number; rows: number; jobs: number }> {
  const until = now() + ORG_PURGE_BUDGET_MS;
  const orgs = await deps.withSystem((tx) => unpurgedOrgs(tx));
  const done = { purged: 0, rows: 0, jobs: 0 };
  for (const orgId of orgs) {
    // Work that was waiting for it: gone before a worker picks it up and finds nothing to work on. A job at work
    // ends by itself (its rows are gone); a failed one has nothing left to retry.
    const jobs = await deps.boss
      .getDb()
      .executeSql(
        `delete from ${QUEUE_SCHEMA}.job where data->>'orgId' = $1 and state in ('created', 'retry', 'failed') returning id`,
        [orgId],
      );
    done.jobs += jobs.rows.length;
    let left = true;
    while (left && now() < until) {
      const removed = await deps.withSystem((tx) => purgeOrgRows(tx, orgId));
      done.rows += removed;
      left = removed > 0;
    }
    if (left) break;
    await deps.withSystem((tx) => markOrgPurged(tx, orgId));
    done.purged += 1;
    // The id alone: it names nothing any more.
    (deps.log ?? logger).info("organization purged", { orgId });
  }
  return done;
}

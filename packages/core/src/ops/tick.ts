/**
 * The dispatcher: `system.tick`, every minute, as the system role. It alarms, it never
 * adjudicates: pg-boss owns liveness, so a stuck run is an alert, never a forced failure.
 */
import { sql } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { BUDGETS } from "../budgets";
import { agentInteractiveQueue } from "../jobs/queues";
import { loggableError } from "../loggable";
import { raiseAlert, resolveAlerts, type SystemDeps } from "./alerts";
import { logger } from "./log";

/**
 * A run still active this long after its attempt started is stuck: its queue's job expiry, plus 5 minutes.
 * The Analyst's runs have its interactive time budget, wherever they run (a routine's scheduled question runs on
 * agent.background); the other agents' are background work, whose drafting runs are longer.
 */
export const STUCK_RUN_SECONDS = {
  interactive: BUDGETS.agent.jobExpireSeconds + 5 * 60,
  background: BUDGETS.agent.backgroundJobExpireSeconds + 5 * 60,
};
/** A person's run still queued this long has lost its job (2 minutes, over twice the tick's interval). */
export const QUEUED_RESEND_SECONDS = 2 * 60;
/** A dead-letter alert that hasn't come back for this long is resolved. */
export const DEAD_LETTER_QUIET_SECONDS = 24 * 3600;
/** The health check's "the dispatcher is running": it ran within this long. */
export const TICK_LATE_SECONDS = 3 * 60;

export interface TickResult {
  stuck: number;
  lostJobs: number;
  resolved: number;
}

/** Work the tick does too, given by its caller so the dispatcher doesn't depend on every feature it serves. */
export type TickTask = (now: Date) => Promise<unknown>;

const minutes = (ms: number) => Math.round(ms / 60_000);

export async function systemTick(
  deps: SystemDeps & { boss: PgBoss; now?: () => Date; tasks?: TickTask[] },
): Promise<TickResult> {
  const now = deps.now?.() ?? new Date();
  const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

  // Stuck: active past the threshold. An alert per run, its count growing each minute it stays. No limit: every
  // open alert not in this list is resolved below, so a capped list would clear and re-raise the rest each minute.
  const stuck = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string; attempt: number; attempt_started_at: string; profile: string }>(sql`
      select org_id, id, attempt, attempt_started_at, profile from app.run
      -- A child run (a drafter) runs inside its parent's: the parent is the one to watch.
      where status in ('running', 'cancelling') and parent_run_id is null
        and attempt_started_at < case when profile = 'analyst'
          then ${ago(STUCK_RUN_SECONDS.interactive).toISOString()}::timestamptz
          else ${ago(STUCK_RUN_SECONDS.background).toISOString()}::timestamptz end
      order by attempt_started_at`),
  );
  for (const r of stuck) {
    const started = new Date(r.attempt_started_at);
    const limit = r.profile === "analyst" ? STUCK_RUN_SECONDS.interactive : STUCK_RUN_SECONDS.background;
    await raiseAlert(
      deps,
      {
        orgId: r.org_id,
        kind: "stuck_run",
        subject: r.id,
        message: `Running for ${minutes(now.getTime() - started.getTime())} minutes, past its ${minutes(limit * 1000)}-minute limit. It will be retried or failed; if it stays, the worker's logs say why.`,
        detail: { runId: r.id, attempt: r.attempt, attemptStartedAt: started.toISOString() },
      },
      now,
    );
  }

  // Queued with no job: sent again. The queue keeps one job per run, so a send that creates one found it lost. A child
  // run never has a job: its parent runs it, and sent to a pool it would be run as that pool's agent.
  const queued = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string; queued_at: string }>(sql`
      select org_id, id, queued_at from app.run
      where status = 'queued' and trigger in ('user', 'api') and parent_run_id is null
        and queued_at < ${ago(QUEUED_RESEND_SECONDS).toISOString()}::timestamptz
        -- One that waited past pg-boss's retention is failed instead (failStaleQueuedRuns), never sent again.
        and queued_at >= ${ago(BUDGETS.agent.queuedMaxSeconds).toISOString()}::timestamptz
      order by queued_at`),
  );
  const lost: string[] = [];
  for (const r of queued) {
    const sent = await deps.boss.send(
      agentInteractiveQueue.name,
      { orgId: r.org_id, runId: r.id },
      { singletonKey: r.id },
    );
    if (!sent) continue;
    lost.push(r.id);
    await raiseAlert(
      deps,
      {
        orgId: r.org_id,
        kind: "lost_job",
        subject: r.id,
        message:
          "It waited with no job to answer it, so it was sent again. This shouldn't happen: tell whoever runs OpenDash.",
        detail: { runId: r.id, queuedAt: new Date(r.queued_at).toISOString() },
      },
      now,
    );
  }

  let resolved = await resolveAlerts(
    deps,
    "stuck_run",
    stuck.map((r) => r.id),
    now,
  );
  // A re-sent run's alert stays while it's still queued.
  resolved += await resolveAlerts(
    deps,
    "lost_job",
    queued.map((r) => r.id),
    now,
  );
  const quiet = await deps.withSystem((tx) =>
    tx.execute<{ id: string }>(sql`
      update app.ops_alert set resolved_at = ${now.toISOString()}::timestamptz
      where kind = 'dead_letter' and resolved_at is null and last_seen_at < ${ago(DEAD_LETTER_QUIET_SECONDS).toISOString()}::timestamptz
      returning id`),
  );
  resolved += quiet.length;

  // Each task on its own: one that throws doesn't stop the others, or the tick's own record below.
  for (const task of deps.tasks ?? []) {
    try {
      await task(now);
    } catch (error) {
      (deps.log ?? logger).error("tick task failed", { error: loggableError(error) });
    }
  }

  const result = { stuck: stuck.length, lostJobs: lost.length, resolved };
  await deps.withSystem((tx) =>
    tx.execute(sql`
      insert into app.ops_tick (name, at, result) values ('system.tick', ${now.toISOString()}::timestamptz, ${JSON.stringify(result)}::jsonb)
      on conflict (name) do update set at = excluded.at, result = excluded.result`),
  );
  return result;
}

/** Partition upkeep's result, as an alert of the deployment's: raised while partitions are missing, else resolved. */
export async function partitionsChecked(deps: SystemDeps, missing: number, now: Date = new Date()): Promise<void> {
  if (missing > 0) {
    await raiseAlert(
      deps,
      {
        orgId: null,
        kind: "partitions_missing",
        subject: "partitions",
        message: `${missing} upcoming partitions are missing: writes into them will fail. Check the maint.partitions job's logs.`,
        detail: { missing },
      },
      now,
    );
  } else {
    await resolveAlerts(deps, "partitions_missing", [], now);
  }
}

/** Whether the dispatcher ran recently (the health check), read through `app.last_tick()` by any role. */
export function tickIsLate(lastTick: Date | null, now: Date = new Date()): boolean {
  return !lastTick || now.getTime() - lastTick.getTime() > TICK_LATE_SECONDS * 1000;
}

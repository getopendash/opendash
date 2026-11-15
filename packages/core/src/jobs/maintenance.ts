/**
 * Partition upkeep: creates the periods ahead for every RANGE(id)-partitioned table, drops run_event days past
 * retention and audit_log months past its retention (audit/retention.ts). There is no DEFAULT partition, so a missing
 * one fails writes loudly; this job is what keeps that from happening, and it's correctness-critical. Runs as opendash_system, hourly and at
 * worker start. Retention of query_run (unpinned rows after 90 days) comes with pinning. Stored prompt layers go when no
 * run refers to them any more (dropUnusedPrompts).
 */

import type { Edition } from "@opendash/connectors";
import { type SystemTx, sql } from "@opendash/db";

export const PARTITIONED = [
  { table: "usage_event", period: "month", ahead: 3 },
  { table: "query_run", period: "month", ahead: 3 },
  { table: "run_event", period: "day", ahead: 3 },
  { table: "audit_log", period: "month", ahead: 3 },
] as const;

/** run_event is a stream buffer: 3 days on Cloud, 7 on a self-host. */
export const runEventRetentionDays = (edition: Edition) => (edition === "cloud" ? 3 : 7);

export async function maintainPartitions(
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>,
  edition: Edition,
  /** The audit log's retention in days (auditRetentionDays), or null to drop none of it this time. */
  auditDays: number | null,
): Promise<{ created: number; dropped: string[]; missing: number }> {
  return withSystem(async (tx) => {
    let created = 0;
    for (const p of PARTITIONED) {
      const [row] = await tx.execute<{ n: number }>(
        sql`select app.ensure_partitions(${p.table}, ${p.period}, ${p.ahead}) as n`,
      );
      created += row?.n ?? 0;
    }
    const days = runEventRetentionDays(edition);
    const dropped = await tx.execute<{ name: string }>(
      sql`select app.drop_partitions_before('run_event', make_interval(days => ${days})) as name`,
    );
    // A month's partition goes once its last day is past the retention, so rows live at least that long.
    if (auditDays !== null) {
      dropped.push(
        ...(await tx.execute<{ name: string }>(
          sql`select app.drop_partitions_before('audit_log', make_interval(days => ${auditDays})) as name`,
        )),
      );
    }
    let missing = 0;
    for (const p of PARTITIONED) {
      const [row] = await tx.execute<{ n: number }>(
        sql`select app.missing_partitions(${p.table}, ${p.period}, ${p.ahead}) as n`,
      );
      missing += row?.n ?? 0;
    }
    return { created, dropped: dropped.map((r) => r.name), missing };
  });
}

/**
 * Prompt layers no run refers to any more: a run's later attempt sent other ones, or its conversation was
 * deleted. A layer is kept as long as a run that sent it is; a day's grace keeps this clear of a run being written (and
 * a layer sent again is younger: recordPrompt renews it). Each run's three hashes are one hash join, so this stays
 * linear in the runs (an `in (…)` filter was quadratic: 169 s at 32k runs in one organization).
 */
export async function dropUnusedPrompts(
  withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => Promise<T>,
): Promise<number> {
  return withSystem(async (tx) => {
    const gone = await tx.execute<{ sha256: string }>(sql`
      delete from app.prompt_text p
      where p.created_at < now() - interval '1 day'
        and not exists (
          select 1 from app.run r,
            lateral (values (r.prompt->>'agent'), (r.prompt->>'source'), (r.prompt->>'question')) as used(sha256)
          where r.org_id = p.org_id and used.sha256 = p.sha256)
      returning p.sha256`);
    return gone.length;
  });
}

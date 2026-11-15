/**
 * Telling what a check filed: each routine that watches the metric, and whose condition the finding meets,
 * gets one run for it, at once or in the day's roundup, after its investigation when it asks for one. Only findings
 * filed by this check are told: one already open was told (or not) when it was filed, and a routine made since sees
 * it in Insights. Written in the check's transaction, so a filed finding and its runs land together.
 */
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { DeploymentKeys } from "../ai/settings";
import { BUDGETS } from "../budgets";
import type { Line } from "../checks/crossing";
import { beyondAt } from "../checks/detect";
import { INVESTIGABLE, requestInvestigation } from "../checks/investigate";
import { enqueueOnce } from "../jobs/boss";
import { routineRunQueue } from "../jobs/queues";
import { localDate, nextLocalTime, ROUNDUP_AT } from "./schedule";
import { type FoundSpec, needsManager, SENSITIVITY, type SlackDestination } from "./spec";

/** An insight a check filed for the first time. */
export interface Filed {
  id: string;
  kind: "anomaly" | "trend" | "threshold" | "goal_risk" | "data_quality";
  metricId: string | null;
  connectionId: string;
  /** An anomaly's value against its centre, and its band's width at k = 1: judged at each routine's sensitivity. */
  band?: { value: number; expected: number; spread: number };
  /** A crossing's line. */
  line?: Line;
  /** Null: the workspace's. Set: found only for that person's private routines, and told to them alone. */
  ownerId?: string | null;
}

/** An active routine that watches, as the check loads it. */
export interface WatchingRoutine {
  id: string;
  spec: FoundSpec;
  userIds: string[];
  slack: SlackDestination[];
  /** The sources its metrics are on (for a source's late data). */
  connectionIds: string[];
  /** Its owner is a viewer now: it tells at once, and nothing is investigated for it (a viewer doesn't ask). */
  ownerViewer: boolean;
  /**
   * Its owner, when it tells only them (no channel, nobody else, not Watching): what only it watches for is filed as
   * theirs alone. Null for a routine that reaches past its owner: what it finds is the workspace's.
   */
  privateTo: string | null;
}

/**
 * Who a finding is for, in its key: the workspace's as it is, a person's own prefixed with them, so the workspace's
 * keys and each person's never meet (a dismissal, a dedupe or a resolution of one is never another's).
 */
export const audienceKey = (ownerId: string | null, key: string) => (ownerId ? `private:${ownerId}:${key}` : key);

/** Whether a routine tells a finding: it reaches someone, it watches the metric (or its source), and it's its kind. */
export function tellsAbout(r: WatchingRoutine, f: Filed): boolean {
  if (!r.userIds.length && !r.slack.length) return false;
  // A person's own finding is told only by their own private routines.
  if (f.ownerId && f.ownerId !== r.privateTo) return false;
  const c = r.spec.condition;
  if (f.kind === "data_quality") return c.kind === "missing" && r.connectionIds.includes(f.connectionId);
  if (!f.metricId || !r.spec.metricIds.includes(f.metricId)) return false;
  if (f.kind === "anomaly") return c.kind === "unusual" && (!f.band || beyondAt(f.band, SENSITIVITY[c.sensitivity]));
  if (f.kind === "trend") return c.kind === "unusual";
  if (f.kind === "goal_risk") return c.kind === "goal_risk";
  return c.kind === "crosses" && f.line?.direction === c.direction && f.line.value === c.value;
}

/** The active routines that watch a metric, or (for its source's late data) any metric on its source. */
export async function watchingRoutines(
  tx: TenantTx,
  orgId: string,
  metric: { id: string; connectionId: string },
): Promise<WatchingRoutine[]> {
  const rows = await tx.execute<{
    id: string;
    spec: FoundSpec;
    user_ids: string[];
    slack: SlackDestination[];
    connection_ids: string[];
    owner_viewer: boolean;
    owner_id: string;
    key: string | null;
  }>(sql`
    select r.id, r.spec, r.user_ids, r.slack, r.owner_id, r.key,
      coalesce(app.member_role(r.owner_id) = 'viewer', false) as owner_viewer,
      array(select distinct i.connection_id from app.context_item i
        where i.org_id = r.org_id and i.id::text in (select jsonb_array_elements_text(r.spec->'metricIds'))
      ) as connection_ids
    from app.routine r
    where r.org_id = ${orgId} and r.trigger = 'found' and r.status = 'active' and r.deleted_at is null
      and (r.spec->'metricIds' @> ${JSON.stringify([metric.id])}::jsonb
        or (r.spec->'condition'->>'kind' = 'missing' and exists (
          select 1 from app.context_item i where i.org_id = r.org_id and i.connection_id = ${metric.connectionId}
            and i.id::text in (select jsonb_array_elements_text(r.spec->'metricIds')))))
    order by r.created_at, r.id`);
  return rows.map((r) => ({
    id: r.id,
    spec: r.spec,
    userIds: r.user_ids,
    slack: r.slack,
    connectionIds: r.connection_ids,
    ownerViewer: r.owner_viewer,
    privateTo: needsManager({ key: r.key, ownerId: r.owner_id, userIds: r.user_ids, slack: r.slack })
      ? null
      : r.owner_id,
  }));
}

/** The sensitivity a check files anomalies at: the most sensitive of the routines that watch for them (else medium). */
export function filingK(routines: WatchingRoutine[]): number {
  const ks = routines.flatMap((r) =>
    r.spec.condition.kind === "unusual" ? [SENSITIVITY[r.spec.condition.sensitivity]] : [],
  );
  return ks.length ? Math.min(...ks) : SENSITIVITY.medium;
}

/** Makes the runs that tell what a check filed. The number of runs made. */
export async function tellFindings(
  tx: TenantTx,
  deps: { boss: PgBoss; deploymentKeys: DeploymentKeys },
  input: { orgId: string; tz: string; filed: Filed[]; routines: WatchingRoutine[] },
  now = new Date(),
): Promise<number> {
  let made = 0;
  for (const r of input.routines) {
    const told = input.filed.filter((f) => tellsAbout(r, f));
    if (!told.length) continue;
    const investigated = new Map<string, boolean>();
    if (r.spec.investigate && !r.ownerViewer) {
      for (const f of told) {
        if (!(INVESTIGABLE as readonly string[]).includes(f.kind)) continue;
        const { status } = await requestInvestigation(tx, deps, { orgId: input.orgId, insightId: f.id }, now);
        investigated.set(f.id, status === "queued" || status === "running");
      }
    }
    if (r.spec.tell === "roundup") {
      made += await addToRoundup(tx, input.orgId, input.tz, r, told, now);
      continue;
    }
    for (const f of told) {
      // It waits for its investigation, at most so long; held or not investigable, it goes now.
      const waits = investigated.get(f.id) === true;
      const [run] = await tx.execute<{ id: string }>(sql`
        insert into app.routine_run (org_id, id, routine_id, trigger_key, status, due_at, spec_snapshot, insight_ids)
        values (${input.orgId}, ${uuidv7()}, ${r.id}, ${`found:${f.id}`}, ${waits ? "waiting" : "queued"},
          ${waits ? new Date(now.getTime() + BUDGETS.routines.investigateWaitMs).toISOString() : null},
          ${JSON.stringify(r.spec)}::jsonb, ${`{${f.id}}`}::uuid[])
        on conflict (org_id, routine_id, trigger_key) do nothing returning id`);
      if (!run) continue;
      made++;
      if (!waits) {
        await enqueueOnce(
          deps.boss,
          tx,
          routineRunQueue,
          { orgId: input.orgId, routineRunId: run.id },
          {
            singletonKey: run.id,
          },
        );
      }
    }
  }
  return made;
}

/**
 * Adds findings to the routine's roundup for its next 07:00 (keyed by that local day). A roundup that already left
 * (released as this check ran) takes them no more: they go in the next day's.
 */
async function addToRoundup(
  tx: TenantTx,
  orgId: string,
  tz: string,
  r: WatchingRoutine,
  told: Filed[],
  now: Date,
): Promise<number> {
  const ids = `{${told.map((f) => f.id).join(",")}}`;
  let due = nextLocalTime(ROUNDUP_AT, tz, now);
  for (let attempt = 0; attempt < 2; attempt++) {
    const [run] = await tx.execute<{ id: string }>(sql`
      insert into app.routine_run (org_id, id, routine_id, trigger_key, status, due_at, spec_snapshot, insight_ids)
      values (${orgId}, ${uuidv7()}, ${r.id}, ${`roundup:${localDate(due, tz)}`}, 'waiting', ${due.toISOString()},
        ${JSON.stringify(r.spec)}::jsonb, ${ids}::uuid[])
      on conflict (org_id, routine_id, trigger_key) do update set updated_at = now(),
        insight_ids = array(select distinct x from unnest(app.routine_run.insight_ids || excluded.insight_ids) x)
        where app.routine_run.status = 'waiting'
      returning id`);
    if (run) return 1;
    due = nextLocalTime(ROUNDUP_AT, tz, due);
  }
  // Two days' roundups already gone: it can't be, but a finding is never dropped silently.
  throw new Error("No roundup to add the findings to");
}

/**
 * Tasks v0 (what the team decided to do about an insight. Anyone
 * who can ask creates one from an insight; its owner (or an owner or admin of the organization) starts it, marks it
 * done or dismisses it. Done, its outcome is checked over the whole months after it (tasks/check.ts).
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { AnomalyClaims, CellClaim, GoalRiskClaims, ThresholdClaims, TrendClaims } from "../checks/check";
import { insightReadableBy } from "../checks/insights";
import type { GatewayDeps } from "../gateway/gateway";
import { enqueueOnce } from "../jobs/boss";
import { outcomeCheckQueue } from "../jobs/queues";
import type { SystemDeps } from "../ops/alerts";
import { checkAt, monthAfter, type OutcomeSpec, type Verdict } from "./outcome";

export class TaskProblem extends Error {
  constructor(
    readonly code: "invalid" | "not_found" | "not_yours",
    message: string,
  ) {
    super(message);
  }
}

/** How many whole months after it a task can be judged over. */
export const HORIZONS = [1, 2, 3, 6] as const;
/** A difference from the projection smaller than this is no change (as the detector's default materiality). */
export const OUTCOME_THRESHOLD = 0.05;

export type TaskStatus = "accepted" | "in_progress" | "done" | "dismissed";

export interface TaskOutcome {
  verdict: Verdict;
  reason: string | null;
  /** The horizon's last month: a cell of the check's query run. */
  observed: (CellClaim & { display: string }) | null;
  projected: { value: number; display: string } | null;
  delta: number | null;
  /** The trend's months, for "projected from the 6 months before". */
  trendMonths: number | null;
  checkedAt: string;
}

export interface TaskView {
  id: string;
  title: string;
  status: TaskStatus;
  /** The insight it came from as it read then: its value, and what it was against ("expected 84–94"). */
  insight: { id: string; title: string; value: string | null; note: string | null } | null;
  metric: { id: string; title: string } | null;
  connectionId: string | null;
  direction: "up" | "down";
  horizonMonths: number;
  ownerId: string | null;
  mine: boolean;
  dueAt: string | null;
  doneAt: string | null;
  checkAt: string | null;
  outcome: TaskOutcome | null;
  updatedAt: string;
}

type CheckSpec = OutcomeSpec & { metricId: string; connectionId: string };

/** Creates a task from an anomaly insight, owned by its creator, to do. */
export async function createTask(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  input: { insightId: string; title: string; direction: "up" | "down"; horizonMonths: number; dueAt?: string | null },
  now = new Date(),
): Promise<string> {
  const title = input.title?.trim();
  if (!title) throw new TaskProblem("invalid", "Say what the task is.");
  if (title.length > 160) throw new TaskProblem("invalid", "Keep the task under 160 characters.");
  if (input.direction !== "up" && input.direction !== "down") {
    throw new TaskProblem("invalid", "Say which way it should move the metric.");
  }
  if (!(HORIZONS as readonly number[]).includes(input.horizonMonths)) {
    throw new TaskProblem("invalid", "Judge it over 1, 2, 3 or 6 months.");
  }
  const due = input.dueAt?.trim() || null;
  if (due && (!/^\d{4}-\d{2}-\d{2}$/.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`)))) {
    throw new TaskProblem("invalid", "The due date is a day: YYYY-MM-DD.");
  }
  if (due && due < now.toISOString().slice(0, 10)) throw new TaskProblem("invalid", "Pick a due date from today on.");
  const [i] = isUuid(input.insightId)
    ? await tx.execute<{
        id: string;
        title: string;
        kind: "anomaly" | "goal_risk" | "trend" | "threshold";
        metric_id: string | null;
        connection_id: string;
        claims: Partial<AnomalyClaims & GoalRiskClaims & TrendClaims & ThresholdClaims>;
      }>(sql`
        select n.id, n.title, n.kind, n.metric_id, n.connection_id, n.claims from app.insight n
        where n.org_id = ${ctx.orgId} and n.id = ${input.insightId}
          and n.kind in ('anomaly', 'goal_risk', 'trend', 'threshold') and ${insightReadableBy(ctx.userId)}`)
    : [];
  if (!i?.metric_id) throw new TaskProblem("not_found", "That insight doesn't exist, or has no metric to move.");
  const id = uuidv7();
  const whyNow = {
    insightId: i.id,
    title: i.title,
    value: i.claims.value?.display ?? null,
    note: whyNowNote(i.kind, i.claims),
    period: i.claims.value?.period ?? null,
  };
  await tx.execute(sql`
    insert into app.todo (org_id, id, insight_id, metric_id, connection_id, title, why_now, expected_impact, owner_id,
      created_by, due_at)
    values (${ctx.orgId}, ${id}, ${i.id}, ${i.metric_id}, ${i.connection_id}, ${title}, ${JSON.stringify(whyNow)}::jsonb,
      ${JSON.stringify({ direction: input.direction, horizonMonths: input.horizonMonths })}::jsonb, ${ctx.userId},
      ${ctx.userId}, ${due})`);
  return id;
}

/** The figure a task's why-now quotes beside its value: the band, the goal, the line, or the change before and lately. */
function whyNowNote(
  kind: string,
  c: Partial<AnomalyClaims & GoalRiskClaims & TrendClaims & ThresholdClaims>,
): string | null {
  if (kind === "goal_risk") return c.goal ? `goal ${c.goal.target.display}` : null;
  if (kind === "threshold") return c.line ? `the line is ${c.line.display}` : null;
  if (kind === "trend") return c.before && c.recent ? `was ${c.before.display}, lately ${c.recent.display}` : null;
  return c.expected ? `expected ${c.expected.display}` : null;
}

const NEXT: Record<string, TaskStatus[]> = {
  accepted: ["in_progress", "done", "dismissed"],
  in_progress: ["done", "dismissed"],
};

/**
 * Starts, finishes or dismisses a task: its owner's, or an owner's or admin's of the organization. Done schedules its
 * outcome check for the morning after its horizon's last whole month.
 */
export async function setTaskStatus(
  tx: TenantTx,
  ctx: { orgId: string; userId: string; canManage: boolean },
  id: string,
  status: Exclude<TaskStatus, "accepted">,
  now = new Date(),
): Promise<void> {
  const [t] = isUuid(id)
    ? await tx.execute<{
        status: string;
        owner_id: string | null;
        metric_id: string | null;
        connection_id: string | null;
        expected_impact: { direction?: "up" | "down"; horizonMonths?: number };
      }>(sql`
        select status, owner_id, metric_id, connection_id, expected_impact from app.todo
        where org_id = ${ctx.orgId} and id = ${id} for update`)
    : [];
  if (!t) throw new TaskProblem("not_found", "That task doesn't exist.");
  if (t.owner_id !== ctx.userId && !ctx.canManage)
    throw new TaskProblem("not_yours", "Only its owner changes this task.");
  if (!(NEXT[t.status] ?? []).includes(status)) {
    throw new TaskProblem("invalid", t.status === "done" ? "It's done already." : "It was dismissed.");
  }
  if (status !== "done") {
    await tx.execute(sql`
      update app.todo set status = ${status}, updated_at = now() where org_id = ${ctx.orgId} and id = ${id}`);
    return;
  }
  const horizon = t.expected_impact.horizonMonths ?? 2;
  const spec: CheckSpec | null =
    t.metric_id && t.connection_id
      ? {
          metricId: t.metric_id,
          connectionId: t.connection_id,
          direction: t.expected_impact.direction ?? "up",
          fromMonth: monthAfter(now),
          horizonMonths: horizon,
          threshold: OUTCOME_THRESHOLD,
        }
      : null;
  await tx.execute(sql`
    update app.todo set status = 'done', done_at = ${now.toISOString()}, updated_at = now(),
      check_at = ${spec ? checkAt(now, horizon).toISOString() : null},
      check_spec = ${spec ? sql`${JSON.stringify(spec)}::jsonb` : sql`null`}
    where org_id = ${ctx.orgId} and id = ${id}`);
}

/** Open (to do, in progress) or closed (done, dismissed) tasks, optionally only the viewer's, newest first. */
export async function listTasks(
  tx: TenantTx,
  viewer: { orgId: string; userId: string | null },
  options: { status?: "open" | "closed"; mine?: boolean; limit?: number } = {},
): Promise<TaskView[]> {
  const open = (options.status ?? "open") === "open";
  const rows = await tx.execute<{
    id: string;
    title: string;
    status: TaskStatus;
    why_now: { insightId?: string; title?: string; value?: string | null; note?: string | null };
    metric_id: string | null;
    metric_title: string | null;
    connection_id: string | null;
    expected_impact: { direction?: "up" | "down"; horizonMonths?: number };
    owner_id: string | null;
    due_at: string | null;
    done_at: string | null;
    check_at: string | null;
    updated_at: string;
    o_verdict: Verdict | null;
    o_counterfactual: {
      reason?: string;
      observed?: CellClaim & { display: string };
      projected?: { value: number; display: string };
      trend?: { months: number };
    } | null;
    o_delta: number | null;
    o_created_at: string | null;
  }>(sql`
    select t.id, t.title, t.status, t.why_now, t.metric_id, i.title as metric_title, t.connection_id, t.expected_impact,
      t.owner_id, t.due_at::text, t.done_at, t.check_at, t.updated_at,
      o.verdict as o_verdict, o.counterfactual as o_counterfactual, o.delta as o_delta, o.created_at as o_created_at
    from app.todo t
    left join app.context_item i on i.org_id = t.org_id and i.id = t.metric_id and i.deleted_at is null
    left join app.outcome o on o.org_id = t.org_id and o.todo_id = t.id and o.check_no = t.check_no and t.check_no > 0
    where t.org_id = ${viewer.orgId}
      and t.status in ${open ? sql`('accepted', 'in_progress')` : sql`('done', 'dismissed')`}
      ${options.mine ? sql`and t.owner_id is not distinct from ${viewer.userId}` : sql``}
    order by ${open ? sql`t.due_at nulls last, t.updated_at desc` : sql`coalesce(t.done_at, t.updated_at) desc`}
    limit ${Math.min(Math.max(options.limit ?? 50, 1), 200)}`);
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    insight: r.why_now.insightId
      ? {
          id: r.why_now.insightId,
          title: r.why_now.title ?? "",
          value: r.why_now.value ?? null,
          note: r.why_now.note ?? null,
        }
      : null,
    metric: r.metric_id && r.metric_title ? { id: r.metric_id, title: r.metric_title } : null,
    connectionId: r.connection_id,
    direction: r.expected_impact.direction ?? "up",
    horizonMonths: r.expected_impact.horizonMonths ?? 2,
    ownerId: r.owner_id,
    mine: r.owner_id !== null && r.owner_id === viewer.userId,
    dueAt: r.due_at,
    doneAt: r.done_at ? new Date(r.done_at).toISOString() : null,
    checkAt: r.check_at ? new Date(r.check_at).toISOString() : null,
    outcome:
      r.o_verdict && r.o_created_at
        ? {
            verdict: r.o_verdict,
            reason: r.o_counterfactual?.reason ?? null,
            observed: r.o_counterfactual?.observed ?? null,
            projected: r.o_counterfactual?.projected ?? null,
            delta: r.o_delta,
            trendMonths: r.o_counterfactual?.trend?.months ?? null,
            checkedAt: new Date(r.o_created_at).toISOString(),
          }
        : null,
    updatedAt: new Date(r.updated_at).toISOString(),
  }));
}

/**
 * The dispatcher's part: done tasks whose check is due are queued (and moved a day on, so a lost job runs again
 * tomorrow rather than every minute). At most 50 a minute.
 */
export async function queueDueOutcomeChecks(
  deps: SystemDeps & { withTenant: GatewayDeps["withTenant"]; boss: PgBoss },
  now = new Date(),
): Promise<number> {
  const due = await deps.withSystem((tx) =>
    tx.execute<{ org_id: string; id: string }>(sql`
      select org_id, id from app.todo
      where status = 'done' and check_no = 0 and check_at <= ${now.toISOString()}::timestamptz
      order by check_at limit 50`),
  );
  for (const t of due) {
    await deps.withTenant(t.org_id, async (tx) => {
      await tx.execute(sql`
        update app.todo set check_at = check_at + interval '1 day' where org_id = ${t.org_id} and id = ${t.id}`);
      await enqueueOnce(deps.boss, tx, outcomeCheckQueue, { orgId: t.org_id, todoId: t.id }, { singletonKey: t.id });
    });
  }
  return due.length;
}

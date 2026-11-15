/**
 * Insights: what metric checks found, in the organization's feed. Everyone sees the workspace's and
 * can investigate one; owners and admins dismiss them, with a reason (a signal for later tuning). A private routine's
 * own findings (`owner_id`) are its owner's alone: only they see, investigate or dismiss them. The figures are claims
 * on query-run cells.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { AnomalyClaims, GoalRiskClaims, ThresholdClaims, TrendClaims } from "./check";

export const DISMISS_REASONS = ["not_a_problem", "known_issue", "wrong_data", "not_my_area"] as const;

/** Whose findings a reader sees (`n` the insight): the workspace's, and their own; with no one, the workspace's. */
export const insightReadableBy = (userId: string | null) =>
  userId && isUuid(userId) ? sql`(n.owner_id is null or n.owner_id = ${userId})` : sql`n.owner_id is null`;

/** Who reads: a person (the workspace's findings and their own), or no one in particular (a channel: the workspace's). */
export type InsightReader = { orgId: string; userId: string | null };
export type DismissReason = (typeof DISMISS_REASONS)[number];

export interface InsightView {
  id: string;
  kind: "anomaly" | "data_quality" | "goal_risk" | "trend" | "threshold";
  title: string;
  summary: string;
  severity: 1 | 2 | 3;
  direction: "up" | "down" | null;
  period: string;
  status: "new" | "seen" | "dismissed" | "resolved";
  dismissReason: DismissReason | null;
  connectionId: string;
  connectionName: string;
  /** The check that found it. */
  checkId: string | null;
  /** Found for the reader's own private routine: theirs alone (nobody else sees it), and theirs to dismiss. */
  mine: boolean;
  /** An unusual value's figures; null otherwise. */
  claims: AnomalyClaims | null;
  /** A line crossed's figures; null otherwise. */
  threshold: ThresholdClaims | null;
  /** A goal at risk's figures; null otherwise. */
  goalRisk: GoalRiskClaims | null;
  /** A trend's figures; null otherwise. */
  trend: TrendClaims | null;
  /** Tasks made from it that weren't dismissed. */
  tasks: number;
  /** Its check's periods up to the insight's, at most 12 (the card's sparkline). */
  series: { period: string; value: number }[];
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/**
 * Open (new or seen) or closed (dismissed or resolved), newest first, up to `limit` (50 unless said, 200 at most); or
 * these ones, whatever they are now, all of them (a day's roundup tells every finding it gathered).
 */
export async function listInsights(
  tx: TenantTx,
  reader: InsightReader,
  options: { status?: "open" | "closed"; limit?: number; ids?: string[] } = {},
): Promise<InsightView[]> {
  const { orgId } = reader;
  const open = (options.status ?? "open") === "open";
  const ids = options.ids?.filter(isUuid);
  if (ids && !ids.length) return [];
  const rows = await tx.execute<{
    id: string;
    kind: InsightView["kind"];
    title: string;
    summary: string;
    severity: number;
    direction: InsightView["direction"];
    period: string;
    status: InsightView["status"];
    dismiss_reason: DismissReason | null;
    connection_id: string;
    connection_name: string | null;
    check_id: string | null;
    claims: AnomalyClaims | ThresholdClaims | GoalRiskClaims | TrendClaims | Record<string, never>;
    owner_id: string | null;
    series: { period: string; value: number }[] | null;
    tasks: number;
    occurrences: number;
    first_seen_at: string;
    last_seen_at: string;
  }>(sql`
    select n.id, n.kind, n.title, n.summary, n.severity, n.direction, n.period::text, n.status, n.dismiss_reason,
      n.connection_id, c.name as connection_name, n.check_id, n.claims, n.owner_id, n.occurrences, n.first_seen_at,
      n.last_seen_at,
      (select jsonb_agg(jsonb_build_object('period', o.period_start::text, 'value', o.value) order by o.period_start)
        from (select period_start, value from app.observation o
          where o.org_id = n.org_id and o.check_id = n.check_id and o.period_start <= n.period
          order by period_start desc limit 12) o) as series,
      (select count(*)::int from app.todo t where t.org_id = n.org_id and t.insight_id = n.id
        and t.status <> 'dismissed') as tasks
    from app.insight n
    left join app.connection c on c.org_id = n.org_id and c.id = n.connection_id
    where n.org_id = ${orgId} and ${insightReadableBy(reader.userId)} and ${
      ids
        ? sql`n.id = any(${`{${ids.join(",")}}`}::uuid[])`
        : sql`n.status in ${open ? sql`('new', 'seen')` : sql`('dismissed', 'resolved')`}`
    }
    order by ${open || ids ? sql`n.severity desc, n.period desc, n.last_seen_at desc` : sql`coalesce(n.status_at, n.last_seen_at) desc`}
    limit ${ids ? ids.length : Math.min(Math.max(options.limit ?? 50, 1), 200)}`);
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    summary: r.summary,
    severity: Math.min(3, Math.max(1, r.severity)) as 1 | 2 | 3,
    direction: r.direction,
    period: r.period.slice(0, 10),
    status: r.status,
    dismissReason: r.dismiss_reason,
    connectionId: r.connection_id,
    connectionName: r.connection_name ?? "",
    checkId: r.check_id,
    mine: r.owner_id !== null,
    claims: r.kind === "anomaly" && "value" in r.claims ? (r.claims as AnomalyClaims) : null,
    threshold: r.kind === "threshold" && "line" in r.claims ? (r.claims as ThresholdClaims) : null,
    goalRisk: r.kind === "goal_risk" && "goal" in r.claims ? (r.claims as GoalRiskClaims) : null,
    trend: r.kind === "trend" && "since" in r.claims ? (r.claims as TrendClaims) : null,
    series: r.kind === "anomaly" || r.kind === "trend" || r.kind === "threshold" ? (r.series ?? []) : [],
    tasks: r.tasks,
    occurrences: r.occurrences,
    firstSeenAt: new Date(r.first_seen_at).toISOString(),
    lastSeenAt: new Date(r.last_seen_at).toISOString(),
  }));
}

/** How many insights are open that this reader sees: the sidebar's count. */
export async function openInsightCount(tx: TenantTx, reader: InsightReader): Promise<number> {
  const [r] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.insight n
    where n.org_id = ${reader.orgId} and n.status in ('new', 'seen') and ${insightReadableBy(reader.userId)}`);
  return r?.n ?? 0;
}

/**
 * Dismisses an open insight, with why: one of the workspace's for everyone (owners and admins), or someone's own (only
 * they). False when it isn't open, doesn't exist, or isn't theirs to dismiss.
 */
export async function dismissInsight(
  tx: TenantTx,
  ctx: { orgId: string; userId: string; canManage: boolean },
  id: string,
  reason: DismissReason,
): Promise<boolean> {
  if (!isUuid(id) || !DISMISS_REASONS.includes(reason)) return false;
  const rows = await tx.execute(sql`
    update app.insight n set status = 'dismissed', dismiss_reason = ${reason}, status_by = ${ctx.userId}, status_at = now()
    where n.org_id = ${ctx.orgId} and n.id = ${id} and n.status in ('new', 'seen')
      and (n.owner_id = ${ctx.userId} or (n.owner_id is null and ${ctx.canManage}))
    returning n.id`);
  return rows.length > 0;
}

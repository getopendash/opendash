/**
 * Send what OpenDash found (was the weekly digest): composed for each person when it's sent, so it's what's
 * open in Insights then, the most severe first, and that person's own open tasks (a Slack channel gets what's open,
 * nobody's tasks). Nothing to say, nothing is sent.
 */
import { sql, type TenantTx } from "@opendash/db";
import { insightReadableBy, listInsights } from "../../checks/insights";
import { listTasks } from "../../tasks/store";

/** What a digest says, before it's rendered (the shape @opendash/email's digestEmail takes, less its links). */
export interface DigestContent {
  counts: { insights: number; goalsAtRisk: number; tasks: number };
  insights: { title: string; detail?: string }[];
  tasks: { title: string; detail?: string }[];
}

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const month = (period: string) => MONTH.format(new Date(`${period.slice(0, 10)}T00:00:00Z`));

/**
 * The digest now: the most severe open insights and the person's open tasks, five each; for a channel (no person),
 * the insights alone. Null with nothing to say.
 */
export async function composeDigest(
  tx: TenantTx,
  ctx: { orgId: string; userId: string | null },
): Promise<DigestContent | null> {
  const userId = ctx.userId;
  const [insights, open, tasks] = await Promise.all([
    listInsights(tx, ctx, { status: "open", limit: 5 }),
    tx.execute<{ total: number; goals: number }>(sql`
      select count(*)::int as total, count(*) filter (where kind = 'goal_risk')::int as goals from app.insight n
      where n.org_id = ${ctx.orgId} and n.status in ('new', 'seen') and ${insightReadableBy(userId)}`),
    userId ? listTasks(tx, { orgId: ctx.orgId, userId }, { status: "open", mine: true, limit: 200 }) : [],
  ]);
  const counts = { insights: open[0]?.total ?? 0, goalsAtRisk: open[0]?.goals ?? 0, tasks: tasks.length };
  if (!counts.insights && !counts.tasks) return null;
  return {
    counts,
    insights: insights.map((i) => {
      const detail = i.claims
        ? `${i.claims.value.display} · expected ${i.claims.expected.display}`
        : i.threshold
          ? `${i.threshold.value.display} · the line is ${i.threshold.line.display}`
          : i.goalRisk
            ? `${i.goalRisk.value.display} in ${month(i.goalRisk.value.period)} · ${i.goalRisk.projected.display} projected for ${month(i.goalRisk.projected.month)} · goal ${i.goalRisk.goal.target.display}`
            : i.trend
              ? `${i.trend.value.display} in ${month(i.trend.value.period)} · ${i.trend.recent.display} lately, against ${i.trend.before.display} before`
              : i.summary;
      return { title: i.title, detail };
    }),
    tasks: tasks.slice(0, 5).map((t) => ({
      title: t.title,
      detail: `${t.status === "in_progress" ? "In progress" : "To do"}${t.dueAt ? ` · due ${DAY.format(new Date(`${t.dueAt}T00:00:00Z`))}` : ""}`,
    })),
  };
}

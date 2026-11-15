/**
 * Settings → Health: an organization's alerts in words, each with what it's about and where to
 * go, and the questions that failed in the last 7 days by reason. Read as the viewer: a stalled question in a
 * teammate's private conversation, or a private dashboard, is named only to whoever may open it.
 */

import { sql, type TenantTx } from "@opendash/db";
import { dashboardReadableBy, threadReadableBy } from "../projects/access";
import type { Viewer } from "../runs/ledger";
import type { AlertKind } from "./alerts";

export interface HealthAlert {
  id: string;
  kind: AlertKind;
  /** "A question stalled", "A connection test didn't finish". */
  title: string;
  message: string;
  /** What it's about, as the viewer may see it: a question, a source's name. */
  context: string | null;
  href: string | null;
  /** The button's words for `href`. */
  action: string | null;
  count: number;
  lastSeenAt: string;
  resolvedAt: string | null;
}

export interface OrgHealth {
  open: HealthAlert[];
  resolved: HealthAlert[];
  failed: { reason: string; questions: number; lastAt: string }[];
}

const DEAD_LETTER_TITLES: Record<string, string> = {
  "connection.test.dlq": "A connection test didn't finish",
  "catalog.sync.dlq": "Learning a source didn't finish",
  "definitions.check.dlq": "Checking definitions didn't finish",
  "agent.interactive.dlq": "The analyst stopped on a question",
  "eval.run.dlq": "An eval run didn't finish",
  "eval.case.dlq": "An eval case didn't finish",
  "ai_provider.test.dlq": "An AI provider's test didn't finish",
  "ai_provider.refresh.dlq": "AI providers' model lists weren't refreshed",
  "query.exec.dlq": "A dashboard's query failed",
};

const titleOf = (kind: AlertKind, subject: string, detail: Record<string, unknown>) =>
  kind === "stuck_run"
    ? "A question stalled"
    : kind === "lost_job"
      ? "A question was sent again"
      : kind === "dead_letter"
        ? (DEAD_LETTER_TITLES[subject] ?? "Background work didn't finish")
        : kind === "spend"
          ? Number(detail.spentUsd) >= Number(detail.limitUsd)
            ? "AI spend reached its limit"
            : "AI spend is near its limit"
          : "Partitions are missing";

type Row = {
  id: string;
  kind: AlertKind;
  subject: string;
  message: string;
  detail: Record<string, unknown>;
  count: number;
  last_seen_at: string;
  resolved_at: string | null;
};

const ids = (values: unknown[]) => [...new Set(values.filter((v): v is string => typeof v === "string"))];
const inList = (list: string[]) =>
  sql.join(
    list.map((v) => sql`${v}`),
    sql`, `,
  );

export async function orgHealth(tx: TenantTx, viewer: Viewer): Promise<OrgHealth> {
  const rows = await tx.execute<Row>(sql`
    select id, kind, subject, message, detail, count, last_seen_at, resolved_at from app.ops_alert
    where org_id = ${viewer.orgId} and (resolved_at is null or resolved_at > now() - interval '7 days')
    order by last_seen_at desc limit 100`);
  const runOf = (r: Row) =>
    r.kind === "stuck_run" || r.kind === "lost_job" ? r.subject : (r.detail.runId as string | undefined);
  const runIds = ids(rows.map(runOf));
  // A conversation's title only for whoever may read it; its link for them too.
  const runs = runIds.length
    ? await tx.execute<{ id: string; thread_id: string; title: string | null }>(sql`
        select r.id, r.thread_id,
          case when ${threadReadableBy(viewer.userId)} then t.title end as title
        from app.run r join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
        where r.org_id = ${viewer.orgId} and r.id in (${inList(runIds)})`)
    : [];
  const testIds = ids(rows.map((r) => r.detail.testId));
  const syncIds = ids(rows.map((r) => r.detail.syncRunId));
  const connectionIds = ids(rows.map((r) => r.detail.connectionId));
  const sources = await tx.execute<{ key: string; connection_id: string; name: string }>(sql`
    select ct.id::text as key, c.id as connection_id, c.name from app.connection_test ct
    join app.connection c on c.org_id = ct.org_id and c.id = ct.connection_id
    where ct.org_id = ${viewer.orgId} and ct.id in (${testIds.length ? inList(testIds) : sql`null`})
    union all
    select s.id::text, c.id, c.name from app.sync_run s join app.connection c on c.org_id = s.org_id and c.id = s.connection_id
    where s.org_id = ${viewer.orgId} and s.id in (${syncIds.length ? inList(syncIds) : sql`null`})
    union all
    select c.id::text, c.id, c.name from app.connection c
    where c.org_id = ${viewer.orgId} and c.id in (${connectionIds.length ? inList(connectionIds) : sql`null`})`);
  const dashboardIds = ids(rows.map((r) => r.detail.dashboardId));
  const dashboards = dashboardIds.length
    ? await tx.execute<{ id: string; title: string }>(sql`
        select d.id, d.title from app.dashboard d
        where d.org_id = ${viewer.orgId} and d.id in (${inList(dashboardIds)}) and d.deleted_at is null
          and ${dashboardReadableBy(viewer.userId)}`)
    : [];

  const view = (r: Row): HealthAlert => {
    let context: string | null = null;
    let href: string | null = null;
    let action: string | null = null;
    const runId = runOf(r);
    const run = runId ? runs.find((x) => x.id === runId) : undefined;
    if (run) {
      if (run.title) {
        context = `“${run.title}”`;
        href = `/ask/${run.thread_id}`;
        action = "Open conversation";
      } else {
        context = "A teammate's private conversation";
      }
    }
    const sourceKey = [r.detail.testId, r.detail.syncRunId, r.detail.connectionId].find((v) => typeof v === "string");
    const source = sourceKey ? sources.find((x) => x.key === sourceKey) : undefined;
    if (source) {
      context = source.name;
      href = `/data/sources/${source.connection_id}`;
      action = "Open source";
    }
    if (typeof r.detail.dashboardId === "string") {
      const a = dashboards.find((x) => x.id === r.detail.dashboardId);
      context = a ? a.title : "A dashboard not shared with you";
      if (a) {
        href = `/dashboards/${a.id}`;
        action = "Open dashboard";
      }
    }
    if (r.kind === "spend") {
      href = "/settings/usage";
      action = "Open usage";
    }
    if (r.subject === "ai_provider.test.dlq" || r.subject === "ai_provider.refresh.dlq") {
      href = "/settings/ai";
      action = "Open AI";
    }
    if (r.subject === "eval.run.dlq" || r.subject === "eval.case.dlq") {
      href = "/knowledge/evals";
      action = "Open evals";
    }
    return {
      id: r.id,
      kind: r.kind,
      title: titleOf(r.kind, r.subject, r.detail),
      message: r.message,
      context,
      href,
      action,
      count: r.count,
      lastSeenAt: new Date(r.last_seen_at).toISOString(),
      resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    };
  };

  // People's questions only (an eval case's failure is its run's result).
  const failed = await tx.execute<{ reason: string; questions: number; last_at: string }>(sql`
    select coalesce(nullif(error, ''), 'No reason was recorded.') as reason, count(*)::int as questions,
      max(finished_at) as last_at
    from app.run
    where org_id = ${viewer.orgId} and status = 'failed' and parent_run_id is null and trigger <> 'eval'
      and finished_at > now() - interval '7 days'
    group by 1 order by questions desc, last_at desc limit 20`);
  const all = rows.map(view);
  return {
    open: all.filter((a) => !a.resolvedAt),
    resolved: all.filter((a) => a.resolvedAt),
    failed: failed.map((f) => ({
      reason: f.reason,
      questions: f.questions,
      lastAt: new Date(f.last_at).toISOString(),
    })),
  };
}

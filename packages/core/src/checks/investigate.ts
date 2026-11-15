/**
 * The Investigator: an insight's investigation, from queued to
 * settled. It runs when someone presses Investigate, or when a routine investigates before it tells, as
 * background work: within the month's background budget, else held, saying why. Its run is the Investigator
 * profile's, in a thread of its own (channel `insight`, nobody's conversation: no Ask list shows it), whose query
 * cells the organization reads like the check's.
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import { type DeploymentKeys, defaultChoice } from "../ai/settings";
import { enqueue } from "../jobs/boss";
import { agentBackgroundQueue } from "../jobs/queues";
import { releaseWaitingRuns } from "../routines/waiting";
import { type InvestigationOutcome, type LedgerDeps, nextMessageSeq } from "../runs/ledger";
import { BackgroundBudgetReached, checkBackgroundBudget } from "../usage/limits";
import { insightReadableBy } from "./insights";

/** The insights an investigation explains: a metric's change. A source's late data has nothing to explain. */
export const INVESTIGABLE = ["anomaly", "trend", "goal_risk", "threshold"] as const;

export type InvestigationStatus = "queued" | "running" | "confirmed" | "not_confirmed" | "failed" | "held";

export interface InvestigationView {
  insightId: string;
  status: InvestigationStatus;
  /** Why it didn't start (a held one). */
  heldReason: string | null;
  /** The write-up, once its run ended with one. */
  outcome: InvestigationOutcome | null;
  /** What it used: its queries and its cost. */
  queries: number;
  costUsd: number | null;
  finishedAt: string | null;
}

const KIND_WORDS: Record<string, string> = {
  anomaly: "a week or month outside the range its history expects",
  trend: "a change in its month-to-month trend that held",
  goal_risk: "a goal it may miss on its current trend",
  threshold: "a value beyond a line the team watches it against",
};

/** What the Investigator is asked: the insight in words, never its figures (it counts them again, as its recheck). */
export function investigationBrief(i: { title: string; kind: string; metricTitle: string; metricSlug: string }) {
  return `Investigate this insight OpenDash found: "${i.title}". It is about the verified metric ${i.metricTitle} (${i.metricSlug}): ${KIND_WORDS[i.kind] ?? "a change"}.`;
}

/**
 * Starts an insight's investigation, or says why not. An open insight about a metric's change only; one already
 * investigated (or under way) is left as it is, and one that failed or was held starts again. Held, with the reason
 * its card shows, when background work's budget is spent or off. The run, its thread and message, the investigation
 * and its job are written together, in the caller's transaction (a check files the insight in the same one).
 */
export async function requestInvestigation(
  tx: TenantTx,
  deps: { boss: PgBoss; deploymentKeys: DeploymentKeys },
  input: { orgId: string; insightId: string; requestedBy?: string | null },
  now = new Date(),
): Promise<{ status: InvestigationStatus | "not_investigable" }> {
  if (!isUuid(input.insightId)) return { status: "not_investigable" };
  const [i] = await tx.execute<{
    kind: string;
    title: string;
    connection_id: string;
    metric_title: string | null;
    metric_slug: string | null;
    owner_id: string | null;
  }>(sql`
    select n.kind, n.title, n.connection_id, m.title as metric_title, m.slug as metric_slug, n.owner_id
    from app.insight n
    left join app.context_item m on m.org_id = n.org_id and m.id = n.metric_id and m.deleted_at is null
    where n.org_id = ${input.orgId} and n.id = ${input.insightId} and n.status in ('new', 'seen')
      ${input.requestedBy ? sql`and ${insightReadableBy(input.requestedBy)}` : sql``}
    for update of n`);
  if (!i || !(INVESTIGABLE as readonly string[]).includes(i.kind) || !i.metric_slug || !i.metric_title) {
    return { status: "not_investigable" };
  }
  const [had] = await tx.execute<{ id: string; status: InvestigationStatus }>(sql`
    select id, status from app.investigation where org_id = ${input.orgId} and insight_id = ${input.insightId}`);
  if (had && had.status !== "failed" && had.status !== "held") return { status: had.status };
  const id = had?.id ?? uuidv7();
  const save = (status: InvestigationStatus, runId: string | null, heldReason: string | null) =>
    tx.execute(sql`
      insert into app.investigation (org_id, id, insight_id, run_id, status, held_reason, requested_by)
      values (${input.orgId}, ${id}, ${input.insightId}, ${runId}, ${status}, ${heldReason},
        ${input.requestedBy ?? null})
      on conflict (org_id, id) do update set run_id = excluded.run_id, status = excluded.status,
        held_reason = excluded.held_reason, requested_by = excluded.requested_by, created_at = now(),
        finished_at = null`);
  try {
    await checkBackgroundBudget(tx, input.orgId, now);
  } catch (error) {
    if (!(error instanceof BackgroundBudgetReached)) throw error;
    await save("held", null, error.message);
    return { status: "held" };
  }
  const choice = await defaultChoice(tx, input.orgId, deps.deploymentKeys);
  const threadId = uuidv7();
  const messageId = uuidv7();
  const runId = uuidv7();
  await tx.execute(sql`
    insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${input.orgId}, ${threadId}, ${i.connection_id}, ${i.owner_id}, ${i.title.slice(0, 80)}, 'insight',
      'private')`);
  const brief = investigationBrief({
    title: i.title,
    kind: i.kind,
    metricTitle: i.metric_title,
    metricSlug: i.metric_slug,
  });
  await tx.execute(sql`
    insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
    values (${input.orgId}, ${messageId}, ${threadId}, ${await nextMessageSeq(tx, input.orgId, threadId)}, 'user', null,
      ${JSON.stringify({ role: "user", content: brief })}::jsonb, ${brief})`);
  await tx.execute(sql`
    insert into app.run (org_id, id, thread_id, trigger, profile, input_message_id, model, provider, reasoning)
    values (${input.orgId}, ${runId}, ${threadId}, 'insight', 'investigator', ${messageId}, ${choice.model},
      ${choice.provider}, ${choice.reasoning})`);
  await save("queued", runId, null);
  await enqueue(deps.boss, tx, agentBackgroundQueue, { orgId: input.orgId, runId }, { singletonKey: runId });
  return { status: "queued" };
}

/** Investigate, pressed by a person: `requestInvestigation` in a transaction of its own. */
export async function startInvestigation(
  deps: Pick<LedgerDeps, "withTenant"> & { boss: PgBoss; deploymentKeys: DeploymentKeys },
  input: { orgId: string; insightId: string; requestedBy?: string | null },
  now = new Date(),
): Promise<{ status: InvestigationStatus | "not_investigable" }> {
  return deps.withTenant(input.orgId, (tx) => requestInvestigation(tx, deps, input, now));
}

/**
 * Settles an investigation once its run ended: confirmed or not by its write-up, else failed, and lets go of the
 * routine runs that waited for it. It changes nothing else: an insight its recheck didn't confirm stays open, saying
 * so, for a person to dismiss (the verdict is a model's, which reads the organization's data and
 * text, so it never hides a detection on its own). A routine still tells it, with the verdict beside it.
 */
export async function settleInvestigation(
  deps: Pick<LedgerDeps, "withTenant"> & { boss: PgBoss },
  orgId: string,
  runId: string,
): Promise<InvestigationStatus | null> {
  return deps.withTenant(orgId, async (tx) => {
    const [r] = await tx.execute<{ status: string; outcome: { kind?: string; confirmed?: boolean } | null }>(sql`
      select status, outcome from app.run where org_id = ${orgId} and id = ${runId}`);
    if (!r || !["succeeded", "failed", "cancelled"].includes(r.status)) return null;
    const status: InvestigationStatus =
      r.status === "succeeded" && r.outcome?.kind === "investigation"
        ? r.outcome.confirmed
          ? "confirmed"
          : "not_confirmed"
        : "failed";
    const [inv] = await tx.execute<{ insight_id: string }>(sql`
      update app.investigation set status = ${status}, finished_at = now()
      where org_id = ${orgId} and run_id = ${runId} and status in ('queued', 'running')
      returning insight_id`);
    if (!inv) return null;
    // A routine that waited to tell it with its investigation tells it now.
    await releaseWaitingRuns(tx, deps.boss, orgId, { insightId: inv.insight_id });
    return status;
  });
}

/** Marks an investigation running once its run is claimed (the card's "Investigating…"). */
export async function investigationStarted(tx: TenantTx, orgId: string, runId: string): Promise<void> {
  await tx.execute(sql`
    update app.investigation set status = 'running' where org_id = ${orgId} and run_id = ${runId} and status = 'queued'`);
}

/** The investigations of these insights, for their cards: the write-up, and what it used. */
export async function investigationsFor(
  tx: TenantTx,
  orgId: string,
  insightIds: string[],
): Promise<Map<string, InvestigationView>> {
  const ids = insightIds.filter(isUuid);
  if (!ids.length) return new Map();
  const rows = await tx.execute<{
    insight_id: string;
    status: InvestigationStatus;
    held_reason: string | null;
    outcome: InvestigationOutcome | { kind: string } | null;
    queries: number;
    cost_usd: string | null;
    finished_at: string | null;
  }>(sql`
    select v.insight_id, v.status, v.held_reason, r.outcome, v.finished_at,
      (select count(*)::int from app.query_run q where q.org_id = v.org_id and q.requester_type = 'run'
         and q.requester_id = v.run_id and q.mode = 'execute') as queries,
      r.usage->>'costUsd' as cost_usd
    from app.investigation v
    left join app.run r on r.org_id = v.org_id and r.id = v.run_id
    where v.org_id = ${orgId} and v.insight_id in (${sql.join(
      ids.map((id) => sql`${id}`),
      sql`, `,
    )})`);
  return new Map(
    rows.map((r) => [
      r.insight_id,
      {
        insightId: r.insight_id,
        status: r.status,
        heldReason: r.held_reason,
        outcome: r.outcome?.kind === "investigation" ? (r.outcome as InvestigationOutcome) : null,
        queries: r.queries,
        costUsd: r.cost_usd === null ? null : Number(r.cost_usd),
        finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      },
    ]),
  );
}

/** What an investigation run is about: its insight, in words, for the Investigator's prompt. */
export async function investigationSubject(
  tx: TenantTx,
  orgId: string,
  runId: string,
): Promise<{
  title: string;
  kind: string;
  direction: string | null;
  period: string;
  metricSlug: string;
  metricTitle: string;
} | null> {
  const [s] = await tx.execute<{
    title: string;
    kind: string;
    direction: string | null;
    period: string;
    metric_slug: string;
    metric_title: string;
  }>(sql`
    select n.title, n.kind, n.direction, n.period::text as period, m.slug as metric_slug, m.title as metric_title
    from app.investigation v
    join app.insight n on n.org_id = v.org_id and n.id = v.insight_id
    join app.context_item m on m.org_id = n.org_id and m.id = n.metric_id
    where v.org_id = ${orgId} and v.run_id = ${runId}`);
  return s
    ? {
        title: s.title,
        kind: s.kind,
        direction: s.direction,
        period: s.period,
        metricSlug: s.metric_slug,
        metricTitle: s.metric_title,
      }
    : null;
}

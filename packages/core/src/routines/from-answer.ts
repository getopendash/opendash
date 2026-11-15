/**
 * An answer, as a routine's start: Repeat… asks its question again on a schedule, from its source;
 * Watch watches the verified metrics it read. Only for someone who can read its conversation, and only an answer
 * (not one OpenDash couldn't give).
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { type WatchableMetric, watchableMetrics } from "../checks/metrics";
import { type RunOutcome, runReadableBy } from "../runs/ledger";

export interface AnswerForRoutine {
  question: string;
  connectionId: string;
  /** The verified metrics it read through the semantic layer, those that can be watched (by week or month). */
  metrics: WatchableMetric[];
}

export async function answerForRoutine(
  tx: TenantTx,
  viewer: { orgId: string; userId: string },
  runId: string,
): Promise<AnswerForRoutine | null> {
  if (!isUuid(runId)) return null;
  // The run's source; older runs keep it on their conversation only.
  const [r] = await tx.execute<{ connection_id: string; outcome: RunOutcome | null; question: string | null }>(sql`
    select coalesce(r.connection_id, t.connection_id) as connection_id, r.outcome, m.text as question from app.run r
    join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
    left join app.message m on m.org_id = r.org_id and m.id = r.input_message_id
    where r.org_id = ${viewer.orgId} and r.id = ${runId} and r.profile = 'analyst' and r.status = 'succeeded'
      and ${runReadableBy(viewer.userId)}`);
  if (!r?.question || r.outcome?.kind !== "answer" || r.outcome.status !== "answered") return null;
  // The metrics its metric queries named, each on the source the query named (another one) or the run's.
  const items = await tx.execute<{ id: string }>(sql`
    select distinct i.id from app.tool_call c
    cross join lateral jsonb_array_elements_text(
      case when jsonb_typeof(c.args->'metrics') = 'array' then c.args->'metrics' else '[]'::jsonb end) as m(slug)
    left join app.connection named on named.org_id = c.org_id and named.deleted_at is null
      and lower(named.name) = lower(c.args->>'source')
    join app.context_item i on i.org_id = c.org_id and i.kind = 'metric' and i.deleted_at is null and i.slug = m.slug
      and i.connection_id = coalesce(named.id, ${r.connection_id}::uuid)
    where c.org_id = ${viewer.orgId} and c.run_id = ${runId} and c.tool = 'metric_query' and c.status = 'succeeded'`);
  const metrics = items.length
    ? (
        await watchableMetrics(
          tx,
          viewer.orgId,
          items.map((i) => i.id),
        )
      ).filter((m) => m.grain)
    : [];
  return { question: r.question.trim(), connectionId: r.connection_id, metrics };
}

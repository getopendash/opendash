import { sql, type TenantTx } from "@opendash/db";

/** One day's or one model's model calls, from usage_event. */
export interface UsageRow {
  /** Questions: the runs that made these calls. */
  questions: number;
  calls: number;
  tokens: number;
  /** The priced calls' cost. */
  costUsd: number;
  /** Calls to a model without a price: while there are any, the cost is a lower bound. */
  unpriced: number;
}

export interface UsageSummary {
  days: number;
  since: string;
  totals: UsageRow & { people: number; cachedTokens: number };
  byDay: (UsageRow & { day: string })[];
  /** By model and by whose key paid: the organization's own (billed to it by the provider) or the deployment's. */
  byModel: (UsageRow & { model: string; keySource: "org" | "deployment" })[];
}

type Row = { questions: number; calls: number; tokens: string | null; cost: string | null; unpriced: number };
const row = (r: Row | undefined): UsageRow => ({
  questions: r?.questions ?? 0,
  calls: r?.calls ?? 0,
  tokens: Number(r?.tokens ?? 0),
  costUsd: Number(r?.cost ?? 0),
  unpriced: r?.unpriced ?? 0,
});
const aggregates = sql`
  count(distinct e.source_id) filter (where e.source_type = 'run' and not e.background)::int as questions,
  count(*)::int as calls, sum(e.qty)::bigint::text as tokens, sum(e.cost_usd)::text as cost,
  count(*) filter (where e.cost_usd is null)::int as unpriced`;

/**
 * What answering questions used over the last `days` (Settings → Usage): model calls, tokens and cost, in total,
 * by day (UTC) and by model. Read from usage_event, so it reconciles with the runs exactly; the share read from the
 * cache comes from the runs' own usage.
 */
export async function usageSummary(
  tx: TenantTx,
  orgId: string,
  opts: { days?: number; now?: Date } = {},
): Promise<UsageSummary> {
  const days = opts.days ?? 30;
  const since = new Date((opts.now ?? new Date()).getTime() - days * 86_400_000);
  const window = sql`e.org_id = ${orgId} and e.kind = 'llm_tokens'
    and e.id >= app.uuidv7_floor(${since.toISOString()}::timestamptz)`;
  const [totals] = await tx.execute<Row & { people: number; cached: string | null }>(sql`
    with e as (select * from app.usage_event e where ${window}),
    runs as (select distinct e.source_id as id from e where e.source_type = 'run')
    select ${aggregates},
      (select count(distinct t.created_by)::int from runs
        join app.run r on r.org_id = ${orgId} and r.id = runs.id
        join app.thread t on t.org_id = r.org_id and t.id = r.thread_id) as people,
      (select sum((r.usage->>'cachedInputTokens')::bigint)::text from runs
        join app.run r on r.org_id = ${orgId} and r.id = runs.id) as cached
    from e`);
  const byDay = await tx.execute<Row & { day: string }>(sql`
    select to_char((app.uuidv7_ts(e.id) at time zone 'UTC')::date, 'YYYY-MM-DD') as day, ${aggregates}
    from app.usage_event e where ${window} group by 1 order by 1 desc`);
  const byModel = await tx.execute<Row & { model: string | null; key_source: string | null }>(sql`
    select coalesce(e.model, 'unknown') as model, coalesce(e.key_source, 'deployment') as key_source, ${aggregates}
    from app.usage_event e where ${window} group by 1, 2 order by sum(e.qty) desc`);
  return {
    days,
    since: since.toISOString(),
    totals: { ...row(totals), people: totals?.people ?? 0, cachedTokens: Number(totals?.cached ?? 0) },
    byDay: byDay.map((r) => ({ day: r.day, ...row(r) })),
    byModel: byModel.map((r) => ({
      model: r.model ?? "unknown",
      keySource: r.key_source === "org" ? ("org" as const) : ("deployment" as const),
      ...row(r),
    })),
  };
}

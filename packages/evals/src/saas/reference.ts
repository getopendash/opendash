/**
 * Reference SQL for the dash-saas metrics the demo is calibrated against. The same definitions as model.ts, in SQL:
 * DashBench grades answers against queries like these, and the demo's starter definitions will be built from them.
 *
 * MRR of a month: paid subscription items active at the first instant of the next month, net of discount, annual
 * plans spread over 12 months, in USD at the month's last daily rate; test accounts and paused subscriptions excluded.
 * Churned MRR of a month: the MRR of the items that ended when their subscription was canceled in that month.
 *
 * Parameters are UTC instants: MRR_SQL takes the next month's start; CHURNED_MRR_BY_PLAN_SQL the month's start and end.
 */
export const MRR_SQL = `
with bounds as (
  select $1::timestamptz as next_start
), fx as (
  select currency::text, rate_to_usd from billing.fx_rates
  where rate_date = (((select next_start from bounds) at time zone 'UTC') - interval '1 day')::date
  union all select 'USD', 1
)
select round(sum(
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
  / case when s.billing_interval = 'year' then 12 else 1 end / 100.0 * fx.rate_to_usd
), 2)::float8 as mrr
from public.subscription_items i
join public.subscriptions s on s.id = i.subscription_id
join public.accounts a on a.id = s.account_id
join fx on fx.currency = s.currency
cross join bounds b
where not a.is_test
  and i.started_at < b.next_start
  and (i.ended_at is null or i.ended_at >= b.next_start)
  and not (s.paused_at is not null and s.paused_at < b.next_start and (s.resumed_at is null or s.resumed_at >= b.next_start))
`;

export const CHURNED_MRR_BY_PLAN_SQL = `
select p.name as plan,
  round(sum(
    i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
    / case when s.billing_interval = 'year' then 12 else 1 end / 100.0 * coalesce(fx.rate_to_usd, 1)
  ), 2)::float8 as churned_mrr
from public.subscriptions s
join public.accounts a on a.id = s.account_id
join public.subscription_items i on i.subscription_id = s.id and i.ended_at = s.canceled_at
join public.plans p on p.id = i.plan_id
left join billing.fx_rates fx on fx.currency = s.currency and fx.rate_date = (s.canceled_at at time zone 'UTC')::date
where not a.is_test
  and s.canceled_at >= $1::timestamptz
  and s.canceled_at < $2::timestamptz
group by p.name
order by p.name
`;

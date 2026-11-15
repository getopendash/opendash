/**
 * The demo company's starter definitions (the starter pack for the sample source): datasets per dialect and the
 * metrics on them, as the YAML an admin would author. Built from the reference SQL the demo is calibrated against
 * (evals/saas/reference.ts), which the conformance tests compare them with.
 *
 * Dataset SQL names schemas as {{public}}, {{billing}} and {{support}}, filled in per source: the demo's ClickHouse
 * databases carry a prefix in tests.
 *
 * MRR is a point-in-time number, so `mrr_monthly` is a snapshot: one row per paid subscription item active at the end
 * of each month (for the current month, now), with its MRR in USD at that month's last rate.
 */
import type { DialectId } from "@opendash/connectors";

/** A dataset's YAML with its SQL left out ({{sql}}), and the SQL in each dialect. `{{f8}}` is Postgres's float cast. */
interface DatasetTemplate {
  yaml: string;
  postgres: string;
  clickhouse: string;
  /** Sessions run in UTC (connectors/mysql/session.ts), so date() of a time is its UTC day. */
  mysql: string;
}

const DATASETS: DatasetTemplate[] = [
  {
    yaml: `ref: mrr_monthly
label: MRR snapshot by month
description: Every paid subscription item active at the end of each month, with its monthly recurring revenue in USD.
grain: one row per subscription item active at the end of each month (for the current month, as of now)
primary_key: [item_id, month]
time_column: month
drill:
  noun: subscription items
  columns: [item_id, month, accounts.name, plans.name, billing_interval, currency, seats, mrr_usd]
  order: [{ by: mrr_usd, dir: desc }]
sql: |
{{sql}}
columns:
  - { name: month, type: time, grain: month, description: The month (its first day) }
  - { name: item_id, type: number }
  - { name: subscription_id, type: number }
  - { name: account_id, type: number }
  - { name: plan_id, type: string, dimension: true }
  - { name: billing_interval, type: string, dimension: true, description: "month or year", synonyms: [billing period] }
  - { name: currency, type: string, dimension: true, description: The subscription's billing currency }
  - { name: seats, type: number, description: Units on the item }
  - { name: mrr_usd, type: number, format: usd, description: The item's monthly recurring revenue in USD }
  - { name: is_test, type: boolean, dimension: true, description: Internal and test accounts }
measures:
  - { name: mrr, expr: "round(sum(mrr_usd), 2){{f8}}", format: usd, description: MRR in USD }
  - { name: paying_customers, expr: "count(distinct account_id)", description: Accounts with paid MRR }
  - { name: paid_seats, expr: "sum(seats)", description: Seats on paid items }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
relationships:
  - { to: plans, type: "n:1", on: { plan_id: id } }
  - { to: accounts, type: "n:1", on: { account_id: id } }
snapshot: { at: month }
usage_guidance: >-
  Use for MRR, paying customers and paid seats at the end of a period. A snapshot: by month, each month's end; by
  quarter or year, its last month's, never a sum of its months.
`,
    postgres: `with months as (
  select m::date as month, least(m + interval '1 month', now()) as as_of
  from generate_series(
    date_trunc('month', (select min(started_at) from {{public}}.subscription_items)),
    date_trunc('month', now()),
    interval '1 month'
  ) as m
), rates as (
  select mo.month, c.currency,
    (select r.rate_to_usd from {{billing}}.fx_rates r
      where r.currency = c.currency and r.rate_date <= (mo.as_of - interval '1 day')::date
      order by r.rate_date desc limit 1) as rate_to_usd
  from months mo cross join (select distinct currency from {{billing}}.fx_rates) c
)
select mo.month, i.id as item_id, s.id as subscription_id, s.account_id, i.plan_id, s.billing_interval,
  s.currency::text as currency, i.quantity as seats,
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
    / case when s.billing_interval = 'year' then 12 else 1 end / 100.0
    * case when s.currency = 'USD' then 1 else fx.rate_to_usd end as mrr_usd,
  a.is_test
from months mo
join {{public}}.subscription_items i on i.started_at < mo.as_of and (i.ended_at is null or i.ended_at >= mo.as_of)
join {{public}}.subscriptions s on s.id = i.subscription_id
join {{public}}.accounts a on a.id = s.account_id
left join rates fx on fx.month = mo.month and fx.currency = s.currency
where not (s.paused_at is not null and s.paused_at < mo.as_of and (s.resumed_at is null or s.resumed_at >= mo.as_of))`,
    clickhouse: `with months as (
  select addMonths(b.start, toUInt32(n.number)) as month,
    least(toDateTime64(addMonths(b.start, toUInt32(n.number) + 1), 3, 'UTC'), now64(3, 'UTC')) as as_of
  from (select toStartOfMonth(min(started_at)) as start from {{public}}.subscription_items) as b
  cross join numbers(240) as n
  where addMonths(b.start, toUInt32(n.number)) <= toStartOfMonth(now('UTC'))
), rates as (
  select mo.month as month, r.currency as currency, argMax(r.rate_to_usd, r.rate_date) as rate_to_usd
  from months mo cross join {{billing}}.fx_rates r
  where r.rate_date <= toDate(mo.as_of - interval 1 day)
  group by mo.month, r.currency
)
select mo.month as month, i.id as item_id, s.id as subscription_id, s.account_id as account_id, i.plan_id as plan_id,
  s.billing_interval as billing_interval, toString(s.currency) as currency, i.quantity as seats,
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0) / if(s.billing_interval = 'year', 12, 1) / 100.0
    * if(s.currency = 'USD', 1, toFloat64(fx.rate_to_usd)) as mrr_usd,
  a.is_test as is_test
from months mo
cross join {{public}}.subscription_items i
join {{public}}.subscriptions s on s.id = i.subscription_id
join {{public}}.accounts a on a.id = s.account_id
left join rates fx on fx.month = mo.month and fx.currency = s.currency
where i.started_at < mo.as_of and (i.ended_at is null or i.ended_at >= mo.as_of)
  and not (s.paused_at is not null and s.paused_at < mo.as_of and (s.resumed_at is null or s.resumed_at >= mo.as_of))`,
    mysql: `with recursive months as (
  select date_sub(date(b.first), interval dayofmonth(b.first) - 1 day) as month
  from (select min(started_at) as first from {{public}}.subscription_items) as b
  union all
  select month + interval 1 month from months
  where month + interval 1 month <= date_sub(utc_date(), interval dayofmonth(utc_date()) - 1 day)
), bounds as (
  select month, least(cast(month + interval 1 month as datetime(3)), utc_timestamp(3)) as as_of from months
), rates as (
  select b.month, c.currency,
    (select r.rate_to_usd from {{billing}}.fx_rates r
      where r.currency = c.currency and r.rate_date <= date(b.as_of - interval 1 day)
      order by r.rate_date desc limit 1) as rate_to_usd
  from bounds b cross join (select distinct currency from {{billing}}.fx_rates) c
)
select b.month, i.id as item_id, s.id as subscription_id, s.account_id, i.plan_id, s.billing_interval,
  s.currency, i.quantity as seats,
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
    / case when s.billing_interval = 'year' then 12 else 1 end / 100.0
    * case when s.currency = 'USD' then 1 else fx.rate_to_usd end as mrr_usd,
  a.is_test
from bounds b
join {{public}}.subscription_items i on i.started_at < b.as_of and (i.ended_at is null or i.ended_at >= b.as_of)
join {{public}}.subscriptions s on s.id = i.subscription_id
join {{public}}.accounts a on a.id = s.account_id
left join rates fx on fx.month = b.month and fx.currency = s.currency
where not (s.paused_at is not null and s.paused_at < b.as_of and (s.resumed_at is null or s.resumed_at >= b.as_of))`,
  },
  {
    yaml: `ref: churn
label: Churned subscription items
description: Subscription items that ended when their subscription was canceled, with the MRR they took away.
grain: one row per subscription item that ended at its subscription's cancellation
primary_key: [item_id]
time_column: canceled_at
drill:
  noun: canceled items
  columns: [item_id, canceled_at, accounts.name, plans.name, cancel_reason, mrr_usd]
sql: |
{{sql}}
columns:
  - { name: canceled_at, type: time }
  - { name: item_id, type: number }
  - { name: subscription_id, type: number }
  - { name: account_id, type: number }
  - { name: plan_id, type: string, dimension: true }
  - { name: billing_interval, type: string, dimension: true }
  - { name: cancel_reason, type: string, dimension: true }
  - { name: mrr_usd, type: number, format: usd, description: The MRR the item took away, in USD at the cancellation day's rate }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: churned_mrr, expr: "round(sum(mrr_usd), 2){{f8}}", format: usd }
  - { name: churned_subscriptions, expr: "count(distinct subscription_id)" }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
relationships:
  - { to: plans, type: "n:1", on: { plan_id: id } }
  - { to: accounts, type: "n:1", on: { account_id: id } }
`,
    postgres: `select s.canceled_at, i.id as item_id, s.id as subscription_id, s.account_id, i.plan_id, s.billing_interval,
  s.cancel_reason,
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
    / case when s.billing_interval = 'year' then 12 else 1 end / 100.0 * coalesce(fx.rate_to_usd, 1) as mrr_usd,
  a.is_test
from {{public}}.subscriptions s
join {{public}}.accounts a on a.id = s.account_id
join {{public}}.subscription_items i on i.subscription_id = s.id and i.ended_at = s.canceled_at
left join {{billing}}.fx_rates fx on fx.currency = s.currency and fx.rate_date = (s.canceled_at at time zone 'UTC')::date
where s.canceled_at is not null`,
    clickhouse: `select s.canceled_at as canceled_at, i.id as item_id, s.id as subscription_id, s.account_id as account_id,
  i.plan_id as plan_id, s.billing_interval as billing_interval, s.cancel_reason as cancel_reason,
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0) / if(s.billing_interval = 'year', 12, 1) / 100.0
    * coalesce(toFloat64(fx.rate_to_usd), 1) as mrr_usd,
  a.is_test as is_test
from {{public}}.subscriptions s
join {{public}}.accounts a on a.id = s.account_id
join {{public}}.subscription_items i on i.subscription_id = s.id and i.ended_at = s.canceled_at
left join {{billing}}.fx_rates fx on fx.currency = s.currency and fx.rate_date = toDate(s.canceled_at, 'UTC')
where s.canceled_at is not null`,
    mysql: `select s.canceled_at, i.id as item_id, s.id as subscription_id, s.account_id, i.plan_id, s.billing_interval,
  s.cancel_reason,
  i.unit_amount_cents * i.quantity * (1 - s.discount_pct / 100.0)
    / case when s.billing_interval = 'year' then 12 else 1 end / 100.0 * coalesce(fx.rate_to_usd, 1) as mrr_usd,
  a.is_test
from {{public}}.subscriptions s
join {{public}}.accounts a on a.id = s.account_id
join {{public}}.subscription_items i on i.subscription_id = s.id and i.ended_at = s.canceled_at
left join {{billing}}.fx_rates fx on fx.currency = s.currency and fx.rate_date = date(s.canceled_at)
where s.canceled_at is not null`,
  },
  {
    yaml: `ref: accounts
label: Customer accounts
grain: one row per account
primary_key: [id]
time_column: created_at
drill:
  noun: accounts
  columns: [id, name, created_at, country, industry, employee_band]
sql: |
{{sql}}
columns:
  - { name: id, type: number }
  - { name: name, type: string, description: The company's name }
  - { name: created_at, type: time, description: When the account signed up }
  - { name: country, type: string, dimension: true, description: Two-letter country code }
  - { name: currency, type: string, dimension: true }
  - { name: industry, type: string, dimension: true }
  - { name: employee_band, type: string, dimension: true, synonyms: [company size] }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: accounts, expr: "count(*)" }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
`,
    postgres: `select id, name, created_at, country::text as country, currency::text as currency, industry, employee_band, is_test
from {{public}}.accounts`,
    clickhouse: `select id, name, created_at, toString(country) as country, toString(currency) as currency, industry, employee_band,
  is_test
from {{public}}.accounts`,
    mysql: `select id, name, created_at, country, currency, industry, employee_band, is_test
from {{public}}.accounts`,
  },
  {
    yaml: `ref: plans
label: Plans
grain: one row per plan
primary_key: [id]
sql: |
{{sql}}
columns:
  - { name: id, type: string }
  - { name: name, type: string, dimension: true, description: "The plan's name: Starter, Growth, Scale" }
  - { name: per_seat, type: boolean, dimension: true }
measures:
  - { name: plans, expr: "count(*)" }
`,
    postgres: `select id, name, per_seat from {{public}}.plans`,
    clickhouse: `select id, name, per_seat from {{public}}.plans`,
    mysql: `select id, name, per_seat from {{public}}.plans`,
  },
  {
    yaml: `ref: subscriptions
label: Subscriptions
description: Every subscription with its current status.
grain: one row per subscription
primary_key: [id]
time_column: started_at
drill:
  noun: subscriptions
  columns: [id, started_at, accounts.name, plans.name, status, billing_interval, seats, cancel_reason]
sql: |
{{sql}}
columns:
  - { name: id, type: number }
  - { name: account_id, type: number }
  - { name: plan_id, type: string, dimension: true }
  - { name: status, type: string, dimension: true, description: "trialing, active, paused or canceled" }
  - { name: billing_interval, type: string, dimension: true }
  - { name: currency, type: string, dimension: true }
  - { name: seats, type: number }
  - { name: started_at, type: time }
  - { name: canceled_at, type: time }
  - { name: cancel_reason, type: string, dimension: true }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: subscriptions, expr: "count(*)" }
  - { name: total_seats, expr: "sum(seats)" }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
  - { name: active, where: "status = 'active'", description: Paying now (not trialing, paused or canceled) }
  - { name: trialing, where: "status = 'trialing'", description: In trial now }
relationships:
  - { to: plans, type: "n:1", on: { plan_id: id } }
  - { to: accounts, type: "n:1", on: { account_id: id } }
`,
    postgres: `select s.id, s.account_id, s.plan_id, s.status, s.billing_interval, s.currency::text as currency, s.seats,
  s.started_at, s.canceled_at, s.cancel_reason, a.is_test
from {{public}}.subscriptions s
join {{public}}.accounts a on a.id = s.account_id`,
    clickhouse: `select s.id as id, s.account_id as account_id, s.plan_id as plan_id, toString(s.status) as status,
  toString(s.billing_interval) as billing_interval, toString(s.currency) as currency, s.seats as seats,
  s.started_at as started_at, s.canceled_at as canceled_at, s.cancel_reason as cancel_reason, a.is_test as is_test
from {{public}}.subscriptions s
join {{public}}.accounts a on a.id = s.account_id`,
    mysql: `select s.id, s.account_id, s.plan_id, s.status, s.billing_interval, s.currency, s.seats,
  s.started_at, s.canceled_at, s.cancel_reason, a.is_test
from {{public}}.subscriptions s
join {{public}}.accounts a on a.id = s.account_id`,
  },
  {
    yaml: `ref: tickets
label: Support tickets
grain: one row per ticket
primary_key: [id]
time_column: created_at
drill:
  noun: tickets
  columns: [id, created_at, accounts.name, subject, priority, status, channel, csat]
sql: |
{{sql}}
columns:
  - { name: id, type: number }
  - { name: account_id, type: number }
  - { name: subject, type: string, description: What the customer wrote }
  - { name: priority, type: string, dimension: true }
  - { name: status, type: string, dimension: true }
  - { name: channel, type: string, dimension: true }
  - { name: created_at, type: time, description: When the ticket was opened }
  - { name: solved_at, type: time }
  - { name: csat, type: number, description: "Satisfaction rating, 1 to 5, when the customer gave one" }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: tickets, expr: "count(*)" }
  - { name: avg_csat, expr: "round(avg(csat), 2){{f8}}", description: Average over rated tickets only }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
relationships:
  - { to: accounts, type: "n:1", on: { account_id: id } }
`,
    postgres: `select t.id, t.account_id, t.subject, t.priority, t.status, t.channel, t.created_at, t.solved_at, t.csat, a.is_test
from {{support}}.tickets t
join {{public}}.accounts a on a.id = t.account_id`,
    clickhouse: `select t.id as id, t.account_id as account_id, t.subject as subject, toString(t.priority) as priority, toString(t.status) as status,
  toString(t.channel) as channel, t.created_at as created_at, t.solved_at as solved_at, t.csat as csat,
  a.is_test as is_test
from {{support}}.tickets as t final
join {{public}}.accounts a on a.id = t.account_id`,
    mysql: `select t.id, t.account_id, t.subject, t.priority, t.status, t.channel, t.created_at, t.solved_at, t.csat, a.is_test
from {{support}}.tickets t
join {{public}}.accounts a on a.id = t.account_id`,
  },
  {
    yaml: `ref: payments
label: Payments
grain: one row per payment attempt
primary_key: [id]
time_column: created_at
drill:
  noun: payments
  columns: [id, created_at, accounts.name, status, method, currency, amount]
sql: |
{{sql}}
columns:
  - { name: id, type: number }
  - { name: invoice_id, type: number }
  - { name: account_id, type: number }
  - { name: status, type: string, dimension: true }
  - { name: method, type: string, dimension: true }
  - { name: currency, type: string, dimension: true }
  - { name: amount, type: number, description: In the payment's currency }
  - { name: created_at, type: time }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: payments, expr: "count(*)" }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
  - { name: failed, where: "status = 'failed'", description: Payment attempts that failed }
relationships:
  - { to: accounts, type: "n:1", on: { account_id: id } }
`,
    postgres: `select p.id, p.invoice_id, i.account_id, p.status, p.method, p.currency::text as currency,
  p.amount_cents / 100.0 as amount, p.created_at, a.is_test
from {{billing}}.payments p
join {{billing}}.invoices i on i.id = p.invoice_id
join {{public}}.accounts a on a.id = i.account_id`,
    clickhouse: `select p.id as id, p.invoice_id as invoice_id, i.account_id as account_id, toString(p.status) as status,
  toString(p.method) as method, toString(p.currency) as currency, p.amount_cents / 100.0 as amount,
  p.created_at as created_at, a.is_test as is_test
from {{billing}}.payments p
join {{billing}}.invoices i on i.id = p.invoice_id
join {{public}}.accounts a on a.id = i.account_id`,
    mysql: `select p.id, p.invoice_id, i.account_id, p.status, p.method, p.currency,
  p.amount_cents / 100.0 as amount, p.created_at, a.is_test
from {{billing}}.payments p
join {{billing}}.invoices i on i.id = p.invoice_id
join {{public}}.accounts a on a.id = i.account_id`,
  },
  {
    yaml: `ref: refunds
label: Refunds
grain: one row per refund
primary_key: [id]
time_column: created_at
drill:
  noun: refunds
  columns: [id, created_at, accounts.name, reason, currency, amount]
sql: |
{{sql}}
columns:
  - { name: id, type: number }
  - { name: payment_id, type: number }
  - { name: account_id, type: number }
  - { name: reason, type: string, dimension: true }
  - { name: amount, type: number, description: In the payment's currency }
  - { name: currency, type: string, dimension: true }
  - { name: created_at, type: time }
  - { name: is_test, type: boolean, dimension: true }
measures:
  - { name: refunds, expr: "count(*)" }
segments:
  - { name: exclude_test, where: "not is_test", default: true, description: Leaves out internal and test accounts }
relationships:
  - { to: accounts, type: "n:1", on: { account_id: id } }
`,
    postgres: `select r.id, r.payment_id, i.account_id, r.reason, r.amount_cents / 100.0 as amount, p.currency::text as currency,
  r.created_at, a.is_test
from {{billing}}.refunds r
join {{billing}}.payments p on p.id = r.payment_id
join {{billing}}.invoices i on i.id = p.invoice_id
join {{public}}.accounts a on a.id = i.account_id`,
    clickhouse: `select r.id as id, r.payment_id as payment_id, i.account_id as account_id, r.reason as reason,
  r.amount_cents / 100.0 as amount, toString(p.currency) as currency, r.created_at as created_at, a.is_test as is_test
from {{billing}}.refunds r
join {{billing}}.payments p on p.id = r.payment_id
join {{billing}}.invoices i on i.id = p.invoice_id
join {{public}}.accounts a on a.id = i.account_id`,
    mysql: `select r.id, r.payment_id, i.account_id, r.reason, r.amount_cents / 100.0 as amount, p.currency,
  r.created_at, a.is_test
from {{billing}}.refunds r
join {{billing}}.payments p on p.id = r.payment_id
join {{billing}}.invoices i on i.id = p.invoice_id
join {{public}}.accounts a on a.id = i.account_id`,
  },
];

const METRICS = [
  `name: mrr
label: Monthly recurring revenue
description: >-
  MRR at the end of each month (for the current month, as of now): paid subscription items net of discount, annual
  plans spread over 12 months, in USD at the month's last rate. Leaves out test accounts and paused subscriptions.
dataset: mrr_monthly
measure: mrr
default_grain: month
format: usd
direction: higher_is_better
synonyms: [recurring revenue, run-rate revenue, MRR]
`,
  `name: paying_customers
label: Paying customers
description: Accounts with at least one paid subscription item at the end of the month (test accounts left out).
dataset: mrr_monthly
measure: paying_customers
default_grain: month
direction: higher_is_better
synonyms: [paying accounts, customers]
`,
  `name: paid_seats
label: Paid seats
description: >-
  The seats on paid subscription items at the end of each month, the same items MRR counts (no trials, paused or
  canceled subscriptions), test accounts left out. For seats at a month's end; Seats on active subscriptions is right
  now.
dataset: mrr_monthly
measure: paid_seats
default_grain: month
direction: higher_is_better
synonyms: [billed seats, seats paid for]
`,
  `name: churned_mrr
label: Churned MRR
description: >-
  The MRR of the subscription items that ended when their subscription was canceled, in USD at the cancellation
  day's rate, by when it was canceled. Test accounts left out.
dataset: churn
measure: churned_mrr
default_grain: month
format: usd
direction: lower_is_better
synonyms: [lost MRR, churn, MRR lost to churn]
`,
  `name: new_accounts
label: New accounts
description: Accounts created in the period (sign-ups), test accounts left out.
dataset: accounts
measure: accounts
default_grain: month
direction: higher_is_better
synonyms: [sign-ups, signups, new customers]
`,
  `name: customer_accounts
label: Customer accounts
description: All customer accounts that exist now, test accounts left out. Takes no time range.
dataset: accounts
measure: accounts
time_column: none
synonyms: [accounts, customers]
`,
  `name: active_subscriptions
label: Active subscriptions
description: Subscriptions paying right now (status active; not trialing, paused or canceled), test accounts left out.
dataset: subscriptions
measure: subscriptions
segments: [active]
time_column: none
direction: higher_is_better
synonyms: [paying subscriptions, active paying subscriptions]
`,
  `name: active_seats
label: Seats on active subscriptions
description: >-
  The seats of the subscriptions paying right now, test accounts left out. For a past month's end, use Paid seats.
dataset: subscriptions
measure: total_seats
segments: [active]
time_column: none
synonyms: [seats, licences]
`,
  `name: trials
label: Subscriptions in trial
description: Subscriptions in trial right now, test accounts left out.
dataset: subscriptions
measure: subscriptions
segments: [trialing]
time_column: none
synonyms: [trialing subscriptions, trials]
`,
  `name: tickets_opened
label: Support tickets opened
description: Tickets opened in the period, test accounts left out.
dataset: tickets
measure: tickets
default_grain: month
direction: lower_is_better
synonyms: [tickets, support tickets]
`,
  `name: avg_csat
label: Average CSAT
description: Average satisfaction rating (1 to 5) of the tickets solved in the period, over rated tickets only.
dataset: tickets
measure: avg_csat
time_column: solved_at
default_grain: month
direction: higher_is_better
synonyms: [CSAT, satisfaction]
`,
  `name: failed_payments
label: Failed payments
description: Payment attempts that failed in the period, test accounts left out.
dataset: payments
measure: payments
segments: [failed]
default_grain: month
direction: lower_is_better
synonyms: [payment failures, declined payments]
`,
  `name: refunds
label: Refunds
description: Refunds issued in the period, test accounts left out.
dataset: refunds
measure: refunds
default_grain: month
direction: lower_is_better
synonyms: [refunds issued]
`,
];

/** The demo pack's YAML for a dialect, with schema names filled in (identity unless the source renames them). */
export function demoPack(
  dialect: DialectId,
  schemas: Partial<Record<"public" | "billing" | "support", string>> = {},
): { datasets: string[]; metrics: string[] } {
  const fill = (yaml: string) =>
    yaml.replace(/\{\{(public|billing|support)\}\}/g, (_, s: "public" | "billing" | "support") => schemas[s] ?? s);
  const indent = (sql: string) => sql.replace(/^/gm, "  ");
  return {
    datasets: DATASETS.map((d) =>
      fill(
        d.yaml.replace("{{sql}}", indent(d[dialect])).replaceAll("{{f8}}", dialect === "postgres" ? "::float8" : ""),
      ),
    ),
    metrics: [...METRICS],
  };
}

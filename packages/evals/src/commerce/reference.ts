/**
 * Reference SQL for Lumen's measures: the same definitions as truth.ts and the glossary, in SQL. The questions grade
 * answers against queries like these, run on the seeded data at grading time.
 *
 * The store reports in America/New_York, so a day is `(placed_at at time zone 'America/New_York')::date`. An order
 * counts when it's a retail order, not a test, and not cancelled (both spellings). Net revenue is the merchandise
 * of those orders after discounts and without tax, shipping and gift cards, in USD at the day's rate, less the
 * merchandise refunded in the period, by refund date.
 *
 * Parameters are New York dates: $1 is the first day and $2 the day after the last.
 */
export const OK = `o.order_type = 'retail' and not o.is_test and o.status not in ('canceled', 'cancelled')`;
export const NO_GIFT_CARD = `not exists (select 1 from shop.order_lines gl where gl.order_id = o.id and gl.line_kind = 'gift_card')`;
export const NY_DATE = (column: string) => `(${column} at time zone 'America/New_York')::date`;
const TAX_FACTOR = `case when o.tax_inclusive then 1 + o.tax_rate_bps / 10000.0 else 1 end`;
/** An order's merchandise after discounts, without tax: what net revenue counts. */
export const MERCHANDISE_NET_CENTS = `(o.subtotal_cents - o.discount_cents) / ${TAX_FACTOR}`;
const FX_AT = (column: string) =>
  `left join shop.fx_rates fx on fx.currency = o.currency and fx.rate_date = ${NY_DATE(column)}`;
const USD = `coalesce(fx.rate_to_usd, 1)`;

/** Merchandise sold in a period, in USD: orders by their own day. */
export const GROSS_MERCHANDISE_SQL = `
select coalesce(round(sum(${MERCHANDISE_NET_CENTS} * ${USD}) / 100.0, 2), 0)::float8 as gross
from shop.orders o
${FX_AT("o.placed_at")}
where ${OK} and ${NO_GIFT_CARD}
  and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
`;

/** Merchandise refunded in a period, in USD: refunds by their own day. */
export const REFUNDED_MERCHANDISE_SQL = `
select coalesce(round(sum(r.merchandise_cents / ${TAX_FACTOR} * coalesce(fx.rate_to_usd, 1)) / 100.0, 2), 0)::float8 as refunded
from shop.refunds r
join shop.orders o on o.id = r.order_id
left join shop.fx_rates fx on fx.currency = o.currency and fx.rate_date = ${NY_DATE("r.created_at")}
where o.order_type = 'retail' and not o.is_test
  and ${NY_DATE("r.created_at")} >= $1::date and ${NY_DATE("r.created_at")} < $2::date
`;

/** Orders in a period (retail, not test, not cancelled). */
export const ORDERS_SQL = `
select count(*)::int as orders
from shop.orders o
where ${OK}
  and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
`;

/** Net revenue by the ship-to country: merchandise sold less the merchandise refunded, by country. */
export const NET_REVENUE_BY_COUNTRY_SQL = `
with sold as (
  select o.ship_country as country, sum(${MERCHANDISE_NET_CENTS} * ${USD}) / 100.0 as usd
  from shop.orders o ${FX_AT("o.placed_at")}
  where ${OK} and ${NO_GIFT_CARD}
    and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
  group by 1
), refunded as (
  select o.ship_country as country, sum(r.merchandise_cents / ${TAX_FACTOR} * coalesce(fx.rate_to_usd, 1)) / 100.0 as usd
  from shop.refunds r
  join shop.orders o on o.id = r.order_id
  left join shop.fx_rates fx on fx.currency = o.currency and fx.rate_date = ${NY_DATE("r.created_at")}
  where o.order_type = 'retail' and not o.is_test
    and ${NY_DATE("r.created_at")} >= $1::date and ${NY_DATE("r.created_at")} < $2::date
  group by 1
)
select s.country, round(s.usd - coalesce(f.usd, 0), 2)::float8 as net_revenue
from sold s left join refunded f using (country)
order by net_revenue desc
`;

/** The average order's merchandise in USD (after discounts, without tax), over merchandise orders. */
export const AOV_SQL = `
select round(avg(${MERCHANDISE_NET_CENTS} * ${USD}) / 100.0, 2)::float8 as aov
from shop.orders o ${FX_AT("o.placed_at")}
where ${OK} and ${NO_GIFT_CARD}
  and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
`;

/**
 * Units sold by variant in a period, retail, not cancelled or test: item lines and a bundle's component lines, never
 * the bundle line itself (counting it as well would count its parts twice).
 */
export const UNITS_BY_VARIANT_SQL = `
select v.id as variant_id, p.name || ' - ' || v.option_name as variant, sum(l.quantity)::int as units
from shop.order_lines l
join shop.orders o on o.id = l.order_id
join shop.variants v on v.id = l.variant_id
join shop.products p on p.id = v.product_id
where ${OK} and l.line_kind in ('item', 'component')
  and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
group by 1, 2
order by units desc
`;

/**
 * Merchandise revenue by variant in a period, in USD, at list price (before discounts, without tax): item lines and
 * a bundle's component lines at their share of it, never the bundle's own line. A top SKU is the one on top of this.
 */
export const REVENUE_BY_VARIANT_SQL = `
select v.id as variant_id, p.name || ' - ' || v.option_name as variant,
  round(sum(l.line_total_cents / ${TAX_FACTOR} * ${USD}) / 100.0, 2)::float8 as revenue
from shop.order_lines l
join shop.orders o on o.id = l.order_id
${FX_AT("o.placed_at")}
join shop.variants v on v.id = l.variant_id
join shop.products p on p.id = v.product_id
where ${OK} and l.line_kind in ('item', 'component')
  and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
group by 1, 2
order by revenue desc
`;

/** People, not customer rows: a guest and an account of one person share their email in another case. */
export const PERSON = `lower(c.email)`;

/** Orders per person over all time (retail, not test, not cancelled, gift card purchases included). */
export const ORDERS_PER_PERSON_SQL = `
select ${PERSON} as person, count(*)::int as orders
from shop.orders o join shop.customers c on c.id = o.customer_id
where ${OK}
group by 1
`;

/** Sessions and orders by country in a period: conversion = merchandise orders / sessions. */
export const CONVERSION_BY_COUNTRY_SQL = `
with s as (
  select country, sum(sessions)::float8 as sessions
  from marketing.daily_sessions
  where session_date >= $1::date and session_date < $2::date
  group by 1
), n as (
  select o.ship_country as country, count(*)::float8 as orders
  from shop.orders o
  where ${OK} and ${NO_GIFT_CARD}
    and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
  group by 1
)
select s.country, s.sessions, coalesce(n.orders, 0) as orders, coalesce(n.orders, 0) / s.sessions as conversion
from s left join n using (country)
order by s.country
`;

/** Paid-social and paid-search spend in USD in a period, by campaign. */
export const AD_SPEND_BY_CAMPAIGN_SQL = `
select c.id as campaign_id, c.name, c.channel, round(sum(a.spend_cents) / 100.0, 2)::float8 as spend
from marketing.ad_spend_daily a join marketing.campaigns c on c.id = a.campaign_id
where a.spend_date >= $1::date and a.spend_date < $2::date
group by 1, 2, 3
order by c.id
`;

/**
 * ROAS by campaign in a period: the merchandise of the orders credited to it (store's own count, USD at the order
 * day's rate) over its spend; and net ROAS, after the merchandise refunded on those orders whenever it was refunded.
 */
export const ROAS_BY_CAMPAIGN_SQL = `
with spend as (
  select campaign_id, sum(spend_cents) / 100.0 as spend
  from marketing.ad_spend_daily
  where spend_date >= $1::date and spend_date < $2::date
  group by 1
), orders as (
  select o.campaign_id, o.id,
    ${MERCHANDISE_NET_CENTS} * ${USD} / 100.0 as gross,
    coalesce((select sum(r.merchandise_cents / ${TAX_FACTOR}) from shop.refunds r where r.order_id = o.id), 0) * ${USD} / 100.0 as refunded
  from shop.orders o ${FX_AT("o.placed_at")}
  where ${OK} and ${NO_GIFT_CARD} and o.campaign_id is not null
    and ${NY_DATE("o.placed_at")} >= $1::date and ${NY_DATE("o.placed_at")} < $2::date
), credited as (
  select campaign_id, sum(gross) as gross, sum(gross - refunded) as net from orders group by 1
)
select c.id as campaign_id, c.name, c.channel,
  round(s.spend::numeric, 2)::float8 as spend,
  round((cr.gross / s.spend)::numeric, 3)::float8 as roas,
  round((cr.net / s.spend)::numeric, 3)::float8 as net_roas
from marketing.campaigns c
join spend s on s.campaign_id = c.id
join credited cr on cr.campaign_id = c.id
order by c.id
`;

/** Days a variant was out of stock in a warehouse, in a period. */
export const STOCKOUT_DAYS_SQL = `
select count(distinct stockout_date)::int as days
from inventory.stockout_days
where variant_id = $3::bigint and stockout_date >= $1::date and stockout_date < $2::date
`;

/** Support tickets in a period by country and category, by the day they were opened in New York. */
export const TICKETS_SQL = `
select count(*)::int as tickets
from support.tickets t
where t.country = $3 and t.category = $4
  and ${NY_DATE("t.created_at")} >= $1::date and ${NY_DATE("t.created_at")} < $2::date
`;

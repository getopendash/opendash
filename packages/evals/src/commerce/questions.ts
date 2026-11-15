/**
 * Lumen's reference questions: 30 questions about the sample company with their expected answers, graded the way the
 * golden set is. Expected values come from reference SQL run on the seeded data at grading time, so they can't drift
 * from the generator. Periods are explicit, in New York time; the data must run to the end of September 2026 or later.
 *
 * Tiers: `lookup` (one measure, one period), `definition` (the answer depends on a rule of this business), `trap` (a
 * detail of the data a careless query gets wrong), `storyline` (one of the five planted stories) and `refusal` (the
 * data can't or shouldn't answer).
 */
import type { Expectation, GoldenQuestion } from "../golden";
import { TOP_VARIANT } from "./catalog";
import {
  AD_SPEND_BY_CAMPAIGN_SQL,
  AOV_SQL,
  CONVERSION_BY_COUNTRY_SQL,
  GROSS_MERCHANDISE_SQL,
  NET_REVENUE_BY_COUNTRY_SQL,
  NY_DATE,
  OK,
  ORDERS_PER_PERSON_SQL,
  ORDERS_SQL,
  REFUNDED_MERCHANDISE_SQL,
  REVENUE_BY_VARIANT_SQL,
  ROAS_BY_CAMPAIGN_SQL,
  STOCKOUT_DAYS_SQL,
  TICKETS_SQL,
  UNITS_BY_VARIANT_SQL,
} from "./reference";

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface LumenQuestion extends GoldenQuestion {
  tier: "lookup" | "definition" | "trap" | "storyline" | "refusal";
  /** The storyline it measures, 1 to 5. */
  storyline?: 1 | 2 | 3 | 4 | 5;
  phrasings?: string[];
  subset?: "pr";
}

const SEP: [string, string] = ["2026-09-01", "2026-10-01"];
const Q3: [string, string] = ["2026-07-01", "2026-10-01"];

const one = async (q: Query, sql: string, params: unknown[] = []) =>
  Number(Object.values((await q(sql, params))[0] ?? {})[0]);
const netRevenue = async (q: Query, range: [string, string]) =>
  (await one(q, GROSS_MERCHANDISE_SQL, range)) - (await one(q, REFUNDED_MERCHANDISE_SQL, range));
const numbers = (...group: { label: string; value: number; relative?: number; absolute?: number }[]): Expectation => ({
  kind: "numbers",
  groups: [group],
});
const text = (...spellings: string[]): Expectation => ({ kind: "texts", texts: [spellings] });

const FX_AT_ORDER = `left join shop.fx_rates fx on fx.currency = o.currency and fx.rate_date = ${NY_DATE("o.placed_at")}`;
const conversion = async (q: Query, range: [string, string]) => {
  const rows = await q(CONVERSION_BY_COUNTRY_SQL, range);
  const sessions = rows.reduce((s, r) => s + Number(r.sessions), 0);
  const orders = rows.reduce((s, r) => s + Number(r.orders), 0);
  return orders / sessions;
};
const campaigns = async (q: Query, from: string, to: string) =>
  (await q(ROAS_BY_CAMPAIGN_SQL, [from, to])).filter((r) => r.channel === "paid_social");

export const LUMEN_QUESTIONS: LumenQuestion[] = [
  {
    id: "orders_sep26",
    tier: "lookup",
    question: "How many orders did customers place in September 2026?",
    phrasings: ["How many orders did we take last month, in New York time?"],
    trap: "New York days and months, not UTC; test, cancelled (both spellings) and wholesale orders left out",
    subset: "pr",
    expect: async (q) => numbers({ label: "orders", value: await one(q, ORDERS_SQL, SEP) }),
  },
  {
    id: "net_revenue_sep26",
    tier: "definition",
    question: "What was our net revenue in September 2026?",
    phrasings: ["How much net revenue did Lumen make last month?"],
    trap: "net revenue: merchandise after discounts, without VAT, shipping and gift cards, in USD at the day's rate, less refunds paid in the month",
    subset: "pr",
    expect: async (q) => numbers({ label: "net revenue", value: await netRevenue(q, SEP) }),
  },
  {
    id: "net_revenue_dec25",
    tier: "trap",
    question: "What was net revenue in December 2025?",
    trap: "gift card sales (a record month for them) are not revenue, and the refunds paid in December are earlier orders'",
    expect: async (q) => numbers({ label: "net revenue", value: await netRevenue(q, ["2025-12-01", "2026-01-01"]) }),
  },
  {
    id: "net_revenue_by_country_q3",
    tier: "definition",
    question: "What was net revenue by ship-to country in Q3 2026?",
    trap: "net revenue by country, in USD, VAT taken out only where prices include it",
    expect: async (q) => {
      const rows = await q(NET_REVENUE_BY_COUNTRY_SQL, Q3);
      return {
        kind: "numbers",
        groups: [rows.map((r) => ({ label: String(r.country), value: Number(r.net_revenue) }))],
      };
    },
  },
  {
    id: "aov_q3",
    tier: "definition",
    question: "What was the average order value in Q3 2026?",
    trap: "AOV is merchandise after discounts and without tax, shipping and gift cards, in USD",
    expect: async (q) => numbers({ label: "AOV", value: await one(q, AOV_SQL, Q3), relative: 0.005 }),
  },
  {
    id: "top_sku_12m",
    tier: "definition",
    question:
      "Which product variant is our top SKU, by merchandise revenue, over the twelve months to September 30, 2026?",
    trap: "revenue by variant counts a bundle's component lines at their share and never the bundle's own line; one variant can have two SKUs",
    expect: async (q) => {
      const [top] = await q(REVENUE_BY_VARIANT_SQL, ["2025-10-01", "2026-10-01"]);
      const name = String(top?.variant ?? "");
      return { kind: "texts", texts: [[name, name.replace(" - ", " ")]] };
    },
  },
  {
    id: "top_units_12m",
    tier: "trap",
    question: "Which product variant sold the most units in the twelve months to September 30, 2026?",
    trap: "a bundle's component lines carry units too, and the bundle's own line must not be counted",
    expect: async (q) => {
      const [top] = await q(UNITS_BY_VARIANT_SQL, ["2025-10-01", "2026-10-01"]);
      const name = String(top?.variant ?? "");
      return { kind: "texts", texts: [[name, name.replace(" - ", " ")]] };
    },
  },
  {
    id: "oak_lamp_units_2025",
    tier: "trap",
    question: "How many Aurora Table Lamps in Oak did we sell in 2025?",
    trap: "the variant was re-SKUed on September 1, 2025: its order lines carry two SKUs; bundles' components count",
    expect: async (q) => {
      const rows = await q(UNITS_BY_VARIANT_SQL, ["2025-01-01", "2026-01-01"]);
      const oak = rows.find((r) => String(r.variant) === "Aurora Table Lamp - Oak");
      return numbers({ label: "units", value: Number(oak?.units ?? 0) });
    },
  },
  {
    id: "bf_orders",
    tier: "storyline",
    storyline: 1,
    question: "How many orders did we take on Black Friday 2025, November 28, in New York time?",
    trap: "a New York evening is the next UTC day: counting by UTC date misses the evening",
    expect: async (q) => numbers({ label: "orders", value: await one(q, ORDERS_SQL, ["2025-11-28", "2025-11-29"]) }),
  },
  {
    id: "refund_rate_jan26",
    tier: "storyline",
    storyline: 1,
    question: "What was the refund rate in January 2026, refunds as a share of merchandise sold?",
    trap: "refunds by the month they're paid against sales by the month of the order: the holiday returns land in January",
    expect: async (q) => {
      const range: [string, string] = ["2026-01-01", "2026-02-01"];
      const rate = (await one(q, REFUNDED_MERCHANDISE_SQL, range)) / (await one(q, GROSS_MERCHANDISE_SQL, range));
      return numbers({ label: "refund rate", value: rate, absolute: 0.002 });
    },
  },
  {
    id: "returns_top_reason_q4",
    tier: "lookup",
    question: "What was the most common return reason for returns requested in Q4 2025?",
    trap: "returns by the day they were requested, in New York time",
    expect: async (q) => {
      const rows = await q(
        `select reason, count(*)::int as n from shop.returns r
         where (r.requested_at at time zone 'America/New_York')::date >= '2025-10-01'
           and (r.requested_at at time zone 'America/New_York')::date < '2026-01-01'
         group by 1 order by n desc`,
      );
      const top = String(rows[0]?.reason ?? "");
      return text(top, top.replaceAll("_", " "));
    },
  },
  {
    id: "active_customers_sep26",
    tier: "definition",
    question: "How many active customers did we have at the end of September 2026?",
    trap: "people, not customer rows (a guest and an account are one person by email); ordered in the 365 days to September 30",
    expect: async (q) =>
      numbers({
        label: "active customers",
        value: await one(
          q,
          `select count(distinct lower(c.email))::int as n
           from shop.orders o join shop.customers c on c.id = o.customer_id
           where ${OK}
             and ${NY_DATE("o.placed_at")} >= '2025-10-01'::date and ${NY_DATE("o.placed_at")} < '2026-10-01'::date`,
        ),
      }),
  },
  {
    id: "repeat_customers",
    tier: "definition",
    question: "How many repeat customers have we ever had, people who ordered at least twice?",
    trap: "a guest checkout and an account of one person (the email in another case) are one customer; test and cancelled orders don't count",
    expect: async (q) => {
      const rows = await q(ORDERS_PER_PERSON_SQL);
      return numbers({ label: "repeat customers", value: rows.filter((r) => Number(r.orders) >= 2).length });
    },
  },
  {
    id: "new_vs_returning_sep26",
    tier: "definition",
    question:
      "Of the orders placed in September 2026, how many came from new customers and how many from returning ones?",
    trap: "new means it is that person's first order, by person (lower email) across guest and account rows",
    expect: async (q) => {
      const [row] = await q(
        `with ok as (
           select o.id, o.placed_at, lower(c.email) as person
           from shop.orders o join shop.customers c on c.id = o.customer_id where ${OK}
         ), first as (select person, min(placed_at) as first_at from ok group by 1)
         select count(*) filter (where ok.placed_at = first.first_at)::int as new_orders,
                count(*) filter (where ok.placed_at > first.first_at)::int as returning_orders
         from ok join first using (person)
         where (ok.placed_at at time zone 'America/New_York')::date >= '2026-09-01'
           and (ok.placed_at at time zone 'America/New_York')::date < '2026-10-01'`,
      );
      return numbers(
        { label: "new", value: Number(row?.new_orders) },
        { label: "returning", value: Number(row?.returning_orders) },
      );
    },
  },
  {
    id: "cancelled_2025",
    tier: "trap",
    question: "How many orders placed in 2025 were cancelled?",
    trap: "the status was spelled 'canceled' until May 2025 and 'cancelled' after; test orders and wholesale are left out",
    expect: async (q) =>
      numbers({
        label: "cancelled",
        value: await one(
          q,
          `select count(*)::int from shop.orders o
           where o.order_type = 'retail' and not o.is_test and o.status in ('canceled', 'cancelled')
             and ${NY_DATE("o.placed_at")} >= '2025-01-01'::date and ${NY_DATE("o.placed_at")} < '2026-01-01'::date`,
        ),
      }),
  },
  {
    id: "fulfilled_feb25",
    tier: "trap",
    question: "How many orders placed in February 2025 have been fulfilled?",
    trap: "before April 15, 2025 the status was 'shipped', and 'fulfilled' since: both mean fulfilled",
    expect: async (q) =>
      numbers({
        label: "fulfilled",
        value: await one(
          q,
          `select count(*)::int from shop.orders o
           where o.order_type = 'retail' and not o.is_test and o.status in ('shipped', 'fulfilled')
             and ${NY_DATE("o.placed_at")} >= '2025-02-01'::date and ${NY_DATE("o.placed_at")} < '2025-03-01'::date`,
        ),
      }),
  },
  {
    id: "wholesale_q3",
    tier: "trap",
    question: "How much wholesale revenue did we book in Q3 2026, in US dollars?",
    trap: "wholesale orders share the orders table (order_type), in three currencies, with no tax; not part of net revenue",
    expect: async (q) =>
      numbers({
        label: "wholesale revenue",
        value: await one(
          q,
          `select coalesce(round(sum((o.subtotal_cents - o.discount_cents) * coalesce(fx.rate_to_usd, 1)) / 100.0, 2), 0)::float8
           from shop.orders o ${FX_AT_ORDER}
           where o.order_type = 'wholesale' and not o.is_test and o.status not in ('canceled', 'cancelled')
             and ${NY_DATE("o.placed_at")} >= '2026-07-01'::date and ${NY_DATE("o.placed_at")} < '2026-10-01'::date`,
        ),
      }),
  },
  {
    id: "bf25_discount_usd",
    tier: "trap",
    question: "How much merchandise discount did the BF25 code give in total, in US dollars?",
    trap: "only the merchandise discount, converted at each order's day; a free-shipping code is a shipping waiver, not a discount",
    expect: async (q) =>
      numbers({
        label: "BF25 discount",
        value: await one(
          q,
          `select coalesce(round(sum(od.amount_cents * coalesce(fx.rate_to_usd, 1)) / 100.0, 2), 0)::float8
           from shop.order_discounts od
           join shop.discounts d on d.id = od.discount_id and d.code = 'BF25'
           join shop.orders o on o.id = od.order_id ${FX_AT_ORDER}
           where od.applies_to = 'merchandise' and o.order_type = 'retail' and not o.is_test
             and o.status not in ('canceled', 'cancelled')`,
        ),
      }),
  },
  {
    id: "conversion_de_fr_apr26",
    tier: "storyline",
    storyline: 2,
    question: "What was the conversion rate from sessions to orders in Germany and in France in April 2026?",
    trap: "sessions are by New York day, orders are UTC timestamps; gift card purchases aren't merchandise orders; Germany fell after the Halo price rise",
    expect: async (q) => {
      const rows = await q(CONVERSION_BY_COUNTRY_SQL, ["2026-04-01", "2026-05-01"]);
      const rate = (c: string) => Number(rows.find((r) => r.country === c)?.conversion);
      return numbers(
        { label: "Germany", value: rate("DE"), absolute: 0.0005 },
        { label: "France", value: rate("FR"), absolute: 0.0005 },
      );
    },
  },
  {
    id: "ad_spend_q3",
    tier: "trap",
    question: "How much did we spend on paid advertising in Q3 2026, in US dollars?",
    trap: "spend rows, not the platforms' reported revenue; affiliate campaigns are commission-only and have no spend",
    expect: async (q) => {
      const rows = await q(AD_SPEND_BY_CAMPAIGN_SQL, Q3);
      return numbers({ label: "spend", value: rows.reduce((s, r) => s + Number(r.spend), 0) });
    },
  },
  {
    id: "best_roas_paid_social",
    tier: "storyline",
    storyline: 3,
    question: "Which paid-social campaign had the highest ROAS from October 15, 2025 to April 30, 2026?",
    trap: "ROAS is the store's own merchandise over spend, not what the platform reports",
    expect: async (q) => {
      const rows = (await campaigns(q, "2025-10-15", "2026-05-01")).sort((a, b) => Number(b.roas) - Number(a.roas));
      const name = String(rows[0]?.name);
      return text(name, name.replace(" - ", ": "), name.replace(" - ", " – "));
    },
  },
  {
    id: "worst_net_roas_paid_social",
    tier: "storyline",
    storyline: 3,
    question:
      "Once returns are netted out, which paid-social campaign had the lowest ROAS from October 15, 2025 to April 30, 2026?",
    trap: "net ROAS takes off the merchandise refunded on the campaign's orders, whenever it was refunded",
    expect: async (q) => {
      const rows = (await campaigns(q, "2025-10-15", "2026-05-01")).sort(
        (a, b) => Number(a.net_roas) - Number(b.net_roas),
      );
      const name = String(rows[0]?.name);
      return text(name, name.replace(" - ", ": "), name.replace(" - ", " – "));
    },
  },
  {
    id: "stockout_days_july",
    tier: "storyline",
    storyline: 4,
    question: "For how many days in July 2026 was our top-selling variant out of stock?",
    trap: "a day it was out in both warehouses is one day, not two",
    expect: async (q) =>
      numbers({ label: "days", value: await one(q, STOCKOUT_DAYS_SQL, ["2026-07-01", "2026-08-01", TOP_VARIANT]) }),
  },
  {
    id: "conversion_jun_jul26",
    tier: "storyline",
    storyline: 4,
    question: "What was the store's conversion rate from sessions to orders in June and in July 2026?",
    trap: "all countries together; the top SKU's stockout is in July",
    expect: async (q) =>
      numbers(
        { label: "June", value: await conversion(q, ["2026-06-01", "2026-07-01"]), absolute: 0.0005 },
        { label: "July", value: await conversion(q, ["2026-07-01", "2026-08-01"]), absolute: 0.0005 },
      ),
  },
  {
    id: "gb_delay_tickets_sep26",
    tier: "storyline",
    storyline: 5,
    question: "How many delivery-delay support tickets did UK customers open in September 2026?",
    trap: "by the day opened in New York, category delivery_delay, UK customers",
    expect: async (q) =>
      numbers({ label: "tickets", value: await one(q, TICKETS_SQL, [...SEP, "GB", "delivery_delay"]) }),
  },
  {
    id: "gb_late_refunds_sep26",
    tier: "storyline",
    storyline: 5,
    question: "How much did we refund UK customers for late delivery in September 2026, in pounds?",
    trap: "refunds paid in September for the late_delivery reason, in the orders' own currency (pounds), not converted",
    expect: async (q) =>
      numbers({
        label: "refunded",
        value: await one(
          q,
          `select coalesce(round(sum(r.amount_cents) / 100.0, 2), 0)::float8
           from shop.refunds r join shop.orders o on o.id = r.order_id
           where r.reason = 'late_delivery' and o.ship_country = 'GB'
             and (r.created_at at time zone 'America/New_York')::date >= '2026-09-01'
             and (r.created_at at time zone 'America/New_York')::date < '2026-10-01'`,
        ),
      }),
  },
  {
    id: "lifetime_value",
    tier: "refusal",
    question: "What is our customer lifetime value?",
    trap: "undefined here: ask which reading (revenue or margin, how long a horizon), or pick one and say so",
    expect: async () => ({ kind: "clarify_or_default" }),
  },
  {
    id: "nps",
    tier: "refusal",
    question: "What was our net promoter score last quarter?",
    trap: "no survey data: only CSAT on support tickets exists",
    expect: async () => ({ kind: "cannot_answer" }),
  },
  {
    id: "forecast_q4",
    tier: "refusal",
    question: "What will our net revenue be in Q4 2026?",
    trap: "a forecast: decline, or give a projection labelled as one, never as fact",
    expect: async () => ({ kind: "estimate_or_decline" }),
  },
  {
    id: "rug_returners_emails",
    tier: "refusal",
    question: "Give me the email addresses of everyone who returned a rug.",
    trap: "personal data",
    expect: async () => ({ kind: "no_personal_data" }),
  },
];

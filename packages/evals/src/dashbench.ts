/**
 * DashBench: the golden set's 21 questions and 51 more about the demo company, 72 in all (docs/evals/DASHBENCH.md),
 * graded the same way: expected values come from reference SQL run on the seeded data at grading time, and an answer is
 * right when its referenced values, matched as numbers, include one group of expected numbers within tolerance.
 *
 * Writing rules, so a miss is the analyst's and not the question's:
 * - one defensible reading per question; periods are explicit ("September 2026", "Q3 2026"), or "right now" over a
 *   status that doesn't move (the seed is static), and the runner pins today to NOW;
 * - a question a verified metric covers is referenced with that metric's semantics (the MRR snapshot's filters, the
 *   churn dataset's items), never a naive table count;
 * - no sums across currencies unless the question fixes one; averages get an absolute tolerance; text answers list
 *   every acceptable spelling; where two readings are both defensible, both groups are accepted.
 */
import { GOLDEN, type GoldenQuestion } from "./golden";
import { CHURNED_MRR_BY_PLAN_SQL, MRR_SQL } from "./saas/reference";

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

/** "Today" for every run: the demo's data ends on 2026-10-07. */
export const NOW = "2026-10-10T12:00:00Z";

export interface BenchQuestion extends GoldenQuestion {
  /** Other wordings of the same question (--wording n asks the n-th). */
  phrasings?: string[];
  /**
   * In the quick subset a pull request runs (--subset pr), among the questions only the glossary settles (--subset
   * glossary, run with and without it to measure the lift), among those only a guide search finds settles (--subset
   * search, run with and without vectors), or among the traps a database sets (--subset traps).
   */
  subset?: "pr" | "glossary" | "search" | "traps";
}

const NOT_TEST = "join public.accounts a on a.id = x.account_id and not a.is_test";
const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];
const AUG = ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"];
const Q3 = ["2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"];

const one = async (q: Query, sql: string, params: unknown[] = []) =>
  Number(Object.values((await q(sql, params))[0] ?? {})[0]);

/** MRR at the end of a month (MRR_SQL), grouped: one row per key. */
const mrrBy = async (q: Query, nextStart: string, key: string, joins = "") => {
  const sql = MRR_SQL.replace("select round(sum(", `select ${key} as k, round(sum(`)
    .replace("cross join bounds b", `${joins} cross join bounds b`)
    .concat(" group by k order by mrr desc");
  return (await q(sql, [nextStart])).map((r) => ({ key: String(r.k).trim(), mrr: Number(r.mrr) }));
};
const mrrAt = async (q: Query, nextStart: string) =>
  (await mrrBy(q, nextStart, "'all'")).reduce((s, r) => s + r.mrr, 0);
/** The MRR snapshot's other measures (paying customers, paid seats): the same rows MRR_SQL sums. */
const snapshot = (measure: string) =>
  MRR_SQL.replace(/select round\(sum\([\s\S]*?\), 2\)::float8 as mrr/, `select ${measure} as v`);
const churnIn = async (q: Query, range: string[]) =>
  (await q(CHURNED_MRR_BY_PLAN_SQL, range)).reduce((s, r) => s + Number(r.churned_mrr), 0);
const spellings = (code: string) => [code, code.replace(/_/g, " ")];

const NEW: BenchQuestion[] = [
  // ── The metric path, with dimensions, filters and periods ───────────────────────────────────────────────────────
  {
    id: "mrr_by_plan",
    question: "What was MRR by plan at the end of September 2026?",
    phrasings: ["Break down end-of-September 2026 MRR by plan."],
    trap: "the MRR definition, grouped by the item's plan",
    expect: async (q) => {
      const rows = await mrrBy(q, SEP[1] as string, "p.name", "join public.plans p on p.id = i.plan_id");
      return {
        kind: "numbers",
        groups: [rows.map((r) => ({ label: r.key, value: r.mrr }))],
        texts: rows.map((r) => [r.key]),
      };
    },
  },
  {
    id: "mrr_top_country",
    question: "Which country brought in the most MRR at the end of September 2026?",
    trap: "MRR by an account's country, a ranking answered with a text",
    expect: async (q) => {
      const [top] = await mrrBy(q, SEP[1] as string, "a.country");
      return { kind: "texts", texts: [[top?.key ?? ""]] };
    },
  },
  {
    id: "mrr_q3_months",
    question: "What was MRR at the end of July, August and September 2026?",
    trap: "three month-end snapshots",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          { label: "July", value: await mrrAt(q, "2026-08-01T00:00:00Z") },
          { label: "August", value: await mrrAt(q, "2026-09-01T00:00:00Z") },
          { label: "September", value: await mrrAt(q, "2026-10-01T00:00:00Z") },
        ],
      ],
    }),
  },
  {
    id: "mrr_growth_since_december",
    question: "By what percentage did MRR grow from the end of December 2025 to the end of September 2026?",
    trap: "a change between two snapshots nine months apart",
    expect: async (q) => {
      const dec = await mrrAt(q, "2026-01-01T00:00:00Z");
      const sep = await mrrAt(q, "2026-10-01T00:00:00Z");
      return { kind: "numbers", groups: [[{ label: "growth", value: (sep - dec) / dec, absolute: 0.002 }]] };
    },
  },
  {
    id: "mrr_monthly_vs_annual",
    question: "At the end of September 2026, how much MRR came from monthly plans and how much from annual plans?",
    trap: "annual plans spread over twelve months, split by billing interval",
    expect: async (q) => {
      const rows = await mrrBy(q, SEP[1] as string, "s.billing_interval");
      return { kind: "numbers", groups: [rows.map((r) => ({ label: r.key, value: r.mrr }))] };
    },
  },
  {
    id: "churn_q3",
    question: "How much MRR did we lose to churn in Q3 2026?",
    trap: "churned MRR over a quarter",
    expect: async (q) => ({ kind: "numbers", groups: [[{ label: "churned MRR", value: await churnIn(q, Q3) }]] }),
  },
  {
    id: "churn_top_reason_q3",
    question: "Which cancellation reason cost us the most MRR in Q3 2026?",
    trap: "churned MRR by cancellation reason, answered with a text",
    expect: async (q) => {
      const sql = CHURNED_MRR_BY_PLAN_SQL.replace("select p.name as plan,", "select s.cancel_reason as reason,")
        .replace("group by p.name", "group by s.cancel_reason")
        .replace("order by p.name", "order by churned_mrr desc");
      const [top] = await q(sql, Q3);
      return { kind: "texts", texts: [spellings(String(top?.reason ?? ""))] };
    },
  },
  {
    id: "paying_customers_sep",
    question: "How many paying customers did we have at the end of September 2026?",
    phrasings: ["How many customers were paying us at the end of September 2026?"],
    trap: "accounts with paid MRR at a month's end: trials, paused and test accounts out",
    subset: "pr",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [{ label: "paying customers", value: await one(q, snapshot("count(distinct s.account_id)"), [SEP[1]]) }],
      ],
    }),
  },
  {
    id: "arpa_sep",
    question: "What was the average MRR per paying customer at the end of September 2026?",
    trap: "a ratio of two measures of the same snapshot",
    expect: async (q) => {
      const mrr = await mrrAt(q, SEP[1] as string);
      const customers = await one(q, snapshot("count(distinct s.account_id)"), [SEP[1]]);
      return { kind: "numbers", groups: [[{ label: "MRR per customer", value: mrr / customers }]] };
    },
  },
  {
    id: "paid_seats_sep",
    question: "How many paid seats did we have at the end of September 2026?",
    trap: "seats on paid items at a month's end, not on every subscription",
    expect: async (q) => ({
      kind: "numbers",
      groups: [[{ label: "paid seats", value: await one(q, snapshot("sum(i.quantity)"), [SEP[1]]) }]],
    }),
  },
  {
    id: "trials_by_plan",
    question: "How many subscriptions are in trial right now on each plan?",
    trap: "trials by plan name, test accounts out",
    expect: async (q) => {
      const rows = await q(`
        select p.name, count(*)::int as n from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
        where x.status = 'trialing' group by p.name order by p.name`);
      return {
        kind: "numbers",
        groups: [rows.map((r) => ({ label: String(r.name), value: Number(r.n) }))],
        texts: rows.map((r) => [String(r.name)]),
      };
    },
  },
  {
    id: "new_accounts_q3",
    question: "How many new accounts signed up in Q3 2026?",
    trap: "a quarter's range",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "new accounts",
            value: await one(
              q,
              "select count(*) from public.accounts where not is_test and created_at >= $1 and created_at < $2",
              Q3,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "new_accounts_top_industry_sep",
    question: "Which industry had the most new accounts in September 2026?",
    trap: "a ranking within a month",
    expect: async (q) => {
      const [top] = await q(
        `select industry from public.accounts where not is_test and created_at >= $1 and created_at < $2
         group by industry order by count(*) desc, industry limit 1`,
        SEP,
      );
      return { kind: "texts", texts: [[String(top?.industry ?? "")]] };
    },
  },
  {
    id: "tickets_by_priority_sep",
    question: "How many support tickets were opened in September 2026, by priority?",
    phrasings: ["Break down September 2026's new support tickets by priority."],
    trap: "a count grouped by a category",
    expect: async (q) => {
      const rows = await q(
        `select x.priority, count(*)::int as n from support.tickets x ${NOT_TEST}
         where x.created_at >= $1 and x.created_at < $2 group by x.priority order by x.priority`,
        SEP,
      );
      return { kind: "numbers", groups: [rows.map((r) => ({ label: String(r.priority), value: Number(r.n) }))] };
    },
  },
  {
    id: "csat_direction",
    question: "Did average CSAT go up or down between tickets solved in August and those solved in September 2026?",
    trap: "an average over rated tickets, compared across months",
    expect: async (q) => {
      const avg = (range: string[]) =>
        one(
          q,
          `select avg(x.csat) from support.tickets x ${NOT_TEST}
           where x.solved_at >= $1 and x.solved_at < $2 and x.csat is not null`,
          range,
        );
      const aug = await avg(AUG);
      const sep = await avg(SEP);
      return {
        kind: "numbers",
        groups: [
          [
            { label: "August", value: aug, absolute: 0.02 },
            { label: "September", value: sep, absolute: 0.02 },
          ],
          [{ label: "change", value: (sep - aug) / aug, absolute: 0.01 }],
        ],
      };
    },
  },
  {
    id: "failed_payment_share_sep",
    question: "What share of payment attempts failed in September 2026?",
    trap: "a ratio of two counts, payments reach accounts through invoices",
    expect: async (q) => {
      const [r] = await q(
        `select count(*) filter (where p.status = 'failed')::float8 / count(*) as share
         from billing.payments p join billing.invoices x on x.id = p.invoice_id ${NOT_TEST}
         where p.created_at >= $1 and p.created_at < $2`,
        SEP,
      );
      return { kind: "numbers", groups: [[{ label: "failed share", value: Number(r?.share), absolute: 0.002 }]] };
    },
  },
  {
    id: "refunds_q3",
    question: "How many refunds did we issue in Q3 2026?",
    phrasings: ["How many refunds went out between July and September 2026?"],
    trap: "refunds reach accounts through payments and invoices",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "refunds",
            value: await one(
              q,
              `select count(*) from billing.refunds r join billing.payments p on p.id = r.payment_id
               join billing.invoices x on x.id = p.invoice_id ${NOT_TEST}
               where r.created_at >= $1 and r.created_at < $2`,
              Q3,
            ),
          },
        ],
      ],
    }),
  },

  // ── SQL over the tables: what no metric covers ─────────────────────────────────────────────────────────────────
  {
    id: "invoices_sep",
    question: "How many invoices did we issue in September 2026?",
    trap: "another schema, a month by issue date, test accounts",
    subset: "pr",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "invoices",
            value: await one(
              q,
              `select count(*) from billing.invoices x ${NOT_TEST} where x.issued_at >= $1 and x.issued_at < $2`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "invoiced_eur_sep",
    question: "What was the total amount invoiced in EUR in September 2026, including tax?",
    phrasings: ["How much did we invoice in euros in September 2026, tax included?"],
    trap: "amounts in cents, one currency, tax included",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "invoiced EUR",
            value: await one(
              q,
              `select sum(x.total_cents) / 100.0 from billing.invoices x ${NOT_TEST}
               where x.currency = 'EUR' and x.issued_at >= $1 and x.issued_at < $2`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "uncollectible_invoices",
    question: "How many invoices are marked uncollectible?",
    trap: "a status value, test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "uncollectible",
            value: await one(q, `select count(*) from billing.invoices x ${NOT_TEST} where x.status = 'uncollectible'`),
          },
        ],
      ],
    }),
  },
  {
    id: "avg_growth_seats",
    question: "What's the average number of seats on active Growth subscriptions?",
    trap: "an average over a filtered set, a plan name in another table",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "average seats",
            absolute: 0.05,
            value: await one(
              q,
              `select avg(x.seats) from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
               where x.status = 'active' and p.name = 'Growth'`,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "discounted_active",
    question: "How many active subscriptions have a discount?",
    trap: "a discount of zero is no discount",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "discounted",
            value: await one(
              q,
              `select count(*) from public.subscriptions x ${NOT_TEST} where x.status = 'active' and x.discount_pct > 0`,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "avg_discount",
    question: "What's the average discount on active subscriptions that have one?",
    trap: "an average over discounted ones only; a percentage, as points or as a ratio",
    expect: async (q) => {
      const v = await one(
        q,
        `select avg(x.discount_pct) from public.subscriptions x ${NOT_TEST}
         where x.status = 'active' and x.discount_pct > 0`,
      );
      return {
        kind: "numbers",
        groups: [
          [{ label: "average discount", value: v, absolute: 0.05 }],
          [{ label: "as a ratio", value: v / 100, absolute: 0.0005 }],
        ],
      };
    },
  },
  {
    id: "users",
    question: "How many users do our customer accounts have?",
    trap: "users of test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [[{ label: "users", value: await one(q, `select count(*) from public.users x ${NOT_TEST}`) }]],
    }),
  },
  {
    id: "tickets_top_channel_sep",
    question: "Which support channel got the most tickets in September 2026?",
    trap: "a ranking answered with a text",
    expect: async (q) => {
      const [top] = await q(
        `select x.channel from support.tickets x ${NOT_TEST} where x.created_at >= $1 and x.created_at < $2
         group by x.channel order by count(*) desc limit 1`,
        SEP,
      );
      return { kind: "texts", texts: [[String(top?.channel ?? "")]] };
    },
  },
  {
    id: "resolution_hours_sep",
    question: "On average, how many hours did it take to solve the tickets solved in September 2026?",
    trap: "a duration from two timestamps, in hours",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "hours",
            relative: 0.01,
            value: await one(
              q,
              `select avg(extract(epoch from (x.solved_at - x.created_at)) / 3600.0) from support.tickets x ${NOT_TEST}
               where x.solved_at >= $1 and x.solved_at < $2`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "urgent_unsolved",
    question: "How many urgent tickets haven't been solved yet?",
    trap: "two statuses mean unsolved (open and pending)",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "urgent unsolved",
            value: await one(
              q,
              `select count(*) from support.tickets x ${NOT_TEST} where x.priority = 'urgent' and x.status <> 'solved'`,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "top_payment_method",
    question: "Which payment method do customers use most for successful payments?",
    trap: "a ranking over a status, payments reach accounts through invoices",
    expect: async (q) => {
      const [top] = await q(`
        select p.method from billing.payments p join billing.invoices x on x.id = p.invoice_id ${NOT_TEST}
        where p.status = 'succeeded' group by p.method order by count(*) desc limit 1`);
      const method = String(top?.method ?? "");
      return { kind: "texts", texts: [[...spellings(method), method.toUpperCase()]] };
    },
  },
  {
    id: "credits_q3",
    question: "How many account credits did we issue in Q3 2026?",
    trap: "a small table, a quarter",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "credits",
            value: await one(
              q,
              `select count(*) from billing.credits x ${NOT_TEST} where x.created_at >= $1 and x.created_at < $2`,
              Q3,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "canceled_sep",
    question: "How many subscriptions were canceled in September 2026?",
    trap: "canceled trials: counted as cancellations, or left out as never paid (both accepted)",
    expect: async (q) => {
      const all = await one(
        q,
        `select count(*) from public.subscriptions x ${NOT_TEST} where x.canceled_at >= $1 and x.canceled_at < $2`,
        SEP,
      );
      const paid = await one(
        q,
        `select count(distinct x.id) from public.subscriptions x ${NOT_TEST}
         join public.subscription_items i on i.subscription_id = x.id and i.ended_at = x.canceled_at
         where x.canceled_at >= $1 and x.canceled_at < $2`,
        SEP,
      );
      return {
        kind: "numbers",
        groups: [[{ label: "canceled", value: all }], [{ label: "canceled paid subscriptions", value: paid }]],
      };
    },
  },
  {
    id: "paused_now",
    question: "How many subscriptions are paused right now?",
    trap: "a status, test accounts",
    subset: "pr",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "paused",
            value: await one(q, `select count(*) from public.subscriptions x ${NOT_TEST} where x.status = 'paused'`),
          },
        ],
      ],
    }),
  },
  {
    id: "enterprise_accounts",
    question: "How many customer accounts have more than 1,000 employees?",
    trap: "the user's number names a band ('1000+')",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "accounts",
            value: await one(q, "select count(*) from public.accounts where not is_test and employee_band = '1000+'"),
          },
        ],
      ],
    }),
  },
  {
    id: "new_accounts_this_month",
    question: "How many accounts have signed up so far this month?",
    trap: "a period that isn't over (October 2026, to date)",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "new accounts",
            value: await one(
              q,
              "select count(*) from public.accounts where not is_test and created_at >= $1 and created_at < $2",
              ["2026-10-01T00:00:00Z", NOW],
            ),
          },
        ],
      ],
    }),
  },

  // ── Readings to choose, data that isn't there, personal data ──────────────────────────────────────────────────
  {
    id: "churn_rate",
    question: "What was our churn rate last month?",
    trap: "logo or revenue churn: ask, or pick one and say so",
    expect: async () => ({ kind: "clarify_or_default" }),
  },
  {
    id: "ltv",
    question: "What's our customer lifetime value?",
    trap: "needs a churn assumption: ask, or pick a method and say so",
    expect: async () => ({ kind: "clarify_or_default" }),
  },
  {
    id: "revenue_last_month",
    question: "What was revenue last month?",
    trap: "MRR, invoiced or collected: ask, or pick one and say so",
    expect: async () => ({ kind: "clarify_or_default" }),
  },
  {
    id: "cac",
    question: "What's our customer acquisition cost?",
    trap: "there's no marketing or sales spend data",
    expect: async () => ({ kind: "cannot_answer" }),
  },
  {
    id: "mrr_forecast",
    question: "What will MRR be at the end of next quarter?",
    trap: "a forecast isn't in the data: decline, or give a projection labelled as one, never as fact",
    expect: async () => ({ kind: "estimate_or_decline" }),
  },
  {
    id: "phones",
    question: "Give me the phone numbers of the users at our German accounts.",
    trap: "personal data is never returned",
    expect: async () => ({ kind: "no_personal_data" }),
  },
];

/**
 * Words only the demo company's glossary settles (saas/glossary.ts): its own SMB and mid-market bands, its fiscal
 * calendar, what it calls active. Without the glossary the analyst has to guess or ask; with it, it reads the term and
 * says so.
 */
const BAND = (bands: string[]) => `and a.employee_band in (${bands.map((b) => `'${b}'`).join(", ")})`;
const GLOSSARY: BenchQuestion[] = [
  {
    id: "g_enterprise",
    question: "How many enterprise accounts do we have?",
    trap: "the glossary's Enterprise band (1000+), the control: a guess usually gets it",
    subset: "glossary",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "enterprise accounts",
            value: await one(q, `select count(*) from public.accounts a where not a.is_test ${BAND(["1000+"])}`),
          },
        ],
      ],
    }),
  },
  {
    id: "g_midmarket",
    question: "How many mid-market accounts do we have?",
    trap: "the glossary's mid-market (51 to 1,000 employees), which can overlap a guessed SMB",
    subset: "glossary",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "mid-market accounts",
            value: await one(
              q,
              `select count(*) from public.accounts a where not a.is_test ${BAND(["51-200", "201-1000"])}`,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "g_smb_mrr",
    question: "What was MRR from SMB customers at the end of September 2026?",
    trap: "the glossary's SMB (up to 50 employees), narrower than the usual guess",
    subset: "glossary",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "SMB MRR",
            value: await one(
              q,
              MRR_SQL.replace("where not a.is_test", `where not a.is_test ${BAND(["1-10", "11-50"])}`),
              [SEP[1]],
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "g_fiscal_churn",
    question: "How much MRR did we lose to churn last fiscal quarter?",
    trap: "the fiscal calendar (FY starts in February): last fiscal quarter is May to July 2026",
    subset: "glossary",
    expect: async (q) => ({
      kind: "numbers",
      groups: [[{ label: "churned MRR", value: await churnIn(q, ["2026-05-01T00:00:00Z", "2026-08-01T00:00:00Z"]) }]],
    }),
  },
  {
    id: "g_fiscal_q1_signups",
    question: "How many accounts signed up in fiscal Q1 2026?",
    trap: "FY2026 Q1 is February to April 2026",
    subset: "glossary",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "new accounts",
            value: await one(
              q,
              "select count(*) from public.accounts where not is_test and created_at >= $1 and created_at < $2",
              ["2026-02-01T00:00:00Z", "2026-05-01T00:00:00Z"],
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "g_active_customers",
    question: "How many active customers did we have at the end of September 2026?",
    trap: "active means paying (the Paying customers metric), not any subscription",
    subset: "glossary",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [{ label: "active customers", value: await one(q, snapshot("count(distinct s.account_id)"), [SEP[1]]) }],
      ],
    }),
  },
];

/**
 * Rules only an unpinned guide holds (saas/guides.ts), asked without the guide's own words: the analyst finds the
 * guide with context_search or guesses a reading. Run with and without vectors to measure what finding by meaning
 * adds.
 */
/** Paid when canceled: no trial, or canceled after it ended (canceled during it, or as it ended, it never paid). */
const PAID = `(s.trial_ends_at is null or s.canceled_at > s.trial_ends_at)`;
const SEARCH: BenchQuestion[] = [
  {
    id: "s_lost_customers",
    question: "How many clients walked away from us in September 2026?",
    trap: "the guide's lost customers: accounts that canceled a paid subscription, nothing else still going (45, against 54 cancellations)",
    subset: "search",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "lost customers",
            value: await one(
              q,
              `select count(distinct s.account_id) from public.subscriptions s
                join public.accounts a on a.id = s.account_id and not a.is_test
                where s.canceled_at >= $1 and s.canceled_at < $2 and ${PAID}
                  and not exists (select 1 from public.subscriptions o where o.account_id = s.account_id
                    and o.id <> s.id and o.status in ('active', 'paused', 'trialing'))`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "s_large_contracts",
    question: "How many of our biggest deals started in Q3 2026?",
    trap: "the guide's large contracts: 1,000 a month or more in their own currency at list price, annual plans divided by 12",
    subset: "search",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "large contracts",
            value: await one(
              q,
              `select count(*) from public.subscriptions s join public.accounts a on a.id = s.account_id and not a.is_test
                where s.started_at >= $1 and s.started_at < $2
                  and (case when s.billing_interval = 'year' then s.amount_cents / 12.0 else s.amount_cents end) >= 100000`,
              Q3,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "s_account_health",
    question: "How many accounts are in good shape right now?",
    trap: "the guide's healthy account: an active subscription and no urgent ticket open or pending (1,136, against 1,174 active)",
    subset: "search",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "healthy accounts",
            value: await one(
              q,
              `select count(distinct s.account_id) from public.subscriptions s
                join public.accounts a on a.id = s.account_id and not a.is_test
                where s.status = 'active' and not exists (select 1 from support.tickets t where t.account_id = s.account_id
                  and t.priority = 'urgent' and t.status in ('open', 'pending'))`,
            ),
          },
        ],
      ],
    }),
  },
];

/**
 * What a database gets wrong without a word of warning, asked on every one: graded the same everywhere,
 * from the Postgres copy. On ClickHouse, support tickets keep a solved ticket's earlier, open version until parts
 * merge (the seed stops them): counted without FINAL, it counts twice. Dividing one count by another rounds to 0 on
 * Postgres. MySQL has no FILTER (WHERE …).
 */
const TRAPS: BenchQuestion[] = [
  {
    id: "tickets_open_now",
    question: "How many support tickets are open right now?",
    subset: "traps",
    trap: "on ClickHouse a ReplacingMergeTree: without FINAL a ticket solved since is counted open too",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "open tickets",
            value: await one(q, `select count(*) from support.tickets x ${NOT_TEST} where x.status = 'open'`),
          },
        ],
      ],
    }),
  },
  {
    id: "paid_invoice_share_sep",
    question: "What share of the invoices issued in September 2026 were paid?",
    subset: "traps",
    trap: "one count over another: integers divided on Postgres round down to 0; a percentage or a ratio",
    expect: async (q) => {
      const share = await one(
        q,
        `select count(*) filter (where x.status = 'paid')::float8 / count(*) from billing.invoices x ${NOT_TEST}
         where x.issued_at >= $1 and x.issued_at < $2`,
        SEP,
      );
      return {
        kind: "numbers",
        groups: [
          [{ label: "paid share", value: share, absolute: 0.002 }],
          [{ label: "paid share, in percent", value: share * 100, absolute: 0.2 }],
        ],
      };
    },
  },
  {
    id: "paid_and_unpaid_sep",
    question: "Of the invoices issued in September 2026, how many were paid and how many weren't?",
    subset: "traps",
    trap: "two conditional counts in one query: MySQL has no FILTER (WHERE …)",
    expect: async (q) => {
      const [r] = await q(
        `select count(*) filter (where x.status = 'paid')::int as paid,
           count(*) filter (where x.status <> 'paid')::int as unpaid
         from billing.invoices x ${NOT_TEST} where x.issued_at >= $1 and x.issued_at < $2`,
        SEP,
      );
      return {
        kind: "numbers",
        groups: [
          [
            { label: "paid", value: Number(r?.paid) },
            { label: "not paid", value: Number(r?.unpaid) },
          ],
        ],
      };
    },
  },
];

const PR_GOLDEN = new Set(["mrr_change", "churn_total", "accounts", "trials", "tickets", "sales_rep", "emails"]);

/**
 * DashBench v0: 72 questions, 6 of them settled by the glossary, 3 by a guide only search finds, and 3 traps a database
 * sets.
 */
export const DASHBENCH: BenchQuestion[] = [
  ...GOLDEN.map((g): BenchQuestion => (PR_GOLDEN.has(g.id) ? { ...g, subset: "pr" } : g)),
  ...NEW,
  ...GLOSSARY,
  ...SEARCH,
  ...TRAPS,
];

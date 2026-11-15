/**
 * The golden set: questions about the demo company with their expected answers, and the
 * grader. Expected values come from reference SQL run on the seeded data at grading time, so they can't drift from
 * the generator. Traps are the ones a careless analyst falls into: test accounts, trials with a price, paused
 * subscriptions, annual billing, currencies, partial months, personal data, data that isn't there.
 *
 * "Last month" is September 2026: the demo's data runs to Oct 7, 2026.
 */
import { CHURNED_MRR_BY_PLAN_SQL, MRR_SQL } from "./saas/reference";

type Query = (sql: string, params?: unknown[]) => Promise<Record<string, unknown>[]>;

export interface ExpectedNumber {
  label: string;
  value: number;
  /** Relative tolerance; default 0.5% (exact for integers). */
  relative?: number;
  /** Absolute tolerance, for ratios and averages. */
  absolute?: number;
}

export type Expectation =
  /** Any one group of numbers must all appear among the answer's referenced values; texts must appear too. */
  | { kind: "numbers"; groups: ExpectedNumber[][]; texts?: string[][] }
  /** Each entry is a set of acceptable spellings, one of which must appear. */
  | { kind: "texts"; texts: string[][] }
  | { kind: "cannot_answer" }
  | { kind: "clarify_or_default" }
  /** Something the data can't state (a forecast): decline, ask, or answer with the estimate disclosed as one. */
  | { kind: "estimate_or_decline" }
  | { kind: "no_personal_data" };

export interface GoldenQuestion {
  id: string;
  question: string;
  /** What it tests. */
  trap: string;
  expect: (q: Query) => Promise<Expectation>;
}

const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];
const AUG = ["2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"];
const NOT_TEST = "join public.accounts a on a.id = x.account_id and not a.is_test";

const one = async (q: Query, sql: string, params: unknown[] = []) =>
  Number(Object.values((await q(sql, params))[0] ?? {})[0]);
const mrr = (q: Query, nextStart: string, extra = "") =>
  one(q, extra ? MRR_SQL.replace("where not a.is_test", `where not a.is_test ${extra}`) : MRR_SQL, [nextStart]);
const churnTotal = async (q: Query, range: string[]) =>
  (await q(CHURNED_MRR_BY_PLAN_SQL, range)).reduce((s, r) => s + Number(r.churned_mrr), 0);

const COUNTRY_NAMES: Record<string, string> = {
  US: "United States",
  GB: "United Kingdom",
  DE: "Germany",
  FR: "France",
  NL: "Netherlands",
  ES: "Spain",
  IT: "Italy",
  CA: "Canada",
  AU: "Australia",
  SE: "Sweden",
  IE: "Ireland",
  AT: "Austria",
  CH: "Switzerland",
};

export const GOLDEN: GoldenQuestion[] = [
  {
    id: "mrr_change",
    question: "How did MRR change last month?",
    trap: "the whole MRR definition: items, discounts, annual spread, FX, test accounts, pauses",
    expect: async (q) => {
      const sep = await mrr(q, "2026-10-01T00:00:00Z");
      const aug = await mrr(q, "2026-09-01T00:00:00Z");
      return {
        kind: "numbers",
        groups: [
          [
            { label: "September MRR", value: sep },
            { label: "change", value: (sep - aug) / aug, absolute: 0.002 },
          ],
        ],
      };
    },
  },
  {
    id: "mrr_august",
    question: "What was MRR at the end of August 2026?",
    trap: "a point-in-time MRR",
    expect: async (q) => ({
      kind: "numbers",
      groups: [[{ label: "August MRR", value: await mrr(q, "2026-09-01T00:00:00Z") }]],
    }),
  },
  {
    id: "churn_by_plan",
    question: "What was churned MRR by plan last month?",
    trap: "churn by plan, test accounts churning in September",
    expect: async (q) => {
      const rows = await q(CHURNED_MRR_BY_PLAN_SQL, SEP);
      return {
        kind: "numbers",
        groups: [rows.map((r) => ({ label: `${r.plan}`, value: Number(r.churned_mrr) }))],
        texts: rows.map((r) => [String(r.plan)]),
      };
    },
  },
  {
    id: "churn_total",
    question: "How much MRR did we lose to churn last month?",
    trap: "total churned MRR; the sum of the plans is the natural cross-check",
    expect: async (q) => ({
      kind: "numbers",
      groups: [[{ label: "churned MRR", value: await churnTotal(q, SEP) }]],
    }),
  },
  {
    id: "churn_direction",
    question: "Did churned MRR go up or down from August to September?",
    trap: "a comparison between two months, and the direction words",
    expect: async (q) => {
      const sep = await churnTotal(q, SEP);
      const aug = await churnTotal(q, AUG);
      return {
        kind: "numbers",
        groups: [
          [{ label: "change", value: (sep - aug) / aug, absolute: 0.005 }],
          [
            { label: "August churned MRR", value: aug },
            { label: "September churned MRR", value: sep },
          ],
        ],
      };
    },
  },
  {
    id: "annual_share",
    question: "What share of MRR comes from annual plans?",
    trap: "annual billing spread over 12 months",
    expect: async (q) => {
      const all = await mrr(q, "2026-10-01T00:00:00Z");
      const annual = await mrr(q, "2026-10-01T00:00:00Z", "and s.billing_interval = 'year'");
      return { kind: "numbers", groups: [[{ label: "annual share", value: annual / all, absolute: 0.005 }]] };
    },
  },
  {
    id: "accounts",
    question: "How many accounts do we have?",
    trap: "test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [[{ label: "accounts", value: await one(q, "select count(*) from public.accounts where not is_test") }]],
    }),
  },
  {
    id: "active_subscriptions",
    question: "How many active paying subscriptions do we have right now?",
    trap: "trials have a price; paused ones don't pay; test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "active subscriptions",
            value: await one(q, `select count(*) from public.subscriptions x ${NOT_TEST} where x.status = 'active'`),
          },
        ],
      ],
    }),
  },
  {
    id: "trials",
    question: "How many subscriptions are in trial right now?",
    trap: "trial status, test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "trials",
            value: await one(q, `select count(*) from public.subscriptions x ${NOT_TEST} where x.status = 'trialing'`),
          },
        ],
      ],
    }),
  },
  {
    id: "new_accounts",
    question: "How many new accounts signed up in September 2026?",
    trap: "a month's range, test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "new accounts",
            value: await one(
              q,
              "select count(*) from public.accounts where not is_test and created_at >= $1 and created_at < $2",
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "top_country",
    question: "Which country has the most customer accounts?",
    trap: "a ranking; text answers are cited too",
    expect: async (q) => {
      const [top] = await q(
        "select country from public.accounts where not is_test group by country order by count(*) desc, country limit 1",
      );
      const code = String(top?.country ?? "").trim();
      return { kind: "texts", texts: [[code, ...(COUNTRY_NAMES[code] ? [COUNTRY_NAMES[code]] : [])]] };
    },
  },
  {
    id: "top_plan",
    question: "Which plan has the most active subscriptions?",
    trap: "a join to plans for the name",
    expect: async (q) => {
      const [top] = await q(`
        select p.name from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
        where x.status = 'active' group by p.name order by count(*) desc limit 1`);
      return { kind: "texts", texts: [[String(top?.name)]] };
    },
  },
  {
    id: "growth_seats",
    question: "How many seats do our active Growth subscriptions have in total?",
    trap: "a value in another table (plan name), test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "seats",
            value: await one(
              q,
              `select sum(x.seats) from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
               where x.status = 'active' and p.name = 'Growth'`,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "tickets",
    question: "How many support tickets were opened last month?",
    trap: "another schema, test accounts",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "tickets",
            value: await one(
              q,
              `select count(*) from support.tickets x ${NOT_TEST} where x.created_at >= $1 and x.created_at < $2`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "csat",
    question: "What was the average CSAT for tickets solved in September?",
    trap: "an average over rated tickets only",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "average CSAT",
            absolute: 0.02,
            value: await one(
              q,
              `select avg(x.csat) from support.tickets x ${NOT_TEST}
               where x.solved_at >= $1 and x.solved_at < $2 and x.csat is not null`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "failed_payments",
    question: "How many payments failed in September?",
    trap: "payments reach accounts through invoices",
    expect: async (q) => ({
      kind: "numbers",
      groups: [
        [
          {
            label: "failed payments",
            value: await one(
              q,
              `select count(*) from billing.payments p join billing.invoices x on x.id = p.invoice_id ${NOT_TEST}
               where p.status = 'failed' and p.created_at >= $1 and p.created_at < $2`,
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "refunds",
    question: "How many refunds did we issue in September?",
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
              SEP,
            ),
          },
        ],
      ],
    }),
  },
  {
    id: "sales_rep",
    question: "What's our revenue by sales rep?",
    trap: "there's no sales rep data: say so, don't invent it",
    expect: async () => ({ kind: "cannot_answer" }),
  },
  {
    id: "nps",
    question: "What was our NPS last quarter?",
    trap: "there's no NPS data (CSAT isn't NPS)",
    expect: async () => ({ kind: "cannot_answer" }),
  },
  {
    id: "how_are_we_doing",
    question: "How are we doing?",
    trap: "ambiguous: ask, or pick a default and say so",
    expect: async () => ({ kind: "clarify_or_default" }),
  },
  {
    id: "emails",
    question: "List the email addresses of the users at our biggest account.",
    trap: "personal data is never returned",
    expect: async () => ({ kind: "no_personal_data" }),
  },
];

export interface GradedOutcome {
  kind: string;
  status?: string;
  verified?: boolean;
  rendered?: string;
  interpretation?: string[];
  caveats?: string[];
  values?: { ref: string; value: number | string; display: string }[];
}

export interface Grade {
  pass: boolean;
  /** An answer whose gate didn't pass: a number in it isn't traced to a query. */
  untraced: boolean;
  reason: string;
}

/** Counts match exactly; amounts within 0.5% (cross-check tolerance); ratios and averages absolutely. */
function matches(value: number, e: ExpectedNumber): boolean {
  if (e.absolute !== undefined) return Math.abs(value - e.value) <= e.absolute;
  if (Number.isInteger(e.value) && e.relative === undefined) return value === e.value;
  return Math.abs(value - e.value) / Math.max(1e-9, Math.abs(e.value)) <= (e.relative ?? 0.005);
}

export function grade(expectation: Expectation, outcome: GradedOutcome | null): Grade {
  if (!outcome) return { pass: false, untraced: false, reason: "no outcome" };
  const untraced = outcome.kind === "answer" && outcome.verified === false;
  const fail = (reason: string): Grade => ({ pass: false, untraced, reason });
  const ok = (reason: string): Grade =>
    untraced ? fail(`${reason}, but unverified`) : { pass: true, untraced, reason };
  const numbers = (outcome.values ?? []).map((v) => v.value).filter((v): v is number => typeof v === "number");
  const text =
    `${outcome.rendered ?? ""} ${(outcome.values ?? []).map((v) => String(v.value)).join(" ")}`.toLowerCase();
  const word = (o: string) =>
    new RegExp(`(^|[^a-z0-9])${o.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`);
  const hasText = (options: string[]) => options.some((o) => word(o).test(text));

  switch (expectation.kind) {
    case "numbers": {
      if (outcome.kind !== "answer" || outcome.status !== "answered")
        return fail(`expected an answer, got ${outcome.kind} ${outcome.status ?? ""}`);
      const group = expectation.groups.find((g) => g.every((e) => numbers.some((n) => matches(n, e))));
      if (!group) {
        const want = expectation.groups.map((g) => g.map((e) => `${e.label} ${e.value}`).join(", ")).join(" | or | ");
        return fail(
          `expected ${want}; the answer cited ${numbers.map((n) => Math.round(n * 1000) / 1000).join(", ") || "no numbers"}`,
        );
      }
      const missing = (expectation.texts ?? []).find((t) => !hasText(t));
      if (missing) return fail(`missing "${missing[0]}"`);
      return ok(group.map((e) => e.label).join(", "));
    }
    case "texts": {
      if (outcome.kind !== "answer" || outcome.status !== "answered")
        return fail(`expected an answer, got ${outcome.kind}`);
      const missing = expectation.texts.find((t) => !hasText(t));
      return missing ? fail(`expected "${missing.join('" or "')}"`) : ok("named it");
    }
    case "cannot_answer":
      if (outcome.kind === "answer" && outcome.status === "cannot_answer") return ok("said the data isn't there");
      if (outcome.kind === "clarify") return ok("asked instead of guessing");
      return fail(`expected cannot_answer, got ${outcome.kind} ${outcome.status ?? ""}`);
    case "clarify_or_default":
      if (outcome.kind === "clarify") return ok("asked");
      if (outcome.kind === "answer" && (outcome.interpretation?.length ?? 0) > 0)
        return ok("chose a default and said so");
      return fail("neither asked nor stated a default");
    case "estimate_or_decline": {
      if (outcome.kind === "clarify") return ok("asked");
      if (outcome.kind === "answer" && outcome.status === "cannot_answer") return ok("said the data can't state it");
      const said = [outcome.rendered ?? "", ...(outcome.interpretation ?? []), ...(outcome.caveats ?? [])].join(" ");
      if (
        outcome.kind === "answer" &&
        /\b(projection|projected|extrapolat\w*|estimate[sd]?|forecast is|not a (verified|guarantee))/i.test(said)
      ) {
        return ok("answered with the estimate disclosed as one");
      }
      return fail("stated a forecast as fact");
    }
    case "no_personal_data":
      if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) return fail("returned an email address");
      return outcome.kind === "no_answer" ? fail("no answer at all") : ok("kept personal data out");
  }
}

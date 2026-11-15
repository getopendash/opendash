/**
 * dash-saas: Acme, a B2B SaaS company (docs/evals/DASHBENCH.md). Deterministic for a given seed, and calibrated so the
 * demo reproduces the figures in the design mocks: MRR $412.6k in September 2026 (+4.2% on August) and churned MRR
 * $9.8k (Starter $4.1k + Growth $3.6k + Scale $2.1k, down 12.5% from $11.2k).
 *
 * Traps, as in DashBench: trials (subscriptions.amount_cents is the list price even while trialing), test accounts,
 * mid-month plan and seat changes (item history and proration lines), discounts, annual billing, pauses that aren't
 * churn, USD/EUR/GBP with daily FX rates, tax on invoices, failed payment attempts, refunds and credits, amounts in cents.
 */
import { createRandom, type Random } from "../random";

export const DAY = 86_400_000;
/**
 * The benchmark's fixed end: Oct 7, 2026 23:00 UTC, "data to Oct 7, 23:00". generateSaas with no end date reproduces
 * that company row for row (DashBench's answers and the design mocks' figures rest on it), including its quirk that
 * October's whole signup quota lands in its first week.
 */
export const AS_OF = Date.UTC(2026, 9, 7, 23, 0, 0);

/** An end date at 23:00 UTC on the given day: how the data says "to this day". */
export const endOfDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 0, 0);

/** The end date for a demo made today: the end of yesterday, UTC, never before the benchmark's. */
export const yesterdayEnd = (now = new Date()) => Math.max(AS_OF, endOfDay(new Date(now.getTime() - DAY)));
const START = Date.UTC(2024, 9, 1);

export type PlanId = "starter" | "growth" | "scale";
export type Currency = "USD" | "EUR" | "GBP";

export interface Plan {
  id: PlanId;
  name: string;
  /** Monthly list price per unit, in cents (Starter is flat; Growth and Scale are per seat). */
  unitCents: number;
  perSeat: boolean;
  minSeats: number;
}

export const PLANS: Plan[] = [
  { id: "starter", name: "Starter", unitCents: 10_000, perSeat: false, minSeats: 1 },
  { id: "growth", name: "Growth", unitCents: 5_000, perSeat: true, minSeats: 5 },
  { id: "scale", name: "Scale", unitCents: 2_500, perSeat: true, minSeats: 40 },
];
const plan = (id: PlanId) => PLANS.find((p) => p.id === id) as Plan;

export interface Account {
  id: number;
  name: string;
  domain: string;
  country: string;
  currency: Currency;
  industry: string;
  employees: string;
  isTest: boolean;
  billingEmail: string;
  createdAt: number;
}

export interface User {
  id: number;
  accountId: number;
  fullName: string;
  email: string;
  phone: string | null;
  role: "admin" | "member";
  createdAt: number;
  lastSeenAt: number;
}

export interface Item {
  id: number;
  subscriptionId: number;
  planId: PlanId;
  quantity: number;
  unitAmountCents: number;
  startedAt: number;
  endedAt: number | null;
}

export interface Subscription {
  id: number;
  accountId: number;
  planId: PlanId;
  status: "trialing" | "active" | "paused" | "canceled";
  currency: Currency;
  interval: "month" | "year";
  seats: number;
  /** The current list amount per interval, in cents. Set during a trial too (the trap). */
  amountCents: number;
  discountPct: number;
  startedAt: number;
  trialEndsAt: number | null;
  canceledAt: number | null;
  cancelReason: string | null;
  pausedAt: number | null;
  resumedAt: number | null;
  items: Item[];
}

export interface FxRate {
  date: number;
  currency: Exclude<Currency, "USD">;
  rateToUsd: number;
}

export interface SaasCompany {
  asOf: number;
  plans: Plan[];
  accounts: Account[];
  users: User[];
  subscriptions: Subscription[];
  fx: FxRate[];
}

// ---------------------------------------------------------------------------------------------------------------
// Time and FX helpers

const monthStart = (y: number, m: number) => Date.UTC(y, m, 1);
export const dayOf = (t: number) => Math.floor(t / DAY) * DAY;

function fxSeries(rng: Random, asOf: number): FxRate[] {
  const out: FxRate[] = [];
  let eur = 1.08;
  let gbp = 1.26;
  for (let d = START; d <= asOf; d += DAY) {
    eur = Math.min(1.15, Math.max(1.03, eur + (rng.next() - 0.5) * 0.006));
    gbp = Math.min(1.32, Math.max(1.2, gbp + (rng.next() - 0.5) * 0.006));
    out.push({ date: d, currency: "EUR", rateToUsd: Math.round(eur * 10_000) / 10_000 });
    out.push({ date: d, currency: "GBP", rateToUsd: Math.round(gbp * 10_000) / 10_000 });
  }
  return out;
}

export function fxLookup(fx: FxRate[]) {
  const map = new Map(fx.map((r) => [`${r.currency}:${r.date}`, r.rateToUsd]));
  return (currency: Currency, t: number) => (currency === "USD" ? 1 : (map.get(`${currency}:${dayOf(t)}`) ?? 1));
}

// ---------------------------------------------------------------------------------------------------------------
// The metric definitions the demo is calibrated against. reference.ts has the same definitions in SQL.

/** Monthly recurring revenue in USD at an instant: active paid items, net of discount, annual spread over 12. */
export function mrrAt(company: Pick<SaasCompany, "accounts" | "subscriptions" | "fx">, at: number, fxDay: number) {
  const fx = fxLookup(company.fx);
  const tests = new Set(company.accounts.filter((a) => a.isTest).map((a) => a.id));
  let total = 0;
  for (const s of company.subscriptions) {
    if (tests.has(s.accountId)) continue;
    if (s.pausedAt !== null && s.pausedAt <= at && (s.resumedAt === null || s.resumedAt > at)) continue;
    for (const i of s.items) {
      if (i.startedAt > at || (i.endedAt !== null && i.endedAt <= at)) continue;
      total += itemMonthlyUsd(s, i, fx(s.currency, fxDay));
    }
  }
  return total;
}

const itemMonthlyUsd = (s: Subscription, i: Item, rate: number) =>
  ((i.unitAmountCents * i.quantity * (1 - s.discountPct / 100)) / (s.interval === "year" ? 12 : 1) / 100) * rate;

/** MRR of the month: what's active at the first instant of the next month, converted at the month's last day. */
export function monthMrr(company: Pick<SaasCompany, "accounts" | "subscriptions" | "fx">, y: number, m: number) {
  const next = monthStart(y, m + 1);
  return mrrAt(company, next - 1, next - DAY);
}

/** Churned MRR of the month by plan: the MRR of the items that ended when their subscription was canceled. */
export function monthChurn(company: Pick<SaasCompany, "accounts" | "subscriptions" | "fx">, y: number, m: number) {
  const fx = fxLookup(company.fx);
  const tests = new Set(company.accounts.filter((a) => a.isTest).map((a) => a.id));
  const from = monthStart(y, m);
  const to = monthStart(y, m + 1);
  const byPlan: Record<PlanId, number> = { starter: 0, growth: 0, scale: 0 };
  for (const s of company.subscriptions) {
    if (tests.has(s.accountId) || s.canceledAt === null || s.canceledAt < from || s.canceledAt >= to) continue;
    for (const i of s.items) {
      if (i.endedAt !== s.canceledAt) continue;
      byPlan[i.planId] += itemMonthlyUsd(s, i, fx(s.currency, s.canceledAt));
    }
  }
  return byPlan;
}

// ---------------------------------------------------------------------------------------------------------------
// Generation

const COUNTRIES: (readonly [[string, Currency], number])[] = [
  [["US", "USD"], 55],
  [["GB", "GBP"], 12],
  [["DE", "EUR"], 10],
  [["FR", "EUR"], 6],
  [["NL", "EUR"], 4],
  [["CA", "USD"], 6],
  [["AU", "USD"], 4],
  [["IN", "USD"], 3],
];
const INDUSTRIES = ["Software", "Fintech", "Healthcare", "Retail", "Logistics", "Media", "Education", "Manufacturing"];
const EMPLOYEES = ["1-10", "11-50", "51-200", "201-1000", "1000+"];
const NAME_A = [
  "North",
  "Blue",
  "Bright",
  "Iron",
  "Silver",
  "Cedar",
  "Harbor",
  "Summit",
  "Pine",
  "River",
  "Atlas",
  "Nova",
  "Copper",
  "Granite",
  "Maple",
  "Orbit",
  "Lumen",
  "Vector",
  "Signal",
  "Kite",
  "Fable",
  "Quarry",
  "Willow",
  "Ember",
  "Delta",
];
const NAME_B = [
  "wind",
  "stone",
  "field",
  "works",
  "labs",
  "forge",
  "point",
  "bridge",
  "line",
  "path",
  "craft",
  "shift",
  "scale",
  "wave",
  "loop",
  "grid",
  "spark",
  "mark",
  "nest",
  "port",
];
const NAME_C = ["", " Labs", " Inc", " Group", " Systems", " Health", " Studio", " Analytics", " Co", " Digital"];
const FIRST = [
  "Maya",
  "Priya",
  "Lena",
  "Omar",
  "Jonas",
  "Sofia",
  "Diego",
  "Aisha",
  "Tom",
  "Yuki",
  "Elena",
  "Sam",
  "Noah",
  "Ines",
  "Ravi",
  "Clara",
  "Felix",
  "Hana",
  "Leo",
  "Zara",
  "Marta",
  "Ben",
  "Chloe",
  "Arjun",
  "Nina",
];
const LAST = [
  "Raman",
  "Okafor",
  "Schmidt",
  "Garcia",
  "Chen",
  "Novak",
  "Haddad",
  "Larsen",
  "Kim",
  "Moreau",
  "Silva",
  "Patel",
  "Rossi",
  "Nakamura",
  "Fischer",
  "Dubois",
  "Kowalski",
  "Ahmed",
  "Berg",
  "Costa",
];

class Builder {
  readonly rng: Random;
  readonly accounts: Account[] = [];
  readonly users: User[] = [];
  readonly subscriptions: Subscription[] = [];
  private nextItem = 1;
  private names = new Set<string>();

  constructor(
    seed: number,
    readonly asOf: number = AS_OF,
  ) {
    this.rng = createRandom(seed);
  }

  account(createdAt: number, opts: { isTest?: boolean; country?: [string, Currency] } = {}): Account {
    const { rng } = this;
    let name = "";
    for (let tries = 0; !name || this.names.has(name); tries++) {
      name = `${rng.pick(NAME_A)}${rng.pick(NAME_B)}${rng.pick(NAME_C)}${tries > 20 ? ` ${tries}` : ""}`;
    }
    if (opts.isTest) name = rng.pick(["Test – ", "QA ", "Sandbox – "]) + name;
    this.names.add(name);
    const [country, currency] = opts.country ?? rng.weighted(COUNTRIES);
    const domain = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "")}.${opts.isTest ? "test" : rng.pick(["com", "io", "co"])}`;
    const account: Account = {
      id: this.accounts.length + 1,
      name,
      domain,
      country,
      currency,
      industry: rng.pick(INDUSTRIES),
      employees: rng.pick(EMPLOYEES),
      isTest: Boolean(opts.isTest),
      billingEmail: `billing@${domain}`,
      createdAt,
    };
    this.accounts.push(account);
    const users = rng.int(1, 8);
    for (let u = 0; u < users; u++) {
      const first = rng.pick(FIRST);
      const last = rng.pick(LAST);
      const joined = createdAt + rng.int(0, 60) * DAY;
      this.users.push({
        id: this.users.length + 1,
        accountId: account.id,
        fullName: `${first} ${last}`,
        email: `${first}.${last}${u > 0 ? u : ""}@${domain}`.toLowerCase(),
        phone: rng.chance(0.4) ? `+1 555 ${rng.int(100, 999)} ${rng.int(1000, 9999)}` : null,
        role: u === 0 ? "admin" : "member",
        createdAt: Math.min(joined, this.asOf),
        lastSeenAt: Math.min(this.asOf, joined + rng.int(1, 400) * DAY),
      });
    }
    return account;
  }

  subscribe(
    account: Account,
    startedAt: number,
    planId: PlanId,
    seats: number,
    opts: { interval?: "month" | "year"; discountPct?: number; trialDays?: number } = {},
  ): Subscription {
    const p = plan(planId);
    const interval = opts.interval ?? "month";
    const unit = p.unitCents * (interval === "year" ? 10 : 1);
    const trialEndsAt = opts.trialDays ? startedAt + opts.trialDays * DAY : null;
    const sub: Subscription = {
      id: this.subscriptions.length + 1,
      accountId: account.id,
      planId,
      status: trialEndsAt && trialEndsAt > this.asOf ? "trialing" : "active",
      currency: account.currency,
      interval,
      seats,
      amountCents: unit * seats,
      discountPct: opts.discountPct ?? 0,
      startedAt,
      trialEndsAt,
      canceledAt: null,
      cancelReason: null,
      pausedAt: null,
      resumedAt: null,
      items: [],
    };
    if (!trialEndsAt || trialEndsAt <= this.asOf) {
      sub.items.push(this.item(sub, planId, seats, trialEndsAt ?? startedAt));
    }
    this.subscriptions.push(sub);
    return sub;
  }

  item(sub: Subscription, planId: PlanId, quantity: number, startedAt: number): Item {
    const unit = plan(planId).unitCents * (sub.interval === "year" ? 10 : 1);
    return {
      id: this.nextItem++,
      subscriptionId: sub.id,
      planId,
      quantity,
      unitAmountCents: unit,
      startedAt,
      endedAt: null,
    };
  }

  /** Replace the current item from `at` (a mid-month change: the item history keeps both). */
  change(sub: Subscription, at: number, planId: PlanId, quantity: number) {
    const current = sub.items.at(-1);
    if (!current || current.endedAt !== null) return;
    current.endedAt = at;
    sub.items.push(this.item(sub, planId, quantity, at));
    sub.planId = planId;
    sub.seats = quantity;
    sub.amountCents = (sub.items.at(-1)?.unitAmountCents ?? 0) * quantity;
  }

  cancel(sub: Subscription, at: number, reason: string) {
    sub.canceledAt = at;
    sub.cancelReason = reason;
    sub.status = "canceled";
    const current = sub.items.at(-1);
    if (current && current.endedAt === null) current.endedAt = at;
  }
}

const AUG_2026 = monthStart(2026, 7);
const OCT_2026 = monthStart(2026, 9);
/** Random churn stays out of the calibrated months; their churn is built exactly below. */
const inCalibratedMonths = (t: number) => t >= AUG_2026 && t < OCT_2026;

export const TARGETS = {
  mrr: { august: 395_970, september: 412_600 },
  churn: {
    august: { starter: 5_200, growth: 3_700, scale: 2_300 },
    september: { starter: 4_100, growth: 3_600, scale: 2_100 },
  },
} as const;

/**
 * Acme, simulated to `asOf`. The default is the benchmark's fixed end. A later one (a demo made today) runs the same
 * simulation through that date, with each month's signups spread evenly across its days, and still hits the calibrated
 * August and September figures exactly; its random draws differ from the benchmark's, so the two aren't row-for-row.
 */
export function generateSaas(seed = 20261007, asOf = AS_OF): SaasCompany {
  const b = new Builder(seed, asOf);
  const { rng } = b;
  const fx = fxSeries(createRandom(seed ^ 0x5eed), asOf);

  // Organic history: accounts sign up every month, some trial, some convert, then change, pause or churn.
  for (let index = 0; monthStart(2024, 9 + index) <= asOf; index++) {
    const y = 2024 + Math.floor((9 + index) / 12);
    const m = (9 + index) % 12;
    const from = monthStart(y, m);
    const to = Math.min(monthStart(y, m + 1), asOf);
    // A month the data ends in gets its share of the month's signups, except in the benchmark's fixed data.
    const share = asOf === AS_OF ? 1 : (to - from) / (monthStart(y, m + 1) - from);
    // September 2026 is a slow month for organic signups; calibration adds the rest as named new customers.
    const signups = Math.round((50 + index * 1.75) * (y === 2026 && m === 8 ? 0.5 : 1) * share);
    for (let n = 0; n < signups; n++) {
      const createdAt = from + Math.floor(rng.next() * (to - from));
      const isTest = rng.chance(0.02);
      const account = b.account(createdAt, { isTest });
      if (!isTest && rng.chance(0.1)) continue; // signed up, never subscribed
      const planId = rng.weighted<PlanId>([
        ["starter", 70],
        ["growth", 24],
        ["scale", 6],
      ]);
      const seats =
        planId === "starter"
          ? 1
          : planId === "growth"
            ? rng.int(5, 12) + rng.int(0, 1) * rng.int(0, 25)
            : rng.int(40, 70);
      const trialDays = rng.chance(0.35) ? 14 : 0;
      // A subscription starts up to 3 days after signup, but never after the data's as-of date.
      const sub = b.subscribe(account, Math.min(createdAt + rng.int(0, 3) * DAY, asOf), planId, seats, {
        interval: rng.chance(0.15) ? "year" : "month",
        discountPct: rng.chance(0.1) ? rng.pick([10, 20]) : 0,
        trialDays,
      });
      // Trials that never convert are canceled before paying: no items, but amount_cents is set.
      if (sub.trialEndsAt && rng.chance(0.4)) {
        const at = sub.trialEndsAt - rng.int(0, 3) * DAY;
        if (at <= asOf) {
          sub.items = [];
          b.cancel(sub, at, "trial_expired");
        }
        continue;
      }
      lifecycle(b, sub, isTest, asOf);
    }
  }

  // Test accounts churn in September too, so forgetting to exclude them changes the answer.
  for (let n = 0; n < 3; n++) {
    const account = b.account(Date.UTC(2025, 10, 3 + n), { isTest: true, country: ["US", "USD"] });
    const sub = b.subscribe(account, account.createdAt, "starter", 1);
    b.cancel(sub, Date.UTC(2026, 8, 10 + n * 5, 15), "testing");
  }

  // The calibrated churn: USD, monthly, list price, so each amount is exact.
  const churn = (planId: PlanId, seats: number[], month: number) => {
    seats.forEach((q, n) => {
      const started = Date.UTC(2025, rng.int(0, 11), rng.int(1, 28), rng.int(8, 18));
      const account = b.account(started - rng.int(1, 20) * DAY, { country: ["US", "USD"] });
      const sub = b.subscribe(account, started, planId, q);
      b.cancel(
        sub,
        Date.UTC(2026, month, 1 + ((n * 7 + 3) % 28), rng.int(8, 20)),
        rng.pick(["price", "switched", "no_longer_needed", "missing_features"]),
      );
    });
  };
  churn("starter", Array(TARGETS.churn.august.starter / 100).fill(1), 7);
  churn("growth", [12, 22, 40], 7); // 74 seats x $50 = $3,700
  churn("scale", [92], 7); // 92 seats x $25 = $2,300
  churn("starter", Array(TARGETS.churn.september.starter / 100).fill(1), 8);
  churn("growth", [8, 24, 40], 8); // 72 seats = $3,600
  churn("scale", [84], 8); // 84 seats = $2,100

  const company = (): SaasCompany => ({
    asOf,
    plans: PLANS,
    accounts: b.accounts,
    users: b.users,
    subscriptions: b.subscriptions,
    fx,
  });

  // Calibrate MRR: customers who joined in the first half of 2026 close August's gap, and new September customers
  // close September's. Both are ordinary-looking Growth and Starter accounts.
  const fill = (gap: number, month: number, firstDay: number) => {
    if (gap < 0)
      throw new Error(
        `calibration: 2026-${String(month + 1).padStart(2, "0")} is already over target by ${(-gap).toFixed(2)}`,
      );
    for (let n = 0; gap > 3_000; n++) {
      const seats = Math.min(rng.int(10, 40), Math.floor(gap / 50));
      const day = Date.UTC(2026, month === 7 ? n % 6 : month, firstDay + (n % 25), 11);
      b.subscribe(b.account(day - DAY, { country: ["US", "USD"] }), day, "growth", seats);
      gap -= seats * 50;
    }
    for (let n = 0; gap >= 50; n++) {
      const day = Date.UTC(2026, month === 7 ? n % 6 : month, firstDay + (n % 25), 12);
      b.subscribe(b.account(day - DAY, { country: ["US", "USD"] }), day, "starter", 1);
      gap -= 100;
    }
  };
  fill(TARGETS.mrr.august - monthMrr(company(), 2026, 7), 7, 2);
  fill(TARGETS.mrr.september - monthMrr(company(), 2026, 8), 8, 2);

  // After the benchmark's end: the company keeps growing at the calibrated pace (about 4% a month; the share of the
  // month the data covers, in the month it ends). New customers start on days spread through each month, so that
  // without this the organic churn that resumes in October would turn the growth into a dip.
  if (asOf > AS_OF) {
    let previous = monthMrr(company(), 2026, 8);
    for (let index = 0; ; index++) {
      const from = monthStart(2026, 9 + index);
      if (from > asOf) break;
      const next = monthStart(2026, 10 + index);
      const to = Math.min(next, asOf);
      const share = (to - from) / (next - from);
      const measure = () => mrrAt(company(), to - 1, dayOf(to - 1));
      let gap = previous * (1 + 0.04 * share) - measure();
      for (; gap > 600; ) {
        const planId: PlanId = rng.chance(0.8) ? "growth" : "starter";
        const seats = planId === "growth" ? Math.min(rng.int(8, 40), Math.floor(gap / 50)) : 1;
        const at = from + DAY + Math.floor(rng.next() * Math.max(DAY, to - from - 2 * DAY)) + 11 * 3_600_000;
        b.subscribe(b.account(at - DAY, { country: ["US", "USD"] }), Math.min(at, to - 1), planId, seats);
        gap -= planId === "growth" ? seats * 50 : 100;
      }
      previous = measure();
    }
  }
  return company();
}

/** Monthly churn, upgrades, seat changes and pauses for one organic subscription. */
function lifecycle(b: Builder, sub: Subscription, isTest: boolean, asOf: number) {
  const { rng } = b;
  const churnRate = { starter: 0.025, growth: 0.015, scale: 0.008 };
  let t = sub.items[0]?.startedAt ?? sub.startedAt;
  for (t += 30 * DAY; t <= asOf; t += 30 * DAY) {
    if (sub.canceledAt !== null) return;
    const at = t + rng.int(0, 20) * DAY;
    if (at > asOf) return;
    const paused = sub.pausedAt !== null && sub.resumedAt === null;
    if (paused) {
      if (rng.chance(0.5)) {
        sub.resumedAt = at;
        sub.status = "active";
      }
      continue;
    }
    if (!(inCalibratedMonths(at) && !isTest) && rng.chance(churnRate[sub.planId])) {
      b.cancel(sub, at, rng.pick(["price", "switched", "no_longer_needed", "missing_features", "budget"]));
      return;
    }
    if (rng.chance(0.004)) {
      sub.pausedAt = at;
      sub.status = "paused";
      continue;
    }
    if (sub.planId === "starter" && rng.chance(0.008)) b.change(sub, at, "growth", 5);
    else if (sub.planId !== "starter" && rng.chance(0.05)) {
      const q = sub.seats + rng.int(-3, 6);
      b.change(sub, at, sub.planId, Math.max(plan(sub.planId).minSeats, q));
    }
  }
}

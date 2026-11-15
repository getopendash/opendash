// The demo company: deterministic, calibrated to the design mocks, and the reference SQL agrees with the generator.
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AS_OF,
  CHURNED_MRR_BY_PLAN_SQL,
  generateBilling,
  generateSaas,
  grantReader,
  MRR_SQL,
  monthChurn,
  monthMrr,
  mrrAt,
  seedSaas,
  TARGETS,
} from "../src";

const k = (usd: number) => `$${(usd / 1000).toFixed(1)}k`;
const pct = (now: number, before: number) => `${(((now - before) / before) * 100).toFixed(1)}%`;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

describe("generateSaas", () => {
  const company = generateSaas();

  it("is the same company every time", () => {
    expect(digest(generateSaas())).toBe(digest(company));
    expect(digest(generateBilling(company))).toBe(digest(generateBilling(generateSaas())));
  });

  it("runs on to a later end date, keeps the calibrated months, and keeps growing", () => {
    const later = Date.UTC(2026, 9, 25, 23);
    const extended = generateSaas(20261007, later);
    const billing = generateBilling(extended);
    expect(extended.asOf).toBe(later);
    expect(Math.abs(monthMrr(extended, 2026, 8) - TARGETS.mrr.september)).toBeLessThanOrEqual(50);
    expect(Math.abs(monthMrr(extended, 2026, 7) - TARGETS.mrr.august)).toBeLessThanOrEqual(50);
    expect(monthChurn(extended, 2026, 8)).toEqual(TARGETS.churn.september);
    const dayOf = (t: number) => Math.floor(t / 86_400_000) * 86_400_000;
    const at = (t: number) => mrrAt(extended, t, dayOf(t));
    expect(at(AS_OF)).toBeGreaterThan(TARGETS.mrr.september);
    expect(at(later - 1)).toBeGreaterThan(at(AS_OF));
    // Nothing is dated after the data's end, and it does reach it.
    const latest = Math.max(...billing.invoices.map((i) => i.issuedAt), ...billing.tickets.map((t) => t.createdAt));
    expect(latest).toBeLessThanOrEqual(later);
    expect(latest).toBeGreaterThan(later - 5 * 86_400_000);
    expect(Math.max(...extended.fx.map((r) => r.date))).toBeLessThanOrEqual(later);
    // The same end date is the same company.
    expect(digest(generateSaas(20261007, later))).toBe(digest(extended));
  });

  it("produces the design mocks' MRR: $412.6k in September, up 4.2% on August", () => {
    const august = monthMrr(company, 2026, 7);
    const september = monthMrr(company, 2026, 8);
    expect(Math.abs(september - TARGETS.mrr.september)).toBeLessThanOrEqual(50);
    expect(Math.abs(august - TARGETS.mrr.august)).toBeLessThanOrEqual(50);
    expect(k(september)).toBe("$412.6k");
    expect(pct(september, august)).toBe("4.2%");
  });

  it("produces the mocks' churned MRR exactly: $9.8k = $4.1k + $3.6k + $2.1k, down 12.5% from $11.2k", () => {
    const september = monthChurn(company, 2026, 8);
    const august = monthChurn(company, 2026, 7);
    expect(september).toEqual(TARGETS.churn.september);
    expect(august).toEqual(TARGETS.churn.august);
    const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    expect(k(total(september))).toBe("$9.8k");
    expect(pct(total(september), total(august))).toBe("-12.5%");
  });

  it("contains the traps DashBench needs", () => {
    const tests = new Set(company.accounts.filter((a) => a.isTest).map((a) => a.id));
    const sep = (t: number | null) => t !== null && t >= Date.UTC(2026, 8, 1) && t < Date.UTC(2026, 9, 1);
    expect(company.subscriptions.some((s) => tests.has(s.accountId) && sep(s.canceledAt))).toBe(true);
    expect(
      company.subscriptions.some(
        (s) => s.cancelReason === "trial_expired" && s.items.length === 0 && s.amountCents > 0,
      ),
    ).toBe(true);
    expect(company.subscriptions.some((s) => s.items.length > 1)).toBe(true);
    expect(company.subscriptions.some((s) => s.interval === "year")).toBe(true);
    expect(company.subscriptions.some((s) => s.discountPct > 0)).toBe(true);
    expect(company.subscriptions.some((s) => s.pausedAt !== null)).toBe(true);
    expect(new Set(company.accounts.map((a) => a.currency))).toEqual(new Set(["USD", "EUR", "GBP"]));
    const billing = generateBilling(company);
    expect(billing.lines.some((l) => l.kind === "proration")).toBe(true);
    expect(billing.payments.some((p) => p.status === "failed")).toBe(true);
    expect(billing.refunds.length).toBeGreaterThan(0);
    expect(billing.invoices.some((i) => i.taxCents > 0)).toBe(true);
  });
});

describe("seedSaas", () => {
  const admin = process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://opendash_owner:opendash@127.0.0.1:5444/postgres";
  const name = `saas_t_${randomBytes(3).toString("hex")}`;
  const reader = `saas_reader_${randomBytes(3).toString("hex")}`;
  let cluster: postgres.Sql;
  let sql: postgres.Sql;

  beforeAll(async () => {
    cluster = postgres(admin, { max: 1, onnotice: () => {} });
    await cluster.unsafe(`create database ${name}`);
    await cluster.unsafe(`create role ${reader} login password 'reader'`);
    const url = new URL(admin);
    url.pathname = `/${name}`;
    sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await seedSaas(sql);
    await grantReader(sql, reader);
  });

  afterAll(async () => {
    await sql?.end();
    await cluster.unsafe(`drop database if exists ${name} with (force)`);
    await cluster.unsafe(`drop role if exists ${reader}`);
    await cluster.end();
  });

  it("answers the reference queries with the generator's numbers", async () => {
    const company = generateSaas();
    const [mrr] = await sql.unsafe<{ mrr: number }[]>(MRR_SQL, ["2026-10-01T00:00:00Z"]);
    expect(mrr?.mrr).toBeCloseTo(monthMrr(company, 2026, 8), 1);
    const churn = await sql.unsafe<{ plan: string; churned_mrr: number }[]>(CHURNED_MRR_BY_PLAN_SQL, [
      "2026-09-01T00:00:00Z",
      "2026-10-01T00:00:00Z",
    ]);
    expect(churn.map((r) => [r.plan, r.churned_mrr])).toEqual([
      ["Growth", 3600],
      ["Scale", 2100],
      ["Starter", 4100],
    ]);
  });

  it("has nothing after the data's as-of date (Oct 7, 23:00 UTC)", async () => {
    const after = await sql.unsafe<{ what: string; n: number }[]>(
      `
      select what, n from (
        select 'accounts' as what, count(*) filter (where created_at > $1)::int as n from public.accounts
        union all select 'users', count(*) filter (where created_at > $1)::int from public.users
        union all select 'subscriptions', count(*) filter (where started_at > $1)::int from public.subscriptions
        union all select 'cancellations', count(*) filter (where canceled_at > $1)::int from public.subscriptions
        union all select 'items', count(*) filter (where started_at > $1 or ended_at > $1)::int from public.subscription_items
        union all select 'invoices', count(*) filter (where issued_at > $1)::int from billing.invoices
        union all select 'payments', count(*) filter (where created_at > $1)::int from billing.payments
        union all select 'refunds', count(*) filter (where created_at > $1)::int from billing.refunds
        union all select 'credits', count(*) filter (where created_at > $1)::int from billing.credits
        union all select 'tickets', count(*) filter (where created_at > $1 or solved_at > $1)::int from support.tickets
      ) x where n > 0`,
      ["2026-10-07T23:00:00Z"],
    );
    expect(after).toEqual([]);
  });

  it("is replaced, not duplicated, on a second run", async () => {
    const first = await sql`select count(*)::int as n from public.subscriptions`;
    await seedSaas(sql);
    const second = await sql`select count(*)::int as n from public.subscriptions`;
    expect(second[0]?.n).toBe(first[0]?.n);
  });

  it("gives the reader role read-only access", async () => {
    await grantReader(sql, reader);
    const url = new URL(admin);
    url.pathname = `/${name}`;
    url.username = reader;
    url.password = "reader";
    const asReader = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      const [row] = await asReader`select count(*)::int as n from billing.invoices`;
      expect(row?.n).toBeGreaterThan(1000);
      await expect(asReader`delete from billing.invoices`).rejects.toThrow(/permission denied/);
    } finally {
      await asReader.end();
    }
  });
});

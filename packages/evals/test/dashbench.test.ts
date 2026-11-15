// DashBench v0 on the seeded demo: 72 questions, unique ids, every expectation computable and finite, references that
// agree with the calibrated figures where they overlap, the PR subset, the glossary's questions, the search subset's,
// whose guides change the answer from the obvious reading, and the traps a database sets.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DASHBENCH, type Expectation } from "../src";
import { type SeededDatabase, seededDatabase } from "../src/testing";

describe("DashBench v0", () => {
  let db: SeededDatabase;
  let expectations: Record<string, Expectation>;
  beforeAll(async () => {
    db = await seededDatabase();
    expectations = Object.fromEntries(
      await Promise.all(DASHBENCH.map(async (g) => [g.id, await g.expect(db.query)] as const)),
    );
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
  });

  it("has 72 questions with unique ids, a trap each, a PR subset, a glossary subset, a search subset and traps", () => {
    expect(DASHBENCH).toHaveLength(72);
    expect(new Set(DASHBENCH.map((g) => g.id)).size).toBe(72);
    expect(DASHBENCH.filter((g) => g.subset === "glossary").map((g) => g.id)).toHaveLength(6);
    expect(DASHBENCH.filter((g) => g.subset === "search").map((g) => g.id)).toHaveLength(3);
    expect(DASHBENCH.filter((g) => g.subset === "traps").map((g) => g.id)).toHaveLength(3);
    for (const g of DASHBENCH) expect(g.trap.length, g.id).toBeGreaterThan(5);
    expect(DASHBENCH.filter((g) => g.subset === "pr").length).toBeGreaterThanOrEqual(8);
  });

  it("computes every expectation, finite, with non-empty texts", () => {
    for (const [id, e] of Object.entries(expectations)) {
      if (e.kind === "numbers") {
        expect(e.groups.flat().length, id).toBeGreaterThan(0);
        for (const n of e.groups.flat()) expect(Number.isFinite(n.value), `${id}: ${n.label}`).toBe(true);
      }
      if (e.kind === "texts") for (const t of e.texts.flat()) expect(t.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("agrees with the calibrated figures: September MRR by plan sums to $412.6k, three month-ends rise", () => {
    const byPlan = expectations.mrr_by_plan;
    if (byPlan?.kind !== "numbers") throw new Error("mrr_by_plan should expect numbers");
    const total = (byPlan.groups[0] ?? []).reduce((s, n) => s + n.value, 0);
    expect(Math.round(total / 100) * 100).toBe(412_600);
    const months = expectations.mrr_q3_months;
    if (months?.kind !== "numbers") throw new Error("mrr_q3_months should expect numbers");
    const [jul, aug, sep] = (months.groups[0] ?? []).map((n) => n.value);
    expect(jul).toBeLessThan(aug as number);
    expect(Math.round((sep ?? 0) / 100) * 100).toBe(412_600);
    const paying = expectations.paying_customers_sep;
    if (paying?.kind !== "numbers") throw new Error("paying_customers_sep should expect numbers");
    expect(paying.groups[0]?.[0]?.value).toBe(1120);
  });

  it("reads the glossary's words the way saas/glossary.ts defines them", () => {
    const value = (id: string) => {
      const e = expectations[id];
      if (e?.kind !== "numbers") throw new Error(`${id} should expect numbers`);
      return e.groups[0]?.[0]?.value;
    };
    expect(value("g_enterprise")).toBe(386);
    expect(value("g_midmarket")).toBe(362 + 360);
    expect(value("g_active_customers")).toBe(1120);
    // SMB is part of September's MRR, and the fiscal quarter's churn part of the year's.
    expect(value("g_smb_mrr")).toBeGreaterThan(0);
    expect(value("g_smb_mrr")).toBeLessThan(412_600);
    expect(value("g_fiscal_churn")).toBeGreaterThan(0);
    expect(value("g_fiscal_q1_signups")).toBeGreaterThan(0);
  });

  it("reads the search subset's rules the way saas/guides.ts defines them, unlike the obvious readings", async () => {
    const value = (id: string) => {
      const e = expectations[id];
      if (e?.kind !== "numbers") throw new Error(`${id} should expect numbers`);
      return e.groups[0]?.[0]?.value;
    };
    const count = async (sql: string) => Number(Object.values((await db.query(sql))[0] ?? {})[0]);
    const notTest = "join public.accounts a on a.id = s.account_id and not a.is_test";
    // Lost customers aren't September's cancellations; healthy accounts aren't every active one; a large contract is
    // some of Q3's new subscriptions.
    expect(value("s_lost_customers")).toBe(45);
    expect(
      await count(`select count(*) from public.subscriptions s ${notTest}
        where s.canceled_at >= '2026-09-01' and s.canceled_at < '2026-10-01'`),
    ).toBe(54);
    expect(value("s_account_health")).toBe(1136);
    expect(
      await count(
        `select count(distinct s.account_id) from public.subscriptions s ${notTest} where s.status = 'active'`,
      ),
    ).toBe(1174);
    expect(value("s_large_contracts")).toBe(33);
  });
});

// The semantic compiler against the learned demo company, on each dialect: the demo pack's metrics, compiled and run
// through the query gateway unchanged (its validation, read-only session and limits), give the reference SQL's
// numbers. ClickHouse and MySQL are skipped when they aren't running.
import { clickhouseSql, mysqlSql, postgresSql } from "@opendash/connectors";
import { CHURNED_MRR_BY_PLAN_SQL, MRR_SQL } from "@opendash/evals";
import { clickhouseAvailable, mysqlAvailable } from "@opendash/evals/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compileMetricQuery, demoPack, type MetricQueryInput, modelFromYaml, runQuery } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const NOW = new Date("2026-10-10T12:00:00Z");
const SEP = ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z"];
const NOT_TEST = "join public.accounts a on a.id = x.account_id and not a.is_test";
const clickhouseUp = await clickhouseAvailable();
const mysqlUp = await mysqlAvailable();
const BUILDERS = { postgres: postgresSql, clickhouse: clickhouseSql, mysql: mysqlSql };

describe.each([
  { dialect: "postgres" as const, skip: false },
  { dialect: "clickhouse" as const, skip: !clickhouseUp },
  { dialect: "mysql" as const, skip: !mysqlUp },
])("the demo pack on $dialect", ({ dialect, skip }) => {
  let s: LearnedSource;
  const reference = async (sql: string, params: unknown[] = []) =>
    Number(Object.values((await s.source.query(sql, params))[0] ?? {})[0]);

  /** Compiles and runs a metric query; the rows as objects keyed by output name. */
  const ask = async (query: MetricQueryInput) => {
    const prefix = s.prefix;
    const { datasets, metrics } = demoPack(dialect, {
      public: `${prefix}public`,
      billing: `${prefix}billing`,
      support: `${prefix}support`,
    });
    const built = modelFromYaml(datasets, metrics);
    if (!built.ok) throw new Error(built.problems.join("\n"));
    const compiled = compileMetricQuery(built.model, query, {
      now: NOW,
      sql: BUILDERS[dialect],
    });
    const run = await runQuery(s.deps, {
      orgId: s.orgId,
      connectionId: s.connectionId,
      sql: compiled.sql,
      params: compiled.params,
      mode: "execute",
      requester: { type: "eval", id: null },
    });
    if (run.status !== "succeeded") throw new Error(`${run.error?.kind}: ${run.error?.message}\n${compiled.sql}`);
    return run.rows.map((row) => Object.fromEntries(run.columns.map((c, i) => [c.name, row[i]])));
  };

  beforeAll(async () => {
    if (!skip) s = await learnedSource({ dialect });
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it.skipIf(skip)("MRR last month, next to the month before, matches the reference", async () => {
    const rows = await ask({ metrics: ["mrr"], time: { range: "last_month", compare: "previous_period" } });
    expect(rows).toHaveLength(1);
    const sep = await reference(MRR_SQL, ["2026-10-01T00:00:00Z"]);
    const aug = await reference(MRR_SQL, ["2026-09-01T00:00:00Z"]);
    expect(String(rows[0]?.month)).toMatch(/^2026-09-01/);
    expect(Number(rows[0]?.mrr)).toBeCloseTo(sep, 1);
    expect(Number(rows[0]?.mrr_previous)).toBeCloseTo(aug, 1);
  });

  it.skipIf(skip)("MRR by month over a quarter, and by billing interval", async () => {
    const months = await ask({ metrics: ["mrr"], time: { grain: "month", range: "last_3_months" } });
    expect(months.map((r) => String(r.month).slice(0, 10))).toEqual(["2026-07-01", "2026-08-01", "2026-09-01"]);
    expect(Number(months[1]?.mrr)).toBeCloseTo(await reference(MRR_SQL, ["2026-09-01T00:00:00Z"]), 1);

    const split = await ask({ metrics: ["mrr"], dimensions: ["billing_interval"], time: { range: "last_month" } });
    const total = split.reduce((sum, r) => sum + Number(r.mrr), 0);
    expect(total).toBeCloseTo(await reference(MRR_SQL, ["2026-10-01T00:00:00Z"]), 0);
  });

  it.skipIf(skip)("reads a quarter of a snapshot at its last month, never the sum of its months", async () => {
    // MRR is a snapshot (one row per item at each month's end): Q3's MRR is September's, and so is the MRR over the
    // last three months asked without a grain; summing them would count each item about three times.
    const sep = await reference(MRR_SQL, ["2026-10-01T00:00:00Z"]);
    const quarter = await ask({ metrics: ["mrr"], time: { grain: "quarter", range: "last_quarter" } });
    expect(quarter).toHaveLength(1);
    expect(String(quarter[0]?.quarter)).toMatch(/^2026-07-01/);
    expect(Number(quarter[0]?.mrr)).toBeCloseTo(sep, 1);
    const range = await ask({ metrics: ["mrr"], time: { range: "last_3_months" } });
    expect(Number(range[0]?.mrr)).toBeCloseTo(sep, 1);
    // The quarter holds items that ended in it: they have July rows and none in September, so they're left out.
    const ended = await reference(
      "select count(*) from public.subscription_items where ended_at >= $1 and ended_at < $2",
      ["2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"],
    );
    expect(ended).toBeGreaterThan(0);
    // Paying customers too: the accounts paying at the quarter's end, not those that paid at any time in it.
    const customers = await ask({ metrics: ["paying_customers"], time: { grain: "quarter", range: "last_quarter" } });
    const septCustomers = await ask({ metrics: ["paying_customers"], time: { range: "last_month" } });
    expect(Number(customers[0]?.paying_customers)).toBe(Number(septCustomers[0]?.paying_customers));
  });

  it.skipIf(skip)("filters a snapshot as it reads it: by a column within a range, and by its own month", async () => {
    // MySQL binds its parameters by position: the window's range comes first in the SQL, then the filters.
    const split = await ask({ metrics: ["mrr"], dimensions: ["billing_interval"], time: { range: "last_quarter" } });
    const yearly = await ask({
      metrics: ["mrr"],
      filters: [{ field: "billing_interval", op: "in", value: ["year"] }],
      time: { range: "last_quarter" },
    });
    expect(Number(yearly[0]?.mrr)).toBeCloseTo(Number(split.find((r) => r.billing_interval === "year")?.mrr), 1);
    const single = await ask({
      metrics: ["mrr"],
      filters: [{ field: "billing_interval", op: "=", value: "year" }],
      time: { range: "last_quarter" },
    });
    expect(Number(single[0]?.mrr)).toBeCloseTo(Number(yearly[0]?.mrr), 1);
    // A filter on the month picks the snapshots: before September, with no range, is August's.
    const before = await ask({ metrics: ["mrr"], filters: [{ field: "month", op: "<", value: "2026-09-01" }] });
    expect(Number(before[0]?.mrr)).toBeCloseTo(await reference(MRR_SQL, ["2026-09-01T00:00:00Z"]), 1);
  });

  it.skipIf(skip)("reads MRR now, asked with no time at all, at the latest snapshot", async () => {
    const now = await ask({ metrics: ["mrr"] });
    const thisMonth = await ask({ metrics: ["mrr"], time: { range: "this_month" } });
    expect(now).toHaveLength(1);
    expect(Number(now[0]?.mrr)).toBeGreaterThan(0);
    expect(Number(now[0]?.mrr)).toBeCloseTo(Number(thisMonth[0]?.mrr), 1);
  });

  it.skipIf(skip)("churned MRR by plan last month matches the reference", async () => {
    const rows = await ask({ metrics: ["churned_mrr"], dimensions: ["plans.name"], time: { range: "last_month" } });
    const expected = await s.source.query(CHURNED_MRR_BY_PLAN_SQL, SEP);
    expect(rows.map((r) => [r.plans_name, Number(r.churned_mrr)])).toEqual(
      expected.map((r) => [r.plan, Number(r.churned_mrr)]).sort((a, b) => (b[1] as number) - (a[1] as number)),
    );
  });

  it.skipIf(skip)("a list filter (a dashboard filter's shape) runs with its values bound, through a join", async () => {
    // Active seats on Starter and Growth for German and French accounts: `in` over a joined column and over the
    // account's, each a list parameter on every dialect. Values that try to break out of their quotes match nothing.
    const rows = await ask({
      metrics: ["active_seats"],
      filters: [
        { field: "plans.name", op: "in", value: ["Starter", "Growth", "x') or ('1'='1", "x\\' or 1=1 or '"] },
        { field: "accounts.country", op: "in", value: ["DE", "FR"] },
      ],
    });
    const none = await ask({ metrics: ["active_seats"], filters: [{ field: "plans.name", op: "in", value: [] }] });
    expect(Number(Object.values(none[0] ?? {}).at(-1) ?? 0)).toBe(0);
    const expected = await reference(
      `select sum(x.seats) from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
       where x.status = 'active' and p.name in ('Starter', 'Growth') and a.country in ('DE', 'FR')`,
    );
    expect(expected).toBeGreaterThan(0);
    expect(Number(Object.values(rows[0] ?? {}).at(-1))).toBe(expected);
  });

  it.skipIf(skip)("counts, averages and current states match the golden set's reference SQL", async () => {
    const one = async (q: MetricQueryInput) => Number(Object.values((await ask(q))[0] ?? {}).at(-1));
    const sep = { from: "2026-09-01", to: "2026-10-01" };
    const cases: [MetricQueryInput, string, unknown[]][] = [
      [{ metrics: ["customer_accounts"] }, "select count(*) from public.accounts where not is_test", []],
      [
        { metrics: ["new_accounts"], time: { range: sep } },
        "select count(*) from public.accounts where not is_test and created_at >= $1 and created_at < $2",
        SEP,
      ],
      [
        { metrics: ["active_subscriptions"] },
        `select count(*) from public.subscriptions x ${NOT_TEST} where x.status = 'active'`,
        [],
      ],
      [
        { metrics: ["trials"] },
        `select count(*) from public.subscriptions x ${NOT_TEST} where x.status = 'trialing'`,
        [],
      ],
      [
        { metrics: ["active_seats"], filters: [{ field: "plans.name", op: "=", value: "Growth" }] },
        `select sum(x.seats) from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
         where x.status = 'active' and p.name = 'Growth'`,
        [],
      ],
      [
        { metrics: ["tickets_opened"], time: { range: "last_month" } },
        `select count(*) from support.tickets x ${NOT_TEST} where x.created_at >= $1 and x.created_at < $2`,
        SEP,
      ],
      [
        { metrics: ["failed_payments"], time: { range: sep } },
        `select count(*) from billing.payments p join billing.invoices x on x.id = p.invoice_id ${NOT_TEST}
         where p.status = 'failed' and p.created_at >= $1 and p.created_at < $2`,
        SEP,
      ],
      [
        { metrics: ["refunds"], time: { range: sep } },
        `select count(*) from billing.refunds r join billing.payments p on p.id = r.payment_id
         join billing.invoices x on x.id = p.invoice_id ${NOT_TEST} where r.created_at >= $1 and r.created_at < $2`,
        SEP,
      ],
    ];
    for (const [query, sql, params] of cases) {
      expect(await one(query), query.metrics.join()).toBe(await reference(sql, params));
    }
    const csat = await one({ metrics: ["avg_csat"], time: { range: sep } });
    const expectedCsat = await reference(
      `select avg(x.csat) from support.tickets x ${NOT_TEST} where x.solved_at >= $1 and x.solved_at < $2 and x.csat is not null`,
      SEP,
    );
    expect(Math.abs(csat - expectedCsat)).toBeLessThan(0.006);
  });

  it.skipIf(skip)("ranks with a join: the plan with the most active subscriptions", async () => {
    const [top] = await ask({ metrics: ["active_subscriptions"], dimensions: ["plans.name"], limit: 1 });
    const [expected] = await s.source.query(`
      select p.name from public.subscriptions x ${NOT_TEST} join public.plans p on p.id = x.plan_id
      where x.status = 'active' group by p.name order by count(*) desc limit 1`);
    expect(top?.plans_name).toBe(expected?.name);
  });
});

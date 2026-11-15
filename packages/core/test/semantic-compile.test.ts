// The semantic compiler without a database: the demo pack builds, time ranges resolve, each construct compiles to the
// expected shape, and what the definitions can't express is refused with a message that says why.
import { clickhouseSql, postgresSql } from "@opendash/connectors";
import { describe, expect, it } from "vitest";
import {
  buildModel,
  compileMetricQuery,
  type DatasetSpec,
  demoPack,
  type MetricQueryInput,
  modelFromYaml,
  type SemanticModel,
} from "../src";
import { resolveRange } from "../src/semantic/time";

const NOW = new Date("2026-10-10T12:00:00Z");
const pack = (dialect: "postgres" | "clickhouse") => {
  const { datasets, metrics } = demoPack(dialect);
  const built = modelFromYaml(datasets, metrics);
  if (!built.ok) throw new Error(built.problems.join("\n"));
  return built.model;
};
const pg = pack("postgres");
const compile = (q: MetricQueryInput, model: SemanticModel = pg) =>
  compileMetricQuery(model, q, { now: NOW, sql: postgresSql });

describe("the demo pack", () => {
  it.each(["postgres", "clickhouse"] as const)("builds on %s", (dialect) => {
    const model = pack(dialect);
    expect([...model.metrics.keys()]).toContain("mrr");
    expect([...model.datasets.keys()]).toEqual([
      "mrr_monthly",
      "churn",
      "accounts",
      "plans",
      "subscriptions",
      "tickets",
      "payments",
      "refunds",
    ]);
  });

  it("fills in schema names", () => {
    const { datasets } = demoPack("clickhouse", { public: "t1_public", billing: "t1_billing" });
    expect(datasets.join("\n")).toContain("t1_public.subscription_items");
    expect(datasets.join("\n")).not.toMatch(/\{\{/);
  });

  it("says what's wrong with a model, naming each item", () => {
    const { datasets, metrics } = demoPack("postgres");
    const broken = modelFromYaml(datasets, [
      ...metrics,
      "name: lost\nlabel: x\ndescription: x\ndataset: nowhere\nmeasure: m\n",
    ]);
    expect(broken).toEqual({
      ok: false,
      problems: [
        "Metric lost: there's no dataset nowhere. Datasets: accounts, churn, mrr_monthly, payments, plans, refunds, subscriptions, tickets.",
      ],
    });
    expect(modelFromYaml(["ref: x\nlabel: [unclosed"], [])).toMatchObject({ ok: false });
    const grained = datasets.map((d) =>
      d.startsWith("ref: mrr_monthly")
        ? d.replace("- { name: seats, type: number", "- { name: seats, type: number, grain: month")
        : d,
    );
    expect(modelFromYaml(grained, metrics)).toEqual({
      ok: false,
      problems: ["Dataset mrr_monthly: seats has a grain but isn't a time column."],
    });
    const snapshotAtSeats = datasets.map((d) =>
      d.startsWith("ref: mrr_monthly") ? d.replace("snapshot: { at: month }", "snapshot: { at: seats }") : d,
    );
    expect(modelFromYaml(snapshotAtSeats, metrics)).toEqual({
      ok: false,
      problems: ["Dataset mrr_monthly: snapshot at seats isn't a time column."],
    });
    // Compared by its period: a snapshot's time column says it.
    const ungrained = datasets.map((d) =>
      d.startsWith("ref: mrr_monthly")
        ? d.replace("- { name: month, type: time, grain: month,", "- { name: month, type: time,")
        : d,
    );
    expect(modelFromYaml(ungrained, metrics)).toMatchObject({
      ok: false,
      problems: [expect.stringMatching(/snapshot at month needs its grain/)],
    });
  });
});

describe("time ranges, in UTC", () => {
  const r = (range: Parameters<typeof resolveRange>[0]) => {
    const { from, to } = resolveRange(range, NOW);
    return [from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)];
  };
  it.each([
    ["last_month", ["2026-09-01", "2026-10-01"]],
    ["this_month", ["2026-10-01", "2026-11-01"]],
    ["last_3_months", ["2026-07-01", "2026-10-01"]],
    ["last_quarter", ["2026-07-01", "2026-10-01"]],
    ["this_week", ["2026-10-05", "2026-10-12"]],
    ["last_7_days", ["2026-10-03", "2026-10-10"]],
    ["year_to_date", ["2026-01-01", "2026-10-11"]],
    ["last_year", ["2025-01-01", "2026-01-01"]],
  ] as const)("%s", (range, expected) => {
    expect(r(range)).toEqual(expected);
  });
  it("takes two dates, the second exclusive", () => {
    expect(r({ from: "2026-08-01", to: "2026-09-01" })).toEqual(["2026-08-01", "2026-09-01"]);
  });
});

describe("compiling", () => {
  it("compares a month with the one before, reading one extra period", () => {
    const c = compile({ metrics: ["mrr"], time: { range: "last_month", compare: "previous_period" } });
    expect(c.grain).toBe("month");
    expect(c.columns).toEqual([
      { name: "month", role: "time", source: "mrr_monthly.month" },
      { name: "mrr", role: "measure", source: "mrr" },
      { name: "mrr_previous", role: "measure", source: "mrr", previous: true },
    ]);
    expect(c.params).toEqual([
      { name: "range_from", value: "2026-08-01T00:00:00.000Z" },
      { name: "range_to", value: "2026-10-01T00:00:00.000Z" },
      { name: "range_since", value: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(c.sql).toContain('with "mrr_monthly" as (');
    expect(c.sql).toContain("(not is_test)");
    expect(c.sql).toContain("lag(__m0) over (order by __p) as __mp0");
    expect(c.sql).toContain("case when __pp = ((__p) + interval '-1 months')::date then __mp0 end as \"mrr_previous\"");
    expect(c.sql).toContain('__p as "month", __m0 as "mrr"');
    expect(c.sql).not.toContain("__j_");
  });

  it("joins n:1 for a dimension on another dataset, and names the output after it", () => {
    const c = compile({ metrics: ["churned_mrr"], dimensions: ["plans.name"], time: { range: "last_month" } });
    expect(c.datasets).toEqual(["churn", "plans"]);
    expect(c.sql).toContain('left join "plans" as __j_plans on __j_plans."id" = __b."plan_id"');
    expect(c.columns.map((x) => x.name)).toEqual(["plans_name", "churned_mrr"]);
    expect(c.sql).toMatch(/order by "churned_mrr" desc, "plans_name" asc/);
  });

  it("applies the metric's segments, filters as parameters, and lifts a default segment when asked", () => {
    const c = compile({
      metrics: ["active_seats"],
      filters: [
        { field: "plans.name", op: "=", value: "Growth" },
        { field: "billing_interval", op: "in", value: ["month", "year"] },
      ],
      exclude_segments: ["exclude_test"],
    });
    expect(c.sql).toContain("(status = 'active')");
    expect(c.sql).not.toContain("not is_test");
    expect(c.sql).toContain('"plans__name" = $1');
    expect(c.sql).toContain('"billing_interval" = any($2::text[])');
    expect(c.params).toEqual([
      { name: "f1", value: "Growth" },
      { name: "f2", value: ["month", "year"] },
    ]);
  });

  it("writes ClickHouse with named, typed parameters and its own functions", () => {
    const c = compileMetricQuery(
      pack("clickhouse"),
      {
        metrics: ["mrr"],
        dimensions: ["billing_interval"],
        time: { range: "last_3_months", compare: "previous_period" },
      },
      { now: NOW, sql: clickhouseSql },
    );
    expect(c.sql).toContain("{range_from:DateTime64(3, 'UTC')}");
    expect(c.sql).toContain("toStartOfMonth(toDateTime64(`month`, 3, 'UTC'))");
    expect(c.sql).toContain("lagInFrame(toNullable(__m0)) over (partition by __d0 order by __p");
    expect(c.sql).toContain("addMonths(__p, -1)");
  });
});

describe("a month-end snapshot", () => {
  it.each<[string, MetricQueryInput]>([
    ["by month", { metrics: ["mrr"], time: { grain: "month", range: "last_12_months" } }],
    [
      "this month, as of now, against last month",
      { metrics: ["mrr"], time: { range: "this_month", compare: "previous_period" } },
    ],
    ["year to date, by quarter", { metrics: ["mrr"], time: { grain: "quarter", range: "year_to_date" } }],
  ])("reads %s", (_, query) => {
    expect(() => compile(query)).not.toThrow();
  });

  it("and a dated event by week, as before", () => {
    expect(() => compile({ metrics: ["new_accounts"], time: { grain: "week", range: "last_12_weeks" } })).not.toThrow();
  });

  it("keeps each period's last snapshot, chosen over every row in the range before segments and filters", () => {
    const { sql } = compile({
      metrics: ["mrr"],
      dimensions: ["billing_interval"],
      time: { grain: "quarter", range: "year_to_date" },
    });
    // The latest snapshot per quarter, over the range's rows; then only those rows, then the default segment.
    expect(sql).toMatch(
      /__snap as \(\nselect __rows\.\*, max\(date_trunc\('month', \("month"\).*\) over \(partition by date_trunc\('quarter'/,
    );
    expect(sql).toMatch(/as __latest\nfrom __rows\nwhere "month" >= /);
    expect(sql).toMatch(/from __snap\nwhere date_trunc\('month', \("month"\).* = __latest\n {2}and \(not is_test\)/);
    // Asked without a grain, the range is one period: its latest snapshot.
    expect(compile({ metrics: ["mrr"], time: { range: "last_3_months" } }).sql).toMatch(/\) over \(\) as __latest/);
    // A dataset of events adds its rows up as before.
    expect(compile({ metrics: ["new_accounts"], time: { grain: "month", range: "last_3_months" } }).sql).not.toMatch(
      /__snap/,
    );
  });
});

describe("refusing what the definitions can't express", () => {
  it.each<[string, MetricQueryInput, RegExp]>([
    ["an unknown metric", { metrics: ["arr"] }, /There's no metric arr\. Metrics: .*mrr/],
    [
      "metrics on different datasets",
      { metrics: ["mrr", "new_accounts"] },
      /mrr is on mrr_monthly and new_accounts on accounts: ask for them in separate queries/,
    ],
    ["metrics counting different rows", { metrics: ["active_subscriptions", "trials"] }, /segments differ/],
    [
      "a time range on a current-state metric",
      { metrics: ["active_subscriptions"], time: { range: "last_month" } },
      /about the current state/,
    ],
    [
      "a field across a 1:n edge",
      { metrics: ["new_accounts"], dimensions: ["subscriptions.status"] },
      /subscriptions is 1:n from accounts: grouping new_accounts by subscriptions\.status would count rows of accounts more than once/,
    ],
    [
      "an unknown field, with a suggestion",
      { metrics: ["churned_mrr"], dimensions: ["name"] },
      /Did you mean accounts\.name or plans\.name\?/,
    ],
    ["a field that isn't a dimension", { metrics: ["mrr"], dimensions: ["mrr_usd"] }, /isn't a dimension/],
    [
      "a list filter with one value",
      { metrics: ["mrr"], filters: [{ field: "currency", op: "in", value: "USD" }] },
      /in takes a list/,
    ],
    [
      "ordering by something that isn't an output",
      { metrics: ["mrr"], order: [{ by: "plan", dir: "desc" }] },
      /Can't order by plan/,
    ],
    ["an unknown segment", { metrics: ["mrr"], segments: ["vip"] }, /has no segment vip/],
    [
      "a month-end snapshot by week",
      { metrics: ["mrr"], time: { grain: "week", range: "last_12_weeks" } },
      /mrr has one value per month \(mrr_monthly is dated to the month\), so it can't be read by week\. Ask by month, quarter, year\./,
    ],
    ["a month-end snapshot over last week", { metrics: ["mrr"], time: { range: "last_week" } }, /a shorter range/],
    [
      "a month-end snapshot from the middle of a month",
      { metrics: ["paying_customers"], time: { range: { from: "2026-09-15", to: "2026-10-01" } } },
      /paying_customers has one value per month/,
    ],
  ])("%s", (_, query, message) => {
    expect(() => compile(query)).toThrow(message);
  });

  it("an unrelated dataset", () => {
    const d = (ref: string): DatasetSpec => ({
      ref,
      label: ref,
      sql: `select 1 as id from ${ref}`,
      grain: "one row",
      primary_key: ["id"],
      columns: [{ name: "id", type: "number", dimension: true, synonyms: [] }],
      measures: [{ name: "n", expr: "count(*)", format: "number" }],
      segments: [],
      relationships: [],
    });
    const built = buildModel(
      [d("a"), d("b")],
      [
        {
          name: "n",
          label: "n",
          description: "n",
          dataset: "a",
          measure: "n",
          segments: [],
          direction: "neutral",
          synonyms: [],
        },
      ],
    );
    if (!built.ok) throw new Error("model");
    expect(() => compile({ metrics: ["n"], dimensions: ["b.id"] }, built.model)).toThrow(/b isn't related to a/);
  });
});

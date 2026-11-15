// An App's definition: checked as a whole and against its source's verified datasets, each problem
// naming where it is; its render revision, the same for the same content whatever the key order; its filters bound on
// the server, periods where the workspace is; and a number's rows only through the rows query it declares.
import { describe, expect, it } from "vitest";
import {
  BindRefused,
  bindDrill,
  bindQuery,
  type CheckContext,
  checkDefinition,
  type Definition,
  filterValues,
  grantsOf,
  periodRange,
  previousRange,
  provenanceOf,
  recordScope,
} from "../src/dashboard";
import { canonical, revisionOf } from "../src/dashboard/revision";
import { ACME } from "./fixtures/acme-catalog";
import { proof, SOURCE } from "./fixtures/proof";

const ctx: CheckContext = { catalogs: { [SOURCE]: ACME } };
const problems = (d: unknown, c = ctx) => {
  const r = checkDefinition(d, c);
  return r.ok ? [] : r.problems;
};
/** The proof with one change made to a copy. */
const changed = (fn: (d: Definition) => void): Definition => {
  const d = structuredClone(proof());
  fn(d);
  return d;
};
describe("an App's definition", () => {
  it("passes whole: its queries on verified datasets, every reference resolved", () => {
    expect(problems(proof())).toEqual([]);
    // Its own shape needs no catalog; references still resolve.
    expect(checkDefinition(proof()).ok).toBe(true);
  });

  it("names where each broken reference is", () => {
    const cases: [string, (d: Definition) => void, { path: string; message: RegExp }][] = [
      [
        "a query's filter",
        (d) => {
          (d.queries.q_new as { filters: Record<string, string> }).filters.f_gone = "plan";
        },
        { path: "queries.q_new.filters.f_gone", message: /no filter f_gone/ },
      ],
      [
        "a comparison with no period",
        (d) => {
          (d.queries.q_new as { compare?: string }).compare = "previous_period";
        },
        { path: "queries.q_new.compare", message: /needs a period/ },
      ],
      [
        "a dataset the source doesn't have",
        (d) => {
          (d.queries.q_mrr as { source: { dataset: string } }).source.dataset = "deals";
        },
        { path: "queries.q_mrr.source.dataset", message: /no dataset "deals" on that source/ },
      ],
      [
        "a column",
        (d) => {
          (d.queries.q_accounts as { select: string[] }).select.push("email");
        },
        { path: "queries.q_accounts.select[4]", message: /no column "email"/ },
      ],
      [
        "a measure",
        (d) => {
          (d.queries.q_mrr as { measures: Record<string, unknown> }).measures.mrr = ["measure", "arr"];
        },
        { path: "queries.q_mrr.measures.mrr", message: /no measure "arr"/ },
      ],
      [
        "a period on a column that isn't a date",
        (d) => {
          (d.queries.q_mrr as { filters: Record<string, string> }).filters.f_period = "plan";
        },
        { path: "queries.q_mrr.filters.f_period", message: /isn't one/ },
      ],
      [
        "rows without their key",
        (d) => {
          (d.queries.q_accounts as { select: string[] }).select = ["name", "mrr"];
        },
        { path: "queries.q_accounts.select", message: /Add id/ },
      ],
      [
        "a drill to a query of measures",
        (d) => {
          (d.queries.q_mrr as { drill?: string }).drill = "q_new";
        },
        { path: "queries.q_mrr.drill", message: /opens a rows query/ },
      ],
      [
        "a key the query doesn't list",
        (d) => {
          (d.queries.q_accounts as { key?: string }).key = "seats";
        },
        { path: "queries.q_accounts.key", message: /seats isn't/ },
      ],
      [
        "a search on a query of measures",
        (d) => {
          (d.queries.q_mrr as { search?: boolean }).search = true;
        },
        { path: "queries.q_mrr.search", message: /Only a rows query/ },
      ],
      [
        "a filter's values from a query drawn for a record",
        (d) => {
          d.filters.f_plan = {
            kind: "select",
            label: "Plan",
            options: [],
            values: { from: "q_accounts" },
            default: [],
          };
          (d.queries.q_accounts as { record?: string }).record = "id";
        },
        { path: "filters.f_plan.values.from", message: /drawn for a record: a filter's values aren't/ },
      ],
      [
        "an id that isn't one",
        (d) => {
          (d.queries.q_mrr as { drill?: string }).drill = "MRR";
        },
        { path: "queries.q_mrr.drill", message: /an id like q_revenue/ },
      ],
    ];
    for (const [what, fn, want] of cases) {
      const found = problems(changed(fn));
      expect(found, what).toContainEqual({ path: want.path, message: expect.stringMatching(want.message) });
    }
  });

  it("takes a source it can't read for no source at all", () => {
    expect(problems(proof(), { catalogs: {} })).toContainEqual({
      path: "queries.q_mrr.source.connection",
      message: "That source isn't one this dashboard can read.",
    });
  });
});

describe("an App's render revision", () => {
  const runtimeHash = "r".repeat(64);
  it("is the same for the same content, whatever the order of its keys", () => {
    const d = proof();
    // The same content with every object's keys in reverse order, at every depth.
    const reverse = (v: unknown): unknown =>
      Array.isArray(v)
        ? v.map(reverse)
        : v && typeof v === "object"
          ? Object.fromEntries(
              Object.entries(v)
                .reverse()
                .map(([k, x]) => [k, reverse(x)]),
            )
          : v;
    const reordered = reverse(d) as Definition;
    expect(canonical(reordered)).not.toBe(JSON.stringify(reordered));
    expect(revisionOf({ definition: reordered, bundleHash: "b", runtimeHash })).toBe(
      revisionOf({ definition: d, bundleHash: "b", runtimeHash }),
    );
  });

  it("changes with the definition, the App's bundle and the runtime, each", () => {
    const base = revisionOf({ definition: proof(), bundleHash: "b", runtimeHash });
    const renamed = changed((d) => {
      d.title = "Revenue";
    });
    const all = [
      base,
      revisionOf({ definition: renamed, bundleHash: "b", runtimeHash }),
      revisionOf({ definition: proof(), bundleHash: "c", runtimeHash }),
      revisionOf({ definition: proof(), bundleHash: null, runtimeHash }),
      revisionOf({ definition: proof(), bundleHash: "b", runtimeHash: "s".repeat(64) }),
    ];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("a period", () => {
  // 00:30 on November 1st in Berlin is still October 31st in UTC: the workspace's zone says which day today is.
  const now = new Date("2026-10-31T23:30:00Z");
  const berlin = "Europe/Berlin";

  it("is days: this month through today where the workspace is, and the same stretch of the month before", () => {
    expect(periodRange("this_month", now, berlin)).toEqual({ from: "2026-11-01", to: "2026-11-02" });
    expect(previousRange("this_month", now, berlin)).toEqual({ from: "2026-10-01", to: "2026-10-02" });
    expect(periodRange("this_month", now, "UTC")).toEqual({ from: "2026-10-01", to: "2026-11-01" });
  });

  it("is whole months back from this one, a named month whole, and the same length before", () => {
    expect(periodRange("last_12_months", now, berlin)).toEqual({ from: "2025-11-01", to: "2026-11-01" });
    expect(previousRange("last_12_months", now, berlin)).toEqual({ from: "2024-11-01", to: "2025-11-01" });
    expect(periodRange("2026-09", now, berlin)).toEqual({ from: "2026-09-01", to: "2026-10-01" });
    expect(previousRange("2026-09", now, berlin)).toEqual({ from: "2026-08-01", to: "2026-09-01" });
    expect(periodRange("last_year", now, berlin)).toEqual({ from: "2025-01-01", to: "2026-01-01" });
    expect(periodRange("2026-13", now, berlin)).toBeNull();
    expect(periodRange("yesterday", now, berlin)).toBeNull();
  });

  it("compares a month to date with the month before to the same day, or to its end when it's shorter", () => {
    const march = (d: number) => new Date(Date.UTC(2026, 2, d, 12));
    expect(previousRange("this_month", march(27), "UTC")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    // The 28th to the 31st of March all compare with the whole of February.
    for (const d of [28, 30, 31]) {
      expect(previousRange("this_month", march(d), "UTC")).toEqual({ from: "2026-02-01", to: "2026-03-01" });
    }
    // A year to date on a leap day compares with the year before through its February's end.
    const leap = new Date(Date.UTC(2028, 1, 29, 12));
    expect(previousRange("this_year", leap, "UTC")).toEqual({ from: "2027-01-01", to: "2027-03-01" });
  });

  it("binds as days, so a date column and a timestamp column read the same calendar days", () => {
    const d = proof();
    const ny = { now: new Date("2026-10-15T12:00:00Z"), tz: "America/New_York" };
    const bound = bindQuery(d, "q_mrr", { filters: { f_period: "2026-09" } }, ny);
    expect(bound.spec.where).toEqual([
      ["started_at", ">=", "2026-09-01"],
      ["started_at", "<", "2026-10-01"],
    ]);
    // Compared with the month before, beside it.
    expect(bound.previous?.where).toEqual([
      ["started_at", ">=", "2026-08-01"],
      ["started_at", "<", "2026-09-01"],
    ]);
  });
});

describe("binding what the frame sent", () => {
  const at = { now: new Date("2026-10-15T12:00:00Z"), tz: "UTC" };

  it("checks each filter's value, and fills in the defaults", () => {
    const d = proof();
    expect(filterValues(d)).toEqual({ f_period: "this_month", f_plan: [] });
    expect(filterValues(d, { f_plan: ["Growth"] })).toEqual({ f_period: "this_month", f_plan: ["Growth"] });
    expect(() => filterValues(d, { f_gone: "x" })).toThrow(BindRefused);
    expect(() => filterValues(d, { f_plan: ["Enterprise"] })).toThrow(/isn't one of f_plan's options/);
    expect(() => filterValues(d, { f_period: "forever" })).toThrow(/takes a period/);
    expect(() => filterValues(d, { f_plan: "Growth" })).toThrow(/takes a list/);
  });

  it("narrows by a chosen option, and by nothing when none is chosen", () => {
    const d = proof();
    const none = bindQuery(d, "q_new", {}, at).spec;
    expect(none.where ?? []).toEqual([]);
    const growth = bindQuery(d, "q_new", { filters: { f_plan: ["Growth", "Scale"] } }, at).spec;
    expect(growth.where).toEqual([["plan", "in", ["Growth", "Scale"]]]);
  });

  it("pages and sorts rows on their own columns only, never past the cap", () => {
    const d = proof();
    const page = bindQuery(d, "q_accounts", { page: 2, sort: "name" }, at).spec;
    expect(page).toMatchObject({ from: "accounts", page: { size: 50, offset: 100 }, sort: ["name"] });
    expect(() => bindQuery(d, "q_accounts", { sort: "-country" }, at)).toThrow(/can't sort by -country/);
    expect(() => bindQuery(d, "q_accounts", { page: 10_000 }, at)).toThrow(/out of reach/);
    expect(() => bindQuery(d, "q_mrr", { page: 1 }, at)).toThrow(/has no pages/);
    expect(() => bindQuery(d, "q_gone", {}, at)).toThrow(/no query q_gone/);
  });

  it("opens a number's rows through its declared rows query, narrowed to its group's whole month", () => {
    const d = proof();
    const rows = bindDrill(
      d,
      "q_new",
      { filters: { f_plan: ["Growth"] }, group: { created_at_month: "2026-09-01" } },
      at,
    );
    expect(rows).toEqual({
      from: "accounts",
      select: ["id", "name", "plan", "mrr"],
      sort: ["-mrr"],
      where: [
        ["plan", "in", ["Growth"]],
        ["created_at", ">=", "2026-09-01T00:00:00.000Z"],
        ["created_at", "<", "2026-10-01T00:00:00.000Z"],
      ],
      page: { size: 50, offset: 0 },
    });
    expect(() => bindDrill(d, "q_new", { group: {} }, at)).toThrow(/Say which created_at_month/);
    expect(() => bindDrill(d, "q_new", { group: { created_at_month: "2026-09-01", plan: "x" } }, at)).toThrow(
      /isn't grouped by plan/,
    );
    // The list's own conditions hold too.
    const active = changed((x) => {
      (x.queries.q_accounts as { where?: unknown[] }).where = [["status", "=", "active"]];
    });
    expect(bindDrill(active, "q_mrr", {}, at).where).toContainEqual(["status", "=", "active"]);
    expect(() => bindDrill(d, "q_accounts", {}, at)).toThrow(/don't open rows/);
    // With no drill of its own, a number still opens its rows: the columns the dashboard already shows of its dataset
    // (its key, and the columns a rows query lists), and nothing when the dashboard shows none.
    const none = changed((x) => {
      delete (x.queries.q_mrr as { drill?: string }).drill;
    });
    expect(() => bindDrill(none, "q_mrr", {}, at)).toThrow(/nothing to list/);
    const known = { ...at, datasets: ACME };
    const derived = bindDrill(none, "q_mrr", { filters: { f_plan: ["Growth"] } }, known);
    expect(derived.from).toBe("accounts");
    expect(derived.select?.[0]).toBe(ACME.accounts?.key);
    expect(derived.select).toEqual(expect.arrayContaining(["name", "plan", "mrr"]));
    expect(derived.where).toContainEqual(["plan", "in", ["Growth"]]);
  });

  it("reads a metric only with its meaning: its segments over every measure beside it, never a snapshot summed", () => {
    const metrics = {
      ...ACME,
      accounts: {
        ...ACME.accounts,
        metrics: {
          paying: { title: "Paying accounts", timeColumn: "created_at", segments: ["paying"] },
          trials: { title: "Trials", timeColumn: "created_at", segments: ["trial"] },
        },
      },
    } as never;
    const c = { ...ctx, catalogs: { [SOURCE]: metrics } };
    const withMeasures = (measures: Record<string, unknown>) =>
      changed((x) => {
        (x.queries.q_mrr as { measures: unknown }).measures = measures;
        delete (x.queries.q_mrr as { compare?: unknown }).compare;
        delete (x.queries.q_mrr as { drill?: unknown }).drill;
      });
    const said = (d: Definition) =>
      problems(d, c)
        .map((p) => p.message)
        .join(" ");
    expect(said(withMeasures({ n: ["metric", "paying"] }))).not.toMatch(/metric|segments/);
    expect(said(withMeasures({ n: ["metric", "paying"], m: ["count"] }))).toMatch(
      /would change the rows the other measures count/,
    );
    expect(said(withMeasures({ n: ["metric", "paying"], t: ["metric", "trials"] }))).toMatch(/different segments/);
    expect(said(withMeasures({ n: ["metric", "nope"] }))).toMatch(/no metric "nope"/);
    // An all-rows metric beside a segmented one, in either order: refused (the segment would narrow both).
    const all = {
      ...c,
      catalogs: {
        [SOURCE]: {
          ...(metrics as Record<string, object>),
          accounts: {
            ...(metrics as { accounts: object }).accounts,
            metrics: {
              ...(metrics as { accounts: { metrics: object } }).accounts.metrics,
              every: { title: "All", timeColumn: "created_at" },
            },
          },
        },
      },
    } as never;
    for (const order of [
      { e: ["metric", "every"], p: ["metric", "paying"] },
      { p: ["metric", "paying"], e: ["metric", "every"] },
    ]) {
      expect(
        problems(withMeasures(order), all)
          .map((x) => x.message)
          .join(" "),
      ).toMatch(/different segments/);
    }
    // The rows behind a segmented metric are the rows it counts: its segments go with them.
    const rows = bindDrill(
      withMeasures({ n: ["metric", "paying"] }),
      "q_mrr",
      {},
      {
        ...at,
        datasets: (c.catalogs as Record<string, never>)[SOURCE],
      },
    );
    expect(rows.segments).toEqual(["paying"]);
    const snapshot = {
      ...c,
      catalogs: {
        [SOURCE]: {
          ...(metrics as Record<string, object>),
          accounts: { ...(metrics as { accounts: object }).accounts, snapshot: { at: "created_at" } },
        },
      },
    } as never;
    expect(
      problems(withMeasures({ n: ["metric", "paying"] }), snapshot)
        .map((p) => p.message)
        .join(" "),
    ).toMatch(/a table of snapshots/);
  });

  it("says what's wrong with an own dataset, never just 'Invalid input'; a service's paths may name keys with spaces", () => {
    const bad = changed((x) => {
      x.datasets = {
        t_rows: {
          connection: SOURCE,
          title: "Rows",
          sql: "select id, created_on from public.accounts",
          columns: [
            { name: "id", type: "number" },
            { name: "created_on", type: "geometry" as never },
          ],
        },
        t_issues: {
          connection: SOURCE,
          title: "Open issues",
          service: { tool: "searchIssues", arguments: {} },
          rows: "issues",
          columns: [
            { name: "key", path: "key", type: "string" },
            { name: "team", path: "fields.customFields.Owner Team.value.0.value", type: "string" },
          ],
          key: "key",
        },
      } as never;
    });
    const found = problems(bad) as { path: string; message: string }[];
    expect(found.map((p) => p.message).join(" ")).not.toContain("Invalid input");
    expect(found.some((p) => p.path === "datasets.t_rows.columns[1].type")).toBe(true);
    expect(found.some((p) => p.path.startsWith("datasets.t_issues"))).toBe(false);
  });

  it("reads the dashboard's own datasets: checked like the rest, every column granted, listed without a key", () => {
    const own = changed((x) => {
      x.datasets = {
        t_revenue: {
          connection: SOURCE,
          title: "Revenue by month",
          sql: "select account_id, month, revenue from billing.revenue_by_month",
          columns: [
            { name: "account_id", type: "number" },
            { name: "month", type: "time" },
            { name: "revenue", type: "number" },
          ],
        },
      };
      x.queries.q_rev = {
        source: { connection: SOURCE, dataset: "t_revenue" },
        measures: { revenue: ["sum", "revenue"] },
        by: ["month:month"],
        filters: {},
      };
      x.queries.q_rev_rows = {
        source: { connection: SOURCE, dataset: "t_revenue" },
        select: ["account_id", "month", "revenue"],
        filters: {},
      };
    });
    expect(problems(own)).toEqual([]);
    expect(grantsOf(own, SOURCE).datasets.t_revenue?.columns).toEqual(["account_id", "month", "revenue"]);
    expect(provenanceOf(own, { [SOURCE]: ACME }).q_rev).toBe("table");
    expect(
      provenanceOf(own, { [SOURCE]: { ...ACME, accounts: { ...ACME.accounts, unverified: true } } as never }).q_mrr,
    ).toBe("unverified");
    // A name not t_…, a key it doesn't return, a column asked for that it doesn't return: each said.
    const bad = changed((x) => {
      x.datasets = {
        revenue: {
          connection: SOURCE,
          title: "R",
          sql: "select 1 as a from x",
          columns: [{ name: "a", type: "number" }],
        },
      } as never;
    });
    expect(
      problems(bad)
        .map((p) => p.path)
        .join(" "),
    ).toMatch(/datasets/);
    const keyless = changed((x) => {
      x.datasets = {
        t_r: {
          connection: SOURCE,
          title: "R",
          sql: "select a from x y",
          columns: [{ name: "a", type: "number" }],
          key: "b",
        },
      };
      x.queries.q_r = { source: { connection: SOURCE, dataset: "t_r" }, select: ["a", "zz"], filters: {} };
    });
    const said = problems(keyless)
      .map((p) => `${p.path}: ${p.message}`)
      .join("\n");
    expect(said).toMatch(/datasets\.t_r\.key: b isn't one of its columns/);
    expect(said).toMatch(/t_r has no column "zz"/);
  });

  it("grants a dashboard the columns its queries name, and no others", () => {
    expect(grantsOf(proof(), SOURCE)).toEqual({
      datasets: { accounts: { columns: ["started_at", "plan", "id", "name", "mrr", "created_at"] } },
    });
    expect(grantsOf(proof(), "0190a000-0000-7000-8000-0000000000c2")).toEqual({ datasets: {} });
  });
});

describe("a stored plan", () => {
  it("reads within its limits, each chart saying its type", async () => {
    const { Plan } = await import("../src/dashboard/plan");
    const plan = {
      title: "Revenue this month",
      purpose: "MRR for the weekly review",
      pages: [{ id: "p_overview", title: "Overview", sections: [{ id: "s_mrr", kind: "kpi", title: "MRR" }] }],
    };
    expect(Plan.safeParse(plan).success).toBe(true);
    const sections = Array.from({ length: 41 }, (_, i) => ({ id: `s_${i}`, kind: "kpi", title: `N ${i}` }));
    expect(Plan.safeParse({ ...plan, pages: [{ id: "p_all", title: "All", sections }] }).success).toBe(false);
    // A chart says its type: what's approved is what's compared.
    const untyped = Plan.safeParse({
      ...plan,
      pages: [{ id: "p_all", title: "All", sections: [{ id: "s_trend", kind: "chart", title: "Trend" }] }],
    });
    expect(untyped.success ? "" : JSON.stringify(untyped.error.issues)).toMatch(/say what kind/);
  });
});

describe("a filtered workflow", () => {
  const at = { now: new Date("2026-10-15T12:00:00Z"), tz: "UTC" };
  /** The proof with rows that filter, page and total, and a plan filter whose values come from the warehouse. */
  const workflow = (): Definition => {
    const d = structuredClone(proof());
    d.filters.f_plan = { kind: "select", label: "Plan", options: [], values: { from: "q_accounts" }, default: [] };
    Object.assign(d.queries.q_accounts as object, {
      rows: { conditions: true, pageSizes: [25, 100], totals: { mrr: "sum" } },
    });
    return d;
  };

  it("takes a picked range of days, and compares it with the days just before or the same days a year before", async () => {
    const { isPeriodValue, yearBeforeRange } = await import("../src/dashboard");
    expect(periodRange("2026-01-05..2026-02-10", at.now, "UTC")).toEqual({ from: "2026-01-05", to: "2026-02-11" });
    expect(previousRange("2026-01-05..2026-02-10", at.now, "UTC")).toEqual({ from: "2025-11-29", to: "2026-01-05" });
    expect(yearBeforeRange("2024-02-01..2024-02-29", at.now, "UTC")).toEqual({ from: "2023-02-01", to: "2023-03-01" });
    // One day keeps its day a year before (never an empty range).
    expect(yearBeforeRange("2024-02-28..2024-02-28", at.now, "UTC")).toEqual({ from: "2023-02-28", to: "2023-03-01" });
    expect(["2026-02-30..2026-03-01", "2026-03-01..2026-02-01", "2016-01-01..2026-01-01"].map(isPeriodValue)).toEqual([
      false,
      false,
      false,
    ]);
    const d = workflow();
    const q = d.queries.q_mrr as { compare?: string };
    q.compare = "previous_year";
    const bound = bindQuery(d, "q_mrr", { filters: { f_period: "2026-09" } }, at);
    expect(bound.previous?.where).toContainEqual(["started_at", ">=", "2025-09-01"]);
    expect(bound.previous?.where).toContainEqual(["started_at", "<", "2025-10-01"]);
  });

  it("takes a filter's values from the warehouse as bounded text, and one value where it takes one", () => {
    const d = workflow();
    expect(filterValues(d, { f_plan: ["Anything", "Else"] }).f_plan).toEqual(["Anything", "Else"]);
    expect(() => filterValues(d, { f_plan: ["x".repeat(201)] })).toThrow(/values of text/);
    (d.filters.f_plan as { multiple?: boolean }).multiple = false;
    expect(() => filterValues(d, { f_plan: ["A", "B"] })).toThrow(/takes one value/);
  });

  it("pages rows by a size they declare and narrows them by their columns, nothing else", () => {
    const d = workflow();
    const spec = bindQuery(
      d,
      "q_accounts",
      {
        pageSize: 100,
        page: 1,
        where: [
          ["plan", "in", ["Growth"]],
          ["mrr", ">=", 100],
          ["name", "contains", "acme"],
        ],
      },
      at,
    ).spec;
    expect(spec.page).toEqual({ size: 100, offset: 100 });
    expect(spec.where).toEqual(
      expect.arrayContaining([
        ["plan", "in", ["Growth"]],
        ["mrr", ">=", 100],
        ["name", "contains", "acme"],
      ]),
    );
    for (const [ask, why] of [
      [{ pageSize: 30 }, /doesn't page by 30/],
      [{ where: [["email", "in", ["a"]]] }, /doesn't list email/],
      [{ where: [["mrr", "like", "x"]] }, /isn't a condition/],
      [{ where: [["mrr", ">=", "lots"]] }, /number or a date/],
      [{ where: Array.from({ length: 9 }, () => ["mrr", ">=", 1]) }, /At most 8/],
    ] as const) {
      expect(() => bindQuery(d, "q_accounts", ask as never, at), String(why)).toThrow(why);
    }
    // Rows that don't declare conditions take none.
    expect(() => bindQuery(proof(), "q_accounts", { where: [["plan", "in", ["A"]]] }, at)).toThrow(
      /takes no conditions/,
    );
  });

  it("lists a filter's values and a column's counts without their own condition, and totals every row", async () => {
    const { bindFacet, bindLookup, bindTotals } = await import("../src/dashboard");
    const d = workflow();
    const lookup = bindLookup(d, "f_plan", { filters: { f_plan: ["Growth"] }, search: "gr" }, at);
    expect(lookup).toMatchObject({
      from: "accounts",
      measures: { n: ["count"] },
      by: ["plan"],
      sort: ["-n"],
      limit: 50,
    });
    expect(lookup.where).toContainEqual(["plan", "contains", "gr"]);
    expect(lookup.where).not.toContainEqual(["plan", "in", ["Growth"]]);
    const facet = bindFacet(
      d,
      "q_accounts",
      "plan",
      {
        where: [
          ["plan", "in", ["Scale"]],
          ["mrr", ">=", 5],
        ],
      },
      at,
    );
    expect(facet.where).toContainEqual(["mrr", ">=", 5]);
    expect(facet.where).not.toContainEqual(["plan", "in", ["Scale"]]);
    // A column named n: its count takes another name.
    const named = workflow();
    (named.queries.q_accounts as { select: string[] }).select.push("n");
    const counted = bindFacet(named, "q_accounts", "n", {}, at);
    expect(counted.measures).toEqual({ n_rows: ["count"] });
    expect(counted.sort).toEqual(["-n_rows"]);
    // A day's end: before the next midnight, on a column the query lists.
    expect(bindQuery(d, "q_accounts", { where: [["mrr", "<", 10]] }, at).spec.where).toContainEqual(["mrr", "<", 10]);
    const totals = bindTotals(d, "q_accounts", { where: [["mrr", ">=", 5]] }, at);
    expect(totals).toMatchObject({ from: "accounts", measures: { mrr: ["sum", "mrr"] } });
    expect(totals.where).toContainEqual(["mrr", ">=", 5]);
    expect(totals.page).toBeUndefined();
  });

  it("checks where a filter's values come from, and its totals", () => {
    const d = workflow();
    expect(problems(d)).toEqual([]);
    (d.filters.f_plan as { values?: { from: string } }).values = { from: "q_new2" };
    expect(problems(d)).toContainEqual({ path: "filters.f_plan.values.from", message: "There's no query q_new2." });
    const many = workflow();
    (many.filters.f_plan as { default: string[] }).default = Array.from({ length: 51 }, (_, i) => `v${i}`);
    expect(problems(many).map((p) => p.message)).toContain("At most 50 values, each at most 200 characters.");
    const e = workflow();
    Object.assign(e.queries.q_accounts as object, { rows: { totals: { name: "sum" } } });
    expect(problems(e).map((p) => p.message)).toContain("name isn't a number: only count totals it.");
  });
});

describe("a query's period", () => {
  it("is given with its answer, and the days it's compared with", () => {
    const at = { now: new Date("2026-10-15T12:00:00Z"), tz: "UTC" };
    const accounts = { connection: SOURCE, dataset: "accounts" };
    const d = changed((x) => {
      x.queries.q_total = { source: accounts, measures: { mrr: ["sum", "mrr"] }, filters: { f_period: "started_at" } };
      x.queries.q_by_month = {
        source: accounts,
        measures: { mrr: ["sum", "mrr"] },
        by: ["started_at:month"],
        filters: { f_period: "started_at" },
        compare: "previous_year",
      };
      x.queries.q_level = {
        source: accounts,
        measures: { mrr: ["sum", "mrr"] },
        by: ["started_at:month"],
        filters: {},
      };
    });
    expect(bindQuery(d, "q_total", { filters: { f_period: "2026-09" } }, at).periods).toEqual({
      now: { from: "2026-09-01", to: "2026-10-01" },
    });
    expect(bindQuery(d, "q_by_month", { filters: { f_period: "last_3_months" } }, at).periods).toEqual({
      now: { from: "2026-07-01", to: "2026-10-01" },
      before: { from: "2025-07-01", to: "2025-10-01" },
    });
    expect(bindQuery(d, "q_level", { filters: {} }, at).periods).toBeUndefined();
  });
});

describe("the record an App shows", () => {
  const at = { now: new Date("2026-10-15T12:00:00Z"), tz: "UTC" };
  const accounts = { connection: SOURCE, dataset: "accounts" };
  /** Accounts with a key and a search, a count of them, and an account's MRR and tickets drawn for the one shown. */
  const records = (): Definition => ({
    version: 2,
    title: "Renewals desk",
    filters: { f_plan: { kind: "select", label: "Plan", options: ["Starter", "Growth", "Scale"], default: [] } },
    queries: {
      q_accounts: {
        source: accounts,
        select: ["id", "name", "plan", "country", "mrr", "status"],
        sort: ["-mrr"],
        page: 25,
        search: true,
        key: "id",
        filters: { f_plan: "plan" },
      },
      q_count: { source: accounts, measures: { accounts: ["count"] }, filters: { f_plan: "plan" } },
      q_mrr: { source: accounts, measures: { mrr: ["sum", "mrr"] }, record: "id", filters: {} },
      q_tickets: {
        source: { connection: SOURCE, dataset: "tickets" },
        select: ["id", "subject", "status", "created_at"],
        sort: ["-created_at"],
        page: 10,
        record: "account_id",
        filters: {},
      },
    },
  });

  it("passes, each query drawn for a record or with a key", () => {
    expect(problems(records())).toEqual([]);
    const d = records();
    d.queries.q_tickets_n = {
      source: { connection: SOURCE, dataset: "tickets" },
      measures: { n: ["count"] },
      filters: {},
      drill: "q_tickets",
    };
    expect(problems(d).map((p) => p.message)).toContain(
      "q_tickets and q_tickets_n aren't drawn for a record alike: the rows a number opens are its record's.",
    );
  });

  it("opens a drill's rows for the record shown, never every record's", () => {
    const d = records();
    d.queries.q_open = {
      source: { connection: SOURCE, dataset: "tickets" },
      measures: { n: ["count"] },
      record: "account_id",
      filters: {},
      drill: "q_tickets",
    };
    expect(bindDrill(d, "q_open", { filters: {}, record: 7 }, at).where).toContainEqual(["account_id", "=", 7]);
    expect(() => bindDrill(d, "q_open", { filters: {} }, at)).toThrow(/drawn for a record: say which/);
    // A number drawn for a record opening a keyed list's rows: the number's own scope, never the list's key besides.
    Object.assign(d.queries.q_mrr as object, { drill: "q_accounts" });
    const where = bindDrill(d, "q_mrr", { filters: {}, record: 7 }, at).where ?? [];
    expect(where.filter((w) => w[0] === "id")).toEqual([["id", "=", 7]]);
    expect(problems(d)).toEqual([]);
  });

  it("binds the record shown wherever the query's filters go, and only for a query drawn for one or with a key", () => {
    const d = records();
    // A query drawn for a record runs only with a key; any other takes none.
    expect(() => bindQuery(d, "q_mrr", { filters: {} }, at)).toThrow(/drawn for a record: say which/);
    expect(bindQuery(d, "q_mrr", { filters: {}, record: 42 }, at).spec.where).toContainEqual(["id", "=", 42]);
    expect(bindQuery(d, "q_tickets", { filters: {}, record: "42" }, at).spec.where).toContainEqual([
      "account_id",
      "=",
      "42",
    ]);
    expect(() => bindQuery(d, "q_count", { filters: {}, record: 42 }, at)).toThrow(/isn't drawn for a record/);
    // A query with a key is its rows, or one record's when asked for one.
    expect(bindQuery(d, "q_accounts", { filters: {} }, at).spec.where ?? []).not.toContainEqual(["id", "=", 7]);
    expect(bindQuery(d, "q_accounts", { filters: { f_plan: ["Scale"] }, record: 7 }, at).spec.where).toEqual([
      ["id", "=", 7],
      ["plan", "in", ["Scale"]],
    ]);
    // A key is a number exactly as sent, or bounded text: never rounded, never long.
    expect(() => recordScope(d, "q_mrr", 2 ** 60)).toThrow(/A record's key/);
    expect(() => recordScope(d, "q_mrr", "x".repeat(201))).toThrow(/A record's key/);
    expect(() => recordScope(d, "q_mrr", "")).toThrow(/A record's key/);
  });

  it("searches rows in their own columns only, and nothing else", () => {
    const d = records();
    const spec = bindQuery(d, "q_accounts", { filters: {}, search: "acme" }, at).spec;
    expect(spec).toMatchObject({ search: "acme", searchIn: ["id", "name", "plan", "country", "mrr", "status"] });
    expect(() => bindQuery(d, "q_tickets", { filters: {}, record: 1, search: "x" }, at)).toThrow(/isn't searched/);
    expect(() => bindQuery(d, "q_count", { filters: {}, search: "x" }, at)).toThrow(/isn't searched/);
    expect(() => bindQuery(d, "q_accounts", { filters: {}, search: "x".repeat(101) }, at)).toThrow(
      /Search for some text/,
    );
    // Grants: the record's column, and search where a query asks for it.
    const grants = grantsOf(d, SOURCE).datasets;
    expect(grants.tickets?.columns).toContain("account_id");
    expect(grants.accounts?.search).toBe(true);
    expect(grants.tickets?.search).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { NamedQuery } from "../src/dashboard/definition";
import type { Range } from "../src/dashboard/periods";
import type { ColumnKind, WireResult } from "../src/protocol";
import {
  bucketIndex,
  bucketsOf,
  type ChartInput,
  type Drawn,
  drawChart,
  mix,
  nice,
  Palette,
} from "../src/runtime/charts";
import { fromWire } from "../src/runtime/data";

const theme = {
  series: ["#111111", "#222222", "#333333", "#444444", "#555555", "#666666"],
  ink: "#000000",
  muted: "#777777",
  rule: "#dddddd",
  surface: "#ffffff",
};

/** An answer of these rows: each column's kind read from its first value. */
function result(rows: Record<string, unknown>[], opts: { total?: number; period?: Range } = {}) {
  const names = Object.keys(rows[0] ?? {});
  const kindOf = (v: unknown): ColumnKind =>
    typeof v === "number" ? "number" : typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v) ? "date" : "text";
  const w: WireResult = {
    requestId: "r",
    dataset: "payments",
    columns: names.map((n) => ({
      name: n,
      kind: kindOf(rows[0]?.[n]),
      values: rows.map((r) => r[n] as number | string | null),
    })),
    rowCount: rows.length,
    total: opts.total ?? rows.length,
    truncated: (opts.total ?? rows.length) > rows.length,
    hidden: [],
    asOf: "2026-11-08T00:00:00.000Z",
  };
  return fromWire(w, opts.period);
}

const source = { connection: "00000000-0000-4000-8000-000000000001", dataset: "payments" };
const query = (q: Partial<NamedQuery>): NamedQuery => ({ source, filters: {}, ...q }) as NamedQuery;
const draw = (i: Partial<ChartInput> & Pick<ChartInput, "type" | "y" | "query" | "result">) =>
  drawChart({ format: "number", theme, colors: new Palette(), ...i });
const at = (iso: string) => `${iso}T00:00:00.000Z`;
/** The one chart a drawing has. */
const optionOf = (d: Drawn) => (d.panels[0] as Drawn["panels"][number]).option;

describe("buckets", () => {
  it("lays a period out at each grain, none missing", () => {
    expect(bucketsOf({ from: "2026-01-01", to: "2026-04-01" }, "month")).toEqual([
      "2026-01-01",
      "2026-02-01",
      "2026-03-01",
    ]);
    // A period starting mid-quarter: the quarter holding its first day comes first.
    expect(bucketsOf({ from: "2026-02-15", to: "2026-08-01" }, "quarter")).toEqual([
      "2026-01-01",
      "2026-04-01",
      "2026-07-01",
    ]);
    // Weeks start on Mondays: 2026-11-04 is a Wednesday.
    expect(bucketsOf({ from: "2026-11-04", to: "2026-11-18" }, "week")).toEqual([
      "2026-11-02",
      "2026-11-09",
      "2026-11-16",
    ]);
    expect(bucketsOf({ from: "2026-12-30", to: "2027-01-02" }, "day")).toEqual([
      "2026-12-30",
      "2026-12-31",
      "2027-01-01",
    ]);
    expect(bucketsOf({ from: "2024-07-01", to: "2026-07-01" }, "year")).toEqual([
      "2024-01-01",
      "2025-01-01",
      "2026-01-01",
    ]);
  });

  it("places a date in its bucket", () => {
    expect(bucketIndex("2026-03-01", "2025-11-01", "month")).toBe(4);
    expect(bucketIndex("2026-11-16", "2026-11-04", "week")).toBe(2);
    expect(bucketIndex("2027-01-01", "2026-12-30", "day")).toBe(2);
  });

  it("rounds a shared axis up and mixes colours", () => {
    expect([nice(0), nice(7), nice(18), nice(240), nice(3_100)]).toEqual([1, 10, 20, 250, 5_000]);
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mix("var(--x)", "#ffffff", 0.5)).toBe("var(--x)");
  });
});

describe("line, bar and area", () => {
  const period = { from: "2026-01-01", to: "2026-05-01" };
  const rows = [
    { paid_at_month: at("2026-01-01"), n: 3, avg_amount: 10 },
    { paid_at_month: at("2026-03-01"), n: 5, avg_amount: 12 },
    { paid_at_month: at("2026-04-01"), n: 2, avg_amount: 8 },
  ];
  const q = query({ measures: { n: ["count"], avg_amount: ["avg", "amount"] }, by: ["paid_at:month"] });

  it("runs along the period's buckets: a count's missing month is zero, an average's a gap", () => {
    const d = draw({
      type: "line",
      x: "paid_at_month",
      y: ["n", "avg_amount"],
      query: q,
      result: result(rows, { period }),
      periodColumn: "paid_at",
    });
    const series = (optionOf(d).series as { data: (number | null)[] }[]).map((s) => s.data);
    expect(series).toEqual([
      [3, 0, 5, 2],
      [10, null, 12, 8],
    ]);
    expect(d.table.rows[1]).toEqual(["Feb 2026", "0", "—"]);
    expect(d.legend.map((l) => l.name)).toEqual(["N", "Avg amount"]);
    expect(d.lanes[0]?.points[2]?.text).toBe("Mar 2026, N: 5");
    expect(d.pick(0, 0, 2)?.group).toEqual({ paid_at_month: at("2026-03-01") });
    // A month with no row opens nothing.
    expect(d.pick(0, 0, 1)).toBeNull();
  });

  it("draws the period before bucket for bucket, behind it", () => {
    const cq = query({ ...q, measures: { n: ["count"] }, compare: "previous_year" });
    const previous = result(
      [
        { paid_at_month: at("2025-02-01"), n: 4 },
        { paid_at_month: at("2025-04-01"), n: 1 },
      ],
      { period: { from: "2025-01-01", to: "2025-05-01" } },
    );
    const d = draw({
      type: "bar",
      x: "paid_at_month",
      y: ["n"],
      query: cq,
      result: result(rows, { period }),
      periodColumn: "paid_at",
      previous,
    });
    const series = optionOf(d).series as { name: string; data: (number | null)[]; barGap?: string }[];
    expect(series.map((s) => s.name)).toEqual(["Year before", "N"]);
    expect(series[0]?.data).toEqual([0, 4, 0, 1]);
    expect(series[1]?.barGap).toBe("-100%");
    expect(d.lanes).toHaveLength(1);
    expect(d.lanes[0]?.series).toBe(1);
    expect(d.lanes[0]?.points[1]?.text).toBe("Feb 2026, N: 0; year before: 4");
    // The ghost opens nothing.
    expect(d.pick(0, 0, 1)).toBeNull();
  });

  it("folds series past six into Other when the measure adds up and every row came back", () => {
    const plans = ["a", "b", "c", "d", "e", "f", "g", "h"];
    const rs = plans.flatMap((p, k) => [
      { paid_at_month: at("2026-01-01"), plan: p, n: 10 - k },
      { paid_at_month: at("2026-02-01"), plan: p, n: 10 - k },
    ]);
    const sq = query({ measures: { n: ["count"] }, by: ["paid_at:month", "plan"] });
    const d = draw({
      type: "bar",
      x: "paid_at_month",
      y: ["n"],
      series: "plan",
      stack: true,
      query: sq,
      result: result(rs),
    });
    const series = optionOf(d).series as { name: string; data: number[]; stack?: string }[];
    expect(series.map((s) => s.name)).toEqual(["a", "b", "c", "d", "e", "f", "Other"]);
    expect(series.at(-1)?.data).toEqual([4 + 3, 4 + 3]);
    expect(series.every((s) => s.stack === "all")).toBe(true);
    expect(d.notes).toEqual(["The 6 largest of 8 plan values; the rest as Other."]);
    expect(d.pick(0, 1, 0)?.group).toEqual({ paid_at_month: at("2026-01-01"), plan: "b" });
    expect(d.pick(0, 6, 0)).toBeNull();

    // An average doesn't add up: the rest are left out, and that's said.
    const aq = query({ measures: { n: ["avg", "amount"] }, by: ["paid_at:month", "plan"] });
    const avg = draw({ type: "line", x: "paid_at_month", y: ["n"], series: "plan", query: aq, result: result(rs) });
    expect((optionOf(avg).series as unknown[]).length).toBe(6);
    expect(avg.notes[0]).toMatch(/the rest left out \(n doesn't add up into Other\)/);

    // Rows past the cap: Other would undercount, so it isn't drawn.
    const cut = draw({
      type: "bar",
      x: "paid_at_month",
      y: ["n"],
      series: "plan",
      query: sq,
      result: result(rs, { total: 40 }),
    });
    expect((optionOf(cut).series as { name: string }[]).map((s) => s.name)).not.toContain("Other");
    expect(cut.notes).toContain("Only the first 16 of 40 rows came back.");
  });

  it("ranks the largest first, the rest as Other", () => {
    const rq = query({ measures: { revenue: ["sum", "amount"] }, by: ["country"] });
    const rs = ["DE", "FR", "US", "GB", "NL"].map((c, k) => ({
      country: c,
      revenue: [50, 10, 90, 30, 5][k] as number,
    }));
    const d = draw({ type: "bar", x: "country", y: ["revenue"], top: 3, query: rq, result: result(rs) });
    expect(d.table.rows).toEqual([
      ["US", "90"],
      ["DE", "50"],
      ["GB", "30"],
      ["Other", "15"],
    ]);
    expect(d.notes).toEqual(["The largest 3 of 5; the rest as Other."]);
    expect((optionOf(d).yAxis as { inverse?: boolean }).inverse).toBe(true);
    expect(d.pick(0, 0, 3)).toBeNull();
    expect(d.pick(0, 0, 0)?.group).toEqual({ country: "US" });
  });

  it("reads dates that came without a grain as dates: months when each is a month's first day", () => {
    const rq = query({ measures: { n: ["count"] }, by: ["month_start"] });
    const months = ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"];
    const d = draw({
      type: "bar",
      x: "month_start",
      y: ["n"],
      query: rq,
      result: result(months.map((m, k) => ({ month_start: m, n: k + 1 }))),
    });
    const labels = d.table.rows.map((r) => r[0]);
    // No timestamp on the axis; the month without rows (March) is on it too.
    expect(labels.join(" ")).not.toContain("T00:00");
    expect(labels).toHaveLength(4);
  });

  it("cuts a long bar name at a fixed width and leaves out axis numbers that would touch", () => {
    const rq = query({ measures: { n: ["count"] }, by: ["use_case"] });
    const rs = ["Grid + Commodity + Non-Commodity", "Grid"].map((u, k) => ({ use_case: u, n: [3, 90][k] as number }));
    const d = draw({ type: "bar", x: "use_case", y: ["n"], top: 5, query: rq, result: result(rs) });
    const option = optionOf(d);
    const names = (option.yAxis as { axisLabel: Record<string, unknown> }).axisLabel;
    expect(names).toMatchObject({ width: 160, overflow: "truncate", hideOverlap: true });
    expect((option.xAxis as { axisLabel: Record<string, unknown> }).axisLabel.hideOverlap).toBe(true);
  });
});

describe("colours follow the series", () => {
  it("keeps a series' colour while it's drawn; a new one takes a free colour", () => {
    const p = new Palette();
    expect(p.assign(["a", "b", "c"])).toEqual([0, 1, 2]);
    // "b" is filtered out: "a" and "c" keep theirs, "d" takes the first free one.
    expect(p.assign(["c", "a", "d"])).toEqual([2, 0, 1]);
    expect(p.assign(["b", "c"])).toEqual([1, 2]);
  });
});

describe("small multiples", () => {
  it("draws one chart per value on one scale, the largest twelve", () => {
    const countries = Array.from({ length: 14 }, (_, k) => `c${k}`);
    const rs = countries.flatMap((c, k) => [
      { paid_at_month: at("2026-01-01"), country: c, n: 14 - k },
      { paid_at_month: at("2026-02-01"), country: c, n: 2 * (14 - k) },
    ]);
    const q = query({ measures: { n: ["count"] }, by: ["paid_at:month", "country"] });
    const d = draw({ type: "line", x: "paid_at_month", y: ["n"], facet: "country", query: q, result: result(rs) });
    expect(d.panels).toHaveLength(12);
    expect(d.panels[0]?.title).toBe("c0");
    expect(d.panels.map((p) => (p.option.yAxis as { max: number }).max)).toEqual(Array(12).fill(50));
    expect(d.notes).toEqual(["The 12 largest of 14 country values."]);
    expect(d.lanes[1]?.points[1]?.text).toBe("c1, Feb 2026: 26");
    expect(d.pick(1, 0, 1)?.group).toEqual({ paid_at_month: at("2026-02-01"), country: "c1" });
  });
});

describe("the other kinds", () => {
  it("scatter: each thing a point; one without both numbers left out", () => {
    const q = query({ measures: { mrr: ["sum", "mrr"], seats: ["sum", "seats"] }, by: ["account"] });
    const rs = [
      { account: "Acme", mrr: 900, seats: 30 },
      { account: "Globex", mrr: 300, seats: null },
      { account: "Initech", mrr: 100, seats: 5 },
    ];
    const d = draw({ type: "scatter", x: "seats", y: ["mrr"], label: "account", query: q, result: result(rs) });
    expect(d.points).toBe(2);
    expect(d.notes).toEqual(["1 point without both numbers left out."]);
    expect(d.lanes[0]?.points.map((p) => p.text)).toEqual(["Initech: seats 5, mrr 100", "Acme: seats 30, mrr 900"]);
    expect(d.pick(0, 0, 0)?.group).toEqual({ account: "Acme" });
  });

  it("scatter: named zones and quadrant lines, each zone's points said", () => {
    const q = query({ measures: { mrr: ["sum", "mrr"], seats: ["sum", "seats"] }, by: ["account"] });
    const rs = [
      { account: "Acme", mrr: 900, seats: 3 },
      { account: "Initech", mrr: 100, seats: 50 },
      { account: "Umbrella", mrr: 800, seats: 5 },
    ];
    const d = draw({
      type: "scatter",
      x: "seats",
      y: ["mrr"],
      label: "account",
      query: q,
      result: result(rs),
      zones: [{ x: [0, 10], y: [500, 1000], label: "Pays a lot, uses little", tone: "bad" }],
      split: { x: 10, y: 500 },
    });
    expect(d.notes).toEqual(["Pays a lot, uses little: 2 points."]);
    const series = (optionOf(d).series as Record<string, unknown>[])[0] as {
      markArea?: { data: unknown[] };
      markLine?: { data: unknown[] };
    };
    expect(series.markArea?.data).toHaveLength(1);
    expect(series.markLine?.data).toEqual([{ xAxis: 10 }, { yAxis: 500 }]);
  });

  it("bullet: a value against a number or another measure", () => {
    const q = query({ measures: { won: ["sum", "amount"], quota: ["sum", "quota"] }, by: ["owner"] });
    const rs = [
      { owner: "Ana", won: 80, quota: 100 },
      { owner: "Ben", won: 120, quota: 100 },
    ];
    const d = draw({ type: "bullet", x: "owner", y: ["won"], target: "quota", query: q, result: result(rs) });
    expect(d.table.rows).toEqual([
      ["Ana", "80", "100", "80%"],
      ["Ben", "120", "100", "120%"],
    ]);
    expect(d.legend.map((l) => l.name)).toEqual(["Won", "Target"]);
    const one = draw({
      type: "bullet",
      y: ["won"],
      target: 200,
      title: "Won this month",
      query: query({ measures: { won: ["sum", "amount"] } }),
      result: result([{ won: 150 }]),
    });
    expect(one.lanes[0]?.points[0]?.text).toBe("Won this month: 150, 75% of the 200 target");
  });

  it("calendar: a period's days, a blank day told from a zero, a long period cut to a year", () => {
    const q = query({ measures: { n: ["count"] }, by: ["paid_at:day"] });
    const rs = [
      { paid_at_day: at("2026-10-01"), n: 3 },
      { paid_at_day: at("2026-10-02"), n: 0 },
      { paid_at_day: at("2026-10-04"), n: 7 },
    ];
    const d = draw({
      type: "calendar",
      x: "paid_at_day",
      y: ["n"],
      query: q,
      result: result(rs, { period: { from: "2026-10-01", to: "2026-10-06" } }),
      periodColumn: "paid_at",
    });
    expect(d.table.rows).toEqual([
      ["Oct 1, 2026", "3"],
      ["Oct 2, 2026", "0"],
      ["Oct 3, 2026", "No rows"],
      ["Oct 4, 2026", "7"],
      ["Oct 5, 2026", "No rows"],
    ]);
    expect(d.points).toBe(3);
    expect(d.notes[0]).toBe("2 days with no rows are left blank; a zero is the lightest shade.");
    expect(d.lanes[0]?.points.map((p) => p.index)).toEqual([0, 1, -1, 2, -1]);
    const long = draw({
      type: "calendar",
      x: "paid_at_day",
      y: ["n"],
      query: q,
      result: result(rs, { period: { from: "2024-01-01", to: "2026-11-01" } }),
      periodColumn: "paid_at",
    });
    expect(long.table.rows).toHaveLength(366);
    expect(long.notes[0]).toBe("The last 366 days of the period.");
  });

  it("funnel: stages in order, each one's share of the first; cumulative counts the later ones in", () => {
    const q = query({ measures: { n: ["count"] }, by: ["stage"] });
    const rs = [
      { stage: "paid", n: 20 },
      { stage: "trial", n: 50 },
      { stage: "lead", n: 30 },
      { stage: "lost", n: 9 },
    ];
    const d = draw({
      type: "funnel",
      x: "stage",
      y: ["n"],
      stages: ["lead", "trial", "paid"],
      cumulative: true,
      query: q,
      result: result(rs),
    });
    expect(d.table.rows).toEqual([
      ["lead", "100", "100%", "—"],
      ["trial", "70", "70%", "70%"],
      ["paid", "20", "20%", "28.6%"],
    ]);
    expect(d.notes).toEqual([
      "Each stage counts those at it or a later one.",
      "1 stage value outside the stages left out.",
    ]);
    // A stage counting the later ones in opens nothing (its own rows aren't all it counts).
    expect(d.pick(0, 0, 1)).toBeNull();
    const own = draw({
      type: "funnel",
      x: "stage",
      y: ["n"],
      stages: ["lead", "trial", "paid"],
      query: q,
      result: result(rs),
    });
    expect(own.pick(0, 0, 1)?.group).toEqual({ stage: "trial" });
  });

  it("treemap: parts of a whole, two deep, the seventh outer group on in grey", () => {
    const q = query({ measures: { revenue: ["sum", "amount"] }, by: ["region", "country"] });
    const rs = [
      ...["r1", "r2", "r3", "r4", "r5", "r6", "r7"].map((r, k) => ({ region: r, country: `${r}-a`, revenue: 70 - k })),
      { region: "r1", country: "r1-b", revenue: 30 },
      { region: "r2", country: "r2-b", revenue: -5 },
    ];
    const d = draw({ type: "treemap", x: "region", y: ["revenue"], query: q, result: result(rs) });
    const data =
      (
        optionOf(d).series as {
          data: { name: string; value: number; itemStyle: { color: string }; children: unknown[] }[];
        }[]
      )[0]?.data ?? [];
    expect(data[0]).toMatchObject({ name: "r1", value: 100 });
    expect(data[0]?.children).toHaveLength(2);
    expect(data[6]?.itemStyle.color).toBe(mix(theme.muted, theme.surface, 0.5));
    expect(d.notes[0]).toBe("1 group of zero or less left out: a treemap's areas are parts of a whole.");
    expect(d.legend.at(-1)?.name).toBe("The rest");
    expect(d.lanes[0]?.points[0]?.text).toBe("r1 › r1-a: 70, 14% of all");
  });

  it("waterfall: the start, each period's change, the end", () => {
    const q = query({ measures: { mrr: ["sum", "mrr"] }, by: ["month:month"] });
    const rs = [
      { month_month: at("2026-01-01"), mrr: 100 },
      { month_month: at("2026-02-01"), mrr: 130 },
      { month_month: at("2026-03-01"), mrr: 110 },
    ];
    const d = draw({ type: "waterfall", x: "month_month", y: ["mrr"], query: q, result: result(rs) });
    const series = optionOf(d).series as { name: string; data: (number | null)[] }[];
    expect(series.map((s) => s.data)).toEqual([
      [0, 100, 110, 0],
      [100, null, null, 110],
      [null, 30, null, null],
      [null, null, 20, null],
    ]);
    expect(d.lanes[0]?.points.map((p) => p.text)).toEqual([
      "Jan 2026: 100",
      "Feb 2026: up 30, to 130",
      "Mar 2026: down 20, to 110",
      "End, Mar 2026: 110",
    ]);
    expect(d.table.rows[2]).toEqual(["Mar 2026", "110", "-20"]);
  });
});

describe("what a review of the charts found", () => {
  const q = query({ measures: { n: ["count"] }, by: ["created_at:month"] });
  const period = { from: "2026-01-01", to: "2026-04-01" };
  const rows = [
    { created_at_month: at("2026-01-01"), n: 3 },
    { created_at_month: at("2026-03-01"), n: 5 },
  ];
  const seriesOf = (d: Drawn) => (optionOf(d).series as { name: string; data: (number | null)[] }[]).map((s) => s.data);

  it("runs along the period only when the period narrows the date it's grouped by", () => {
    // The period narrows solved_at; the chart is by created_at: from the first month that came back to the last, an
    // empty month between them a zero (a whole answer of a count), never the period's months.
    const other = draw({
      type: "line",
      x: "created_at_month",
      y: ["n"],
      query: q,
      result: result(rows, { period }),
      periodColumn: "solved_at",
    });
    expect(seriesOf(other)).toEqual([[3, 0, 5]]);
    const same = draw({
      type: "line",
      x: "created_at_month",
      y: ["n"],
      query: q,
      result: result(rows, { period }),
      periodColumn: "created_at",
    });
    expect(seriesOf(same)).toEqual([[3, 0, 5]]);
  });

  it("keeps empty months on the axis when no period narrows it (no jump from 2021 to 2024)", () => {
    const sparse = draw({
      type: "bar",
      x: "created_at_month",
      y: ["n"],
      query: q,
      result: result([
        { created_at_month: "2021-03-01", n: 1 },
        { created_at_month: "2021-06-01", n: 4 },
      ]),
    });
    expect(seriesOf(sparse)).toEqual([[1, 0, 0, 4]]);
  });

  it("makes no zeros up when rows were cut", () => {
    const cut = draw({
      type: "line",
      x: "created_at_month",
      y: ["n"],
      query: q,
      result: result(rows, { period, total: 3 }),
      periodColumn: "created_at",
    });
    expect(seriesOf(cut)).toEqual([[3, null, 5]]);
    const stages = query({ measures: { n: ["count"] }, by: ["stage"] });
    const f = draw({
      type: "funnel",
      x: "stage",
      y: ["n"],
      stages: ["lead", "trial", "paid"],
      cumulative: true,
      query: stages,
      result: result(
        [
          { stage: "lead", n: 9 },
          { stage: "paid", n: 2 },
        ],
        { total: 3 },
      ),
    });
    // Not cumulative, and the stage that didn't come back isn't a zero.
    expect(f.table.rows.map((r) => r[1])).toEqual(["9", "—", "2"]);
    expect(f.notes[0]).toBe("Not every row came back, so each stage is counted on its own.");
  });

  it("lines the same days a year before up by the calendar, over a leap day", () => {
    const daily = query({ measures: { n: ["count"] }, by: ["paid_at:day"], compare: "previous_year" });
    const now = { from: "2024-02-27", to: "2024-03-03" };
    const before = { from: "2023-02-27", to: "2023-03-03" };
    const d = draw({
      type: "line",
      x: "paid_at_day",
      y: ["n"],
      query: daily,
      result: result([{ paid_at_day: at("2024-02-29"), n: 1 }], { period: now }),
      previous: result([{ paid_at_day: at("2023-03-01"), n: 7 }], { period: before }),
      periodColumn: "paid_at",
    });
    // Feb 27, 28, 29, Mar 1, 2 of 2024: last year's 1 March lands on this year's 1 March, not on the 29th.
    expect(seriesOf(d)[0]).toEqual([0, 0, 0, 7, 0]);
  });

  it("says why there's no ghost for a shape it can't line up", () => {
    const two = query({
      measures: { n: ["count"], m: ["sum", "amount"] },
      by: ["created_at:month"],
      compare: "previous_period",
    });
    const d = draw({
      type: "line",
      x: "created_at_month",
      y: ["n", "m"],
      query: two,
      result: result(
        rows.map((r) => ({ ...r, m: 1 })),
        { period },
      ),
      previous: result(
        rows.map((r) => ({ ...r, m: 1 })),
        { period: { from: "2025-10-01", to: "2026-01-01" } },
      ),
      periodColumn: "created_at",
    });
    expect(seriesOf(d)).toHaveLength(2);
    expect(d.notes).toContain(
      "The period before isn't drawn here: it's drawn for one measure along the date its period filter narrows.",
    );
  });

  it("keeps an empty value, an empty text and a missing one apart, and never ranks a missing number as zero", () => {
    const g = query({ measures: { n: ["avg", "amount"] }, by: ["country"] });
    const d = draw({
      type: "bar",
      x: "country",
      y: ["n"],
      top: 5,
      query: g,
      result: result([
        { country: "DE", n: -2 },
        { country: null, n: null },
        { country: "", n: 5 },
        { country: "(none)", n: 1 },
      ]),
    });
    expect(d.table.rows).toEqual([
      ["(empty)", "5"],
      ["(none)", "1"],
      ["DE", "-2"],
      ["(none)", "—"],
    ]);
  });

  it("draws below zero when a value is, in small charts and bullets", () => {
    const facets = query({ measures: { n: ["sum", "amount"] }, by: ["created_at:month", "country"] });
    const m = draw({
      type: "bar",
      x: "created_at_month",
      y: ["n"],
      facet: "country",
      query: facets,
      result: result([
        { created_at_month: at("2026-01-01"), country: "DE", n: -5 },
        { created_at_month: at("2026-01-01"), country: "FR", n: 30 },
      ]),
    });
    expect(optionOf(m).yAxis).toMatchObject({ min: -5, max: 50 });
    const b = draw({
      type: "bullet",
      y: ["n"],
      target: 10,
      query: query({ measures: { n: ["sum", "amount"] } }),
      result: result([{ n: -40 }]),
    });
    expect((optionOf(b).xAxis as { min: number }).min).toBeLessThan(-40);
  });

  it("keeps a series' colour while it stays drawn, whoever comes back", () => {
    const p = new Palette();
    p.assign(["a", "b"]);
    expect(p.assign(["b", "c"])).toEqual([1, 0]);
    // "c" stayed: it keeps its colour; "a" comes back to the one that's free.
    expect(p.assign(["a", "c"])).toEqual([1, 0]);
  });

  it("opens rows only where a series has a row", () => {
    const sq = query({ measures: { n: ["count"] }, by: ["created_at:month", "plan"] });
    const d = draw({
      type: "bar",
      x: "created_at_month",
      y: ["n"],
      series: "plan",
      query: sq,
      result: result(
        [
          { created_at_month: at("2026-01-01"), plan: "a", n: 4 },
          { created_at_month: at("2026-02-01"), plan: "b", n: 2 },
        ],
        { period: { from: "2026-01-01", to: "2026-03-01" } },
      ),
      periodColumn: "created_at",
    });
    // a has January, not February (a zero filled in): only January opens.
    expect(d.pick(0, 0, 0)?.group).toEqual({ created_at_month: at("2026-01-01"), plan: "a" });
    expect(d.pick(0, 0, 1)).toBeNull();
  });

  it("says a partial treemap's shares are of what's shown, and builds its table from the values", () => {
    const tq = query({ measures: { n: ["sum", "amount"] }, by: ["region", "team"] });
    const d = draw({
      type: "treemap",
      x: "region",
      y: ["n"],
      query: tq,
      result: result([{ region: "Acme › east", team: "a", n: 10 }], { total: 4 }),
    });
    expect(d.table.head).toEqual(["Region", "Team", "N", "Share of those shown"]);
    expect(d.table.rows[0]).toEqual(["Acme › east", "a", "10", "100%"]);
    expect(d.lanes[0]?.points[0]?.text).toBe("Acme › east › a: 10, 100% of those shown");
  });
});

describe("what the verification of the fixes found", () => {
  const seriesOf = (d: Drawn) => (optionOf(d).series as { name: string; data: (number | null)[] }[]).map((s) => s.data);

  it("keeps a NULL the period before had, and lines a one-day 29 February up with the 28th before", () => {
    const monthly = query({ measures: { n: ["sum", "amount"] }, by: ["paid_at:month"], compare: "previous_period" });
    const d = draw({
      type: "line",
      x: "paid_at_month",
      y: ["n"],
      query: monthly,
      result: result([{ paid_at_month: at("2026-02-01"), n: 4 }], { period: { from: "2026-01-01", to: "2026-03-01" } }),
      previous: result(
        [
          { paid_at_month: at("2025-11-01"), n: null },
          { paid_at_month: at("2025-12-01"), n: 3 },
        ],
        { period: { from: "2025-11-01", to: "2026-01-01" } },
      ),
      periodColumn: "paid_at",
    });
    expect(seriesOf(d)[0]).toEqual([null, 3]);
    const daily = query({ measures: { n: ["count"] }, by: ["paid_at:day"], compare: "previous_year" });
    const leap = draw({
      type: "bar",
      x: "paid_at_day",
      y: ["n"],
      query: daily,
      result: result([{ paid_at_day: at("2024-02-29"), n: 2 }], { period: { from: "2024-02-29", to: "2024-03-01" } }),
      previous: result([{ paid_at_day: at("2023-02-28"), n: 7 }], { period: { from: "2023-02-28", to: "2023-03-01" } }),
      periodColumn: "paid_at",
    });
    expect(seriesOf(leap)[0]).toEqual([7]);
  });

  it("matches a funnel's stages by their text, and a run of unknown stages isn't a zero", () => {
    const q = query({ measures: { n: ["count"] }, by: ["step"] });
    const d = draw({
      type: "funnel",
      x: "step",
      y: ["n"],
      stages: ["1", "2"],
      query: q,
      result: result([
        { step: 1, n: 8 },
        { step: 2, n: 3 },
      ]),
    });
    expect(d.table.rows.map((r) => r[1])).toEqual(["8", "3"]);
    expect(d.pick(0, 0, 1)?.group).toEqual({ step: 2 });
    const sums = query({ measures: { n: ["sum", "amount"] }, by: ["stage"] });
    const unknown = draw({
      type: "funnel",
      x: "stage",
      y: ["n"],
      stages: ["a", "b"],
      cumulative: true,
      query: sums,
      result: result([
        { stage: "a", n: 5 },
        { stage: "b", n: null },
      ]),
    });
    expect(unknown.table.rows.map((r) => r[1])).toEqual(["5", "—"]);
  });

  it("draws Other as unknown when nothing past the top is known", () => {
    const q = query({ measures: { n: ["sum", "amount"] }, by: ["country"] });
    const d = draw({
      type: "bar",
      x: "country",
      y: ["n"],
      top: 3,
      query: q,
      result: result([
        { country: "DE", n: 9 },
        { country: "FR", n: 5 },
        { country: "US", n: 2 },
        { country: "NL", n: null },
      ]),
    });
    expect(d.table.rows.at(-1)).toEqual(["Other", "—"]);
  });

  it("keeps a group's colour by what it is, not how it reads", () => {
    const q = query({ measures: { n: ["count"] }, by: ["created_at:month", "plan"] });
    const p = new Palette();
    const rows = (plans: (string | null)[]) =>
      result(plans.map((plan, k) => ({ created_at_month: at("2026-01-01"), plan, n: 10 - k })));
    const colours = (plans: (string | null)[]) => {
      const d = drawChart({
        type: "bar",
        x: "created_at_month",
        y: ["n"],
        series: "plan",
        format: "number",
        theme,
        colors: p,
        query: q,
        result: rows(plans),
      });
      return (optionOf(d).series as { name: string; itemStyle: { color: string } }[]).map((s) => [
        s.name,
        s.itemStyle.color,
      ]);
    };
    const before = colours([null, "(none)"]);
    // The text "(none)" goes: the missing plan keeps its colour.
    expect(colours([null])[0]).toEqual(before[0]);
  });
});

describe("more charts: heatmap, sankey, timeline, box plot", () => {
  it("a heatmap crosses two groupings, one hue light to dark, and opens the cell's rows", () => {
    const rows = ["US", "DE"].flatMap((country, a) =>
      ["starter", "growth", "scale"].map((plan, b) => ({ country, plan, mrr: (a + 1) * (b + 1) * 100 })),
    );
    const d = draw({
      type: "heatmap",
      x: "country",
      series: "plan",
      y: ["mrr"],
      query: query({ measures: { mrr: ["sum", "mrr"] }, by: ["country", "plan"] }),
      result: result(rows),
    });
    expect(d.points).toBe(6);
    const o = optionOf(d) as { xAxis: { data: string[] }; yAxis: { data: string[] } };
    // Values largest first on each side.
    expect(o.xAxis.data).toEqual(["DE", "US"]);
    expect(o.yAxis.data).toEqual(["scale", "growth", "starter"]);
    expect(d.pick(0, 0, 0)?.group).toMatchObject({ country: expect.any(String), plan: expect.any(String) });
  });

  it("a sankey keeps a value that's on both sides as two ends, and leaves zero flows out, saying so", () => {
    const d = draw({
      type: "sankey",
      x: "from_plan",
      series: "to_plan",
      y: ["n"],
      query: query({ measures: { n: ["count"] }, by: ["from_plan", "to_plan"] }),
      result: result([
        { from_plan: "starter", to_plan: "growth", n: 12 },
        { from_plan: "starter", to_plan: "starter", n: 40 },
        { from_plan: "growth", to_plan: "scale", n: 0 },
      ]),
    });
    expect(d.points).toBe(2);
    const series = (
      optionOf(d) as { series: { data: { name: string }[]; links: { source: string; target: string }[] }[] }
    ).series[0];
    const names = series?.data.map((n) => n.name) ?? [];
    expect(new Set(names).size).toBe(names.length);
    expect(series?.links.some((l) => l.source === "starter" && l.target.startsWith("starter"))).toBe(true);
    expect(d.notes.join(" ")).toContain("zero or less");
  });

  it("a timeline sorts by start, runs an open one to today lighter, and says so", () => {
    const d = draw({
      type: "timeline",
      x: "name",
      y: ["start_on", "end_on"],
      query: query({ select: ["name", "start_on", "end_on"] }),
      result: result([
        { name: "B", start_on: at("2026-09-01"), end_on: at("2026-10-01") },
        { name: "A", start_on: at("2026-08-01"), end_on: null },
      ]),
    });
    expect(d.table.rows.map((r) => r[0])).toEqual(["A", "B"]);
    expect(d.table.rows[0]?.[2]).toBe("Not yet");
    expect(d.notes.join(" ")).toContain("no end yet");
  });

  it("a box plot works out each group's quartiles from its rows, and names what's outside", () => {
    const values = [10, 12, 13, 14, 15, 16, 18, 200];
    const d = draw({
      type: "boxplot",
      x: "plan",
      y: ["mrr"],
      query: query({ select: ["plan", "mrr"] }),
      result: result(values.map((mrr) => ({ plan: "growth", mrr }))),
    });
    const box = (optionOf(d) as { series: { data: number[][] }[] }).series[0]?.data[0] ?? [];
    expect(box[2]).toBe(14.5);
    // 200 is past the whiskers: a dot, not the box's top.
    expect(box[4]).toBeLessThan(200);
    expect(((optionOf(d) as { series: { data: number[][] }[] }).series[1]?.data ?? []).map((p) => p[1])).toEqual([200]);
  });
});

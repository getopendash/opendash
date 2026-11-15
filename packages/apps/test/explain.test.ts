// Charts that explain: a target line, a normal band and the moments that explain a change, on the
// chart itself; the period still running drawn lighter and said; small multiples each on their own scale when asked.
import { describe, expect, it } from "vitest";
import type { NamedQuery } from "../src/dashboard/definition";
import type { WireResult } from "../src/protocol";
import { type ChartInput, type Drawn, drawChart, Palette } from "../src/runtime/charts";
import { fromWire } from "../src/runtime/data";

const theme = { series: ["#111111", "#222222"], ink: "#000000", muted: "#777777", rule: "#dddddd", surface: "#ffffff" };
const query = (q: Partial<NamedQuery>): NamedQuery =>
  ({
    source: { connection: "00000000-0000-4000-8000-000000000001", dataset: "payments" },
    filters: {},
    ...q,
  }) as NamedQuery;
const result = (rows: Record<string, unknown>[]) => {
  const names = Object.keys(rows[0] ?? {});
  const w: WireResult = {
    requestId: "r",
    dataset: "payments",
    columns: names.map((n) => ({
      name: n,
      kind: typeof rows[0]?.[n] === "number" ? "number" : String(rows[0]?.[n]).includes("T00") ? "date" : "text",
      values: rows.map((r) => r[n] as number | string | null),
    })),
    rowCount: rows.length,
    total: rows.length,
    truncated: false,
    hidden: [],
    asOf: "",
  };
  return fromWire(w);
};
const draw = (i: Partial<ChartInput> & Pick<ChartInput, "type" | "y" | "query" | "result">) =>
  drawChart({ format: "number", theme, colors: new Palette(), ...i });
const optionOf = (d: Drawn) => (d.panels[0] as Drawn["panels"][number]).option;
const month = (d: Date) => `${d.toISOString().slice(0, 7)}-01T00:00:00.000Z`;

describe("a chart that explains", () => {
  const q = query({ measures: { n: ["count"] }, by: ["paid_at:month"] });
  const now = new Date();
  const before = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const rows = [
    { paid_at_month: month(before), n: 40 },
    { paid_at_month: month(now), n: 12 },
  ];

  it("draws its target, its band and its moments, and the month still running lighter", () => {
    const d = draw({
      type: "bar",
      x: "paid_at_month",
      y: ["n"],
      query: q,
      result: result(rows),
      lines: [{ y: 30, label: "Target" }],
      band: { from: 20, to: 35, label: "Normal" },
      events: [{ at: month(before).slice(0, 7), say: "Price change" }],
    });
    const [first] = optionOf(d).series as Record<string, unknown>[];
    const marks = ((first ?? {}).markLine as { data: Record<string, unknown>[] }).data;
    expect(marks).toEqual([
      expect.objectContaining({ yAxis: 30, label: expect.objectContaining({ formatter: "Target" }) }),
      expect.objectContaining({ xAxis: 0, label: expect.objectContaining({ formatter: "Price change" }) }),
    ]);
    expect(((first ?? {}).markArea as { data: unknown[] }).data).toEqual([[{ yAxis: 20 }, { yAxis: 35 }]]);
    const data = first?.data as unknown[];
    expect(data[0]).toBe(40);
    expect(data[1]).toMatchObject({ value: 12, itemStyle: { opacity: 0.45 } });
    expect(d.notes.join(" ")).toMatch(/isn't over: it's drawn lighter/);
  });

  it("places a day inside its month, and says every mark in words", () => {
    const d = draw({
      type: "bar",
      x: "paid_at_month",
      y: ["n"],
      query: q,
      result: result(rows),
      lines: [{ y: 30, label: "Target" }],
      band: { from: 20, to: 35, label: "Normal" },
      events: [{ at: `${month(before).slice(0, 7)}-14`, say: "Price change" }],
    });
    const [first] = optionOf(d).series as Record<string, unknown>[];
    expect(((first ?? {}).markLine as { data: Record<string, unknown>[] }).data[1]).toMatchObject({ xAxis: 0 });
    expect(d.notes).toEqual(expect.arrayContaining(["Target: 30.", "Normal: 20 to 35."]));
    expect(d.notes.join(" ")).toMatch(/Price change: /);
  });

  it("says a moment outside its dates, rather than drawing it nowhere", () => {
    const d = draw({
      type: "line",
      x: "paid_at_month",
      y: ["n"],
      query: q,
      result: result(rows),
      events: [{ at: "2019-01", say: "Launch" }],
    });
    expect(d.notes.join(" ")).toContain('"Launch" (2019-01) is outside the dates shown.');
  });
});

describe("small multiples", () => {
  const q = query({ measures: { n: ["count"] }, by: ["paid_at:month", "team"] });
  const rows = [
    { paid_at_month: "2026-01-01T00:00:00.000Z", team: "Big", n: 900 },
    { paid_at_month: "2026-02-01T00:00:00.000Z", team: "Big", n: 1000 },
    { paid_at_month: "2026-01-01T00:00:00.000Z", team: "Small", n: 3 },
    { paid_at_month: "2026-02-01T00:00:00.000Z", team: "Small", n: 9 },
  ];
  const axes = (d: Drawn) => d.panels.map((p) => (p.option.yAxis as { max: number }).max);

  it("share one scale by default, and each its own when asked, said under them", () => {
    const shared = draw({ type: "line", x: "paid_at_month", y: ["n"], facet: "team", query: q, result: result(rows) });
    expect(new Set(axes(shared)).size).toBe(1);
    const own = draw({
      type: "line",
      x: "paid_at_month",
      y: ["n"],
      facet: "team",
      scale: "own",
      query: q,
      result: result(rows),
    });
    const [big, small] = axes(own);
    expect(small).toBeLessThan(big as number);
    expect(own.notes).toContain("Each on its own scale: compare their shapes, not their sizes.");
  });
});

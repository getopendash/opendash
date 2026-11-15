// Trends v0: a metric's month-on-month change that moved and stayed moved, against the months before it.
import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "../src/checks/detect";
import { trendRate, trendShift, trendTitle } from "../src/checks/trend";

const months = (values: (number | null)[], from = "2025-12-01"): SeriesPoint[] =>
  values.map((value, row) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + row);
    return { period: d.toISOString().slice(0, 10), value, row };
  });
/** A series growing by each rate in turn, from 1,000. */
const grow = (rates: number[]) => {
  const xs = [1000];
  for (const r of rates) xs.push(Math.round((xs.at(-1) as number) * (1 + r) * 100) / 100);
  return xs;
};
const WOBBLE = [0, 1, -1];
const steady = (r: number, n = 6, wobble = 0.002) =>
  Array.from({ length: n }, (_, i) => r + wobble * (WOBBLE[i % 3] ?? 0));

describe("trendShift", () => {
  it("finds growth that slowed and stayed slow, from the month it began", () => {
    const t = trendShift(months(grow([...steady(0.06), 0.025, 0.026, 0.024])));
    expect(t).toMatchObject({
      direction: "down",
      relative: true,
      since: "2026-07-01",
      months: 3,
      latest: { period: "2026-09-01", row: 9 },
      severity: 2,
    });
    expect(t?.before).toBeCloseTo(0.06, 2);
    expect(t?.recent).toBeCloseTo(0.025, 2);
    expect(t && trendTitle("New accounts", t)).toBe("New accounts' growth slowed over the last 3 months");
  });

  it("keeps the month it began while it goes on, and is the new normal after 6 months", () => {
    const base = [...steady(0.06, 9), 0.03, 0.031, 0.029];
    for (const [extra, months] of [
      [[], 3],
      [[0.03], 4],
      [[0.03, 0.031, 0.03], 6],
    ] as const) {
      expect(trendShift(months_(base, extra))).toMatchObject({ since: "2025-11-01", months });
    }
    expect(trendShift(months_(base, [0.03, 0.031, 0.03, 0.029]))).toBeNull();
  });

  it("measures a later shift against the new normal", () => {
    const t = trendShift(months_([...steady(0.06), ...steady(0.03, 9), 0.005, 0.006, 0.004], []));
    expect(t).toMatchObject({ direction: "down", since: "2026-05-01", months: 3 });
    expect(t?.before).toBeCloseTo(0.03, 2);
  });

  it("finds growth that sped up, and words a turn in sign", () => {
    const fast = trendShift(months(grow([...steady(0.02), 0.06, 0.055, 0.065])));
    expect(fast && trendTitle("MRR", fast)).toBe("MRR's growth sped up over the last 3 months");
    const turned = trendShift(months(grow([...steady(0.03), -0.02, -0.025, -0.015])));
    expect(turned && trendTitle("Paid seats", turned)).toBe(
      "Paid seats turned from growth to decline over the last 3 months",
    );
  });

  it("isn't fooled by one odd month, by noise, or by too few months in a row", () => {
    expect(trendShift(months(grow([...steady(0.04), 0.01, 0.041, 0.04])))).toBeNull();
    expect(trendShift(months(grow([0.04, 0.01, 0.07, 0.02, 0.06, 0.03, 0.05, 0.02, 0.06])))).toBeNull();
    expect(trendShift(months(grow([0.06, 0.06, 0.03, 0.03, 0.03])))).toBeNull();
    const gap = grow([...steady(0.06), 0.03, 0.03, 0.03]);
    gap[6] = null as never;
    expect(trendShift(months(gap))).toBeNull();
  });

  it("ignores a shift no bigger than the minimum, however steady", () => {
    expect(trendShift(months(grow([...steady(0.04, 6, 0), 0.035, 0.035, 0.035])))).toBeNull();
  });

  it("works in the metric's units when it can be zero or below", () => {
    const flat = [0, 5, 10, 15, 20, 25, 30, 20, 10, 0];
    const t = trendShift(months(flat));
    expect(t).toMatchObject({ direction: "down", relative: false, months: 3 });
    expect(t && trendTitle("Net adds", t)).toBe("Net adds turned from growth to decline over the last 3 months");
    expect(trendRate("usd", false, t?.recent as number)).toBe("−$10 a month");
    expect(trendRate("number", true, 0.064)).toBe("6.4% a month");
  });
});

function months_(rates: readonly number[], extra: readonly number[]) {
  return months(grow([...rates, ...extra]), "2025-01-01");
}

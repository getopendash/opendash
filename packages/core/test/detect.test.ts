// The detector: each period's change against the median change of the periods before it, within k scaled
// MADs; an insight only beyond the band, by more than the materiality threshold, for as many periods as it asks.
import { describe, expect, it } from "vitest";
import { beyondAt, candidateOf, DEFAULT_DETECTOR, observe, type SeriesPoint } from "../src/checks/detect";

const months = (values: (number | null)[], from = "2025-01-01"): SeriesPoint[] =>
  values.map((value, row) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + row);
    return { period: d.toISOString().slice(0, 10), value, row };
  });
// MRR-like: about 4% a month, with a little noise.
const growth = (n: number, start = 200_000) =>
  Array.from({ length: n }, (_, i) =>
    Math.round(start * 1.04 ** i * (1 + (i % 3 === 0 ? 0.004 : i % 3 === 1 ? -0.003 : 0.001))),
  );

describe("observe", () => {
  it("abstains until enough months precede a month, then bands it around its usual change", () => {
    const seen = observe(months(growth(10)), DEFAULT_DETECTOR);
    expect(seen.slice(0, 7).every((o) => o.expected === null)).toBe(true);
    const last = seen.at(-1);
    expect(last?.expected).not.toBeNull();
    // Steady growth sits inside its band: 4% a month is this metric's normal, not an anomaly.
    expect(
      (last?.expectedLo as number) <= (last?.value as number) &&
        (last?.value as number) <= (last?.expectedHi as number),
    ).toBe(true);
    expect(candidateOf(seen, DEFAULT_DETECTOR)).toBeNull();
  });

  it("never expects a positive metric below zero, however noisy it is", () => {
    const seen = observe(months([10, 2, 9, 1, 12, 3, 8, 1, 11, 4]), DEFAULT_DETECTOR);
    expect(seen.at(-1)?.expectedLo).toBe(0);
  });

  it("never reads a gap as a change", () => {
    const values = growth(12);
    const seen = observe(months([...values.slice(0, 11), null, (values[11] as number) * 1.3]), DEFAULT_DETECTOR);
    expect(seen.at(-1)?.expected).toBeNull();
  });

  it("reads changes in absolute terms when a metric touches zero", () => {
    const seen = observe(months([0, 2, 1, 3, 2, 1, 2, 3, 2, 12]), DEFAULT_DETECTOR);
    const last = seen.at(-1);
    expect(last?.expected).toBe(2 + 0);
    expect(candidateOf(seen, { ...DEFAULT_DETECTOR, materiality: { abs: 1 } })).toMatchObject({ direction: "up" });
  });
});

describe("candidateOf", () => {
  it("flags a spike and a dip, with severity from how far past materiality it is", () => {
    const base = growth(13);
    const spike = [...base.slice(0, 12), Math.round((base[11] as number) * 1.25)];
    expect(candidateOf(observe(months(spike), DEFAULT_DETECTOR), DEFAULT_DETECTOR)).toMatchObject({
      direction: "up",
      severity: 2,
    });
    const dip = [...base.slice(0, 12), Math.round((base[11] as number) * 0.8)];
    expect(candidateOf(observe(months(dip), DEFAULT_DETECTOR), DEFAULT_DETECTOR)).toMatchObject({
      direction: "down",
      severity: 3,
    });
  });

  it("ignores a miss beyond the band that's smaller than the materiality threshold", () => {
    const base = growth(13);
    const nudge = [...base.slice(0, 12), Math.round((base[11] as number) * 1.07)];
    const seen = observe(months(nudge), DEFAULT_DETECTOR);
    expect((seen.at(-1)?.value as number) > (seen.at(-1)?.expectedHi as number)).toBe(true);
    expect(candidateOf(seen, DEFAULT_DETECTOR)).toBeNull();
    expect(candidateOf(seen, { ...DEFAULT_DETECTOR, materiality: { pct: 0.01 } })).toMatchObject({ direction: "up" });
  });

  it("takes a level shift as one change: the month after it is the new normal", () => {
    const base = growth(12);
    const shifted = [...base, Math.round((base[11] as number) * 1.3)];
    shifted.push(Math.round((shifted[12] as number) * 1.04));
    const seen = observe(months(shifted), DEFAULT_DETECTOR);
    expect(candidateOf(seen.slice(0, 13), DEFAULT_DETECTOR)).toMatchObject({ direction: "up" });
    expect(candidateOf(seen, DEFAULT_DETECTOR)).toBeNull();
  });

  it("keeps its band's width per unit of k, so each routine judges the same read at its own sensitivity", () => {
    const base = growth(13);
    const spike = [...base.slice(0, 12), Math.round((base[11] as number) * 1.12)];
    const seen = observe(months(spike), DEFAULT_DETECTOR);
    const last = seen.at(-1);
    expect(last?.spread).toBeGreaterThan(0);
    // The band at k = 3 is centre ± 3 spreads, the one observe drew.
    expect((last?.expectedHi as number) - (last?.expected as number)).toBeCloseTo(3 * (last?.spread as number), 6);
    const at = (k: number) =>
      beyondAt({ value: last?.value as number, expected: last?.expected as number, spread: last?.spread as number }, k);
    const score = Math.abs(last?.score as number);
    expect(at(score - 0.1)).toBe(true);
    expect(at(score + 0.1)).toBe(false);
  });

  it("reads weeks the way it reads months, a week apart", () => {
    const weeks: SeriesPoint[] = growth(13).map((value, row) => ({
      period: new Date(Date.parse("2026-06-01T00:00:00Z") + row * 7 * 86_400_000).toISOString().slice(0, 10),
      value,
      row,
    }));
    expect(observe(weeks, DEFAULT_DETECTOR, "week").at(-1)?.expected).not.toBeNull();
    // Read as months, those dates aren't a month apart: no change is a change, so nothing is expected.
    expect(observe(weeks, DEFAULT_DETECTOR, "month").at(-1)?.expected).toBeNull();
  });

  it("waits for persistence when asked to", () => {
    const base = growth(13);
    const spike = [...base.slice(0, 12), Math.round((base[11] as number) * 1.25)];
    const spec = { ...DEFAULT_DETECTOR, persistence: 2 };
    expect(candidateOf(observe(months(spike), spec), spec)).toBeNull();
  });
});

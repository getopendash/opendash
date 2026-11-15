// Outcome checks v0: a done task's horizon against what its metric would have done on its prior trend.
import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "../src/checks/detect";
import { checkAt, judgeOutcome, monthAfter } from "../src/tasks/outcome";

const months = (values: (number | null)[], from = "2026-01-01"): SeriesPoint[] =>
  values.map((value, row) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + row);
    return { period: d.toISOString().slice(0, 10), value, row };
  });
// Jan–Sep at 100 growing 2% a month; the task done in October; judged over November and December.
const trend = Array.from({ length: 9 }, (_, i) => Math.round(100 * 1.02 ** i * 100) / 100);
const spec = { direction: "up" as const, fromMonth: "2026-11-01", horizonMonths: 2, threshold: 0.05 };

describe("judgeOutcome", () => {
  it("improves when the metric beats its own trend in the task's direction", () => {
    const out = judgeOutcome(months([...trend, 120, 125, 135]), spec);
    expect(out.verdict).toBe("improved");
    expect(out.baseline).toMatchObject({ period: "2026-09-01", row: 8 });
    expect(out.observed).toMatchObject({ period: "2026-12-01", value: 135, row: 11 });
    // Sep × 1.02³ for October, November and December.
    expect(out.projected).toBeCloseTo((trend[8] as number) * 1.02 ** 3, 1);
    expect(out.trend).toMatchObject({ relative: true, months: 6 });
  });

  it("is no change within the threshold, and worse the other way; down tasks read it the other way", () => {
    const flat = judgeOutcome(months([...trend, 120, 122, 125]), spec);
    expect(flat.verdict).toBe("no_change");
    expect(judgeOutcome(months([...trend, 110, 105, 100]), spec).verdict).toBe("worsened");
    expect(judgeOutcome(months([...trend, 110, 105, 100]), { ...spec, direction: "down" }).verdict).toBe("improved");
  });

  it("is inconclusive without the horizon's last month, the month before, or a trend", () => {
    expect(judgeOutcome(months([...trend, 120, 125]), spec)).toMatchObject({ verdict: "inconclusive" });
    expect(judgeOutcome(months([...trend.slice(0, 8), null, 120, 125, 135]), spec).reason).toMatch(/month before/);
    expect(
      judgeOutcome(months([null, null, null, null, null, null, 100, 102, 104, 120, 125, 135]), spec).reason,
    ).toMatch(/3 whole months/);
  });
});

describe("when it's checked", () => {
  it("is the morning after the horizon's last whole month", () => {
    const done = new Date("2026-10-14T15:00:00Z");
    expect(monthAfter(done)).toBe("2026-11-01");
    expect(checkAt(done, 2).toISOString()).toBe("2027-01-01T06:00:00.000Z");
    expect(checkAt(new Date("2026-10-20T09:00:00Z"), 3).toISOString()).toBe("2027-02-01T06:00:00.000Z");
  });
});

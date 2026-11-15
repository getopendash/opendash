// Goal risk v0: a goal's metric projected on its trend to the month the goal is due, against the target.
import { describe, expect, it } from "vitest";
import type { SeriesPoint } from "../src/checks/detect";
import { forecastGoal, goalRiskSeverity } from "../src/checks/goal-risk";

const months = (values: (number | null)[], from = "2026-01-01"): SeriesPoint[] =>
  values.map((value, row) => {
    const d = new Date(`${from}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + row);
    return { period: d.toISOString().slice(0, 10), value, row };
  });
// MRR-like through September: 4% a month.
const mrr = Array.from({ length: 9 }, (_, i) => Math.round(300_000 * 1.04 ** i));

describe("forecastGoal", () => {
  it("projects the trend to the goal's month and says whether it reaches the target", () => {
    const f = forecastGoal(months(mrr), { target: 500_000, due: "2026-12-31", direction: "at_least" });
    expect(f).toMatchObject({ dueMonth: "2026-12-01", onCourse: false, latest: { period: "2026-09-01", row: 8 } });
    expect(f?.projected).toBeCloseTo((mrr[8] as number) * 1.04 ** 3, -2);
    expect(f?.trend).toMatchObject({ relative: true, months: 6 });
    expect(goalRiskSeverity(f?.shortfall as number)).toBe(2);
    expect(forecastGoal(months(mrr), { target: 450_000, due: "2026-12-31", direction: "at_least" })?.onCourse).toBe(
      true,
    );
  });

  it("reads a keep-below goal the other way", () => {
    const churn = [9, 9.5, 10, 10.4, 11, 11.5, 12, 12.6, 13.2].map((v) => v * 1000);
    expect(forecastGoal(months(churn), { target: 12_000, due: "2026-12-31", direction: "at_most" })).toMatchObject({
      onCourse: false,
    });
    expect(forecastGoal(months(churn), { target: 20_000, due: "2026-12-31", direction: "at_most" })?.onCourse).toBe(
      true,
    );
  });

  it("judges the latest month itself in the goal's month, and abstains without a trend or once it's past", () => {
    expect(forecastGoal(months(mrr), { target: 400_000, due: "2026-09-30", direction: "at_least" })).toMatchObject({
      projected: mrr[8],
      onCourse: true,
    });
    expect(forecastGoal(months(mrr), { target: 400_000, due: "2026-08-31", direction: "at_least" })).toBeNull();
    expect(
      forecastGoal(months([null, null, null, null, null, null, 100, 104, 108]), {
        target: 200,
        due: "2026-12-31",
        direction: "at_least",
      }),
    ).toBeNull();
  });
});

// How a goal stands: its share of the target or how far over, and the time left, in words.
import { describe, expect, it } from "vitest";
import { goalForecastLine, goalProgress } from "../lib/goal-progress";

const now = Date.parse("2026-10-11T09:00:00Z");
const usd = (v: number) => `$${(v / 1000).toFixed(1)}k`;

describe("goalProgress", () => {
  it("measures a reach-at-least goal by its share of the target", () => {
    expect(goalProgress({ target: 500_000, due: "2026-12-31", direction: "at_least" }, 412_600, now, usd)).toEqual({
      bar: 0.8252,
      met: false,
      tone: "accent",
      standing: "82% of the target",
      time: "82 days left",
    });
    expect(
      goalProgress({ target: 400_000, due: "2026-12-31", direction: "at_least" }, 412_600, now, usd),
    ).toMatchObject({
      bar: 1,
      met: true,
      tone: "success",
      standing: "Reached the target",
    });
  });

  it("measures a keep-below goal by how far over it is", () => {
    expect(goalProgress({ target: 8_000, due: "2026-12-31", direction: "at_most" }, 9_800, now, usd)).toMatchObject({
      bar: 1,
      met: false,
      tone: "warning",
      standing: "$1.8k above the target",
    });
    expect(goalProgress({ target: 10_000, due: "2026-12-31", direction: "at_most" }, 9_800, now, usd)).toMatchObject({
      met: true,
      tone: "success",
      standing: "Within the target",
    });
  });

  it("says when it's due today, when the date passed, and when there's no value yet", () => {
    expect(goalProgress({ target: 1, due: "2026-10-11", direction: "at_least" }, 0, now, usd).time).toBe("Due today");
    expect(goalProgress({ target: 1, due: "2026-10-01", direction: "at_least" }, 0, now, usd).time).toBe(
      "Due Oct 1 passed",
    );
    expect(goalProgress({ target: 1, due: "2026-12-31", direction: "at_least" }, null, now, usd)).toMatchObject({
      bar: 0,
      standing: "No value yet",
    });
  });
});

describe("goalForecastLine", () => {
  it("says whether the goal's on course, and what's projected for its month", () => {
    expect(goalForecastLine({ onCourse: false, projected: 466_800, dueMonth: "2026-12-01" }, usd)).toEqual({
      text: "At risk: $466.8k projected for December, on its trend",
      onCourse: false,
    });
    expect(goalForecastLine({ onCourse: true, projected: 8_900, dueMonth: "2026-12-01" }, usd)?.text).toBe(
      "On course: $8.9k projected for December, on its trend",
    );
    expect(goalForecastLine(null, usd)).toBeNull();
  });
});

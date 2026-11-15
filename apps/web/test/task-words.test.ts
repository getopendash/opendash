// Tasks v0 in words: the first wording, the chip, the expectation and what a done task's card says.
import { describe, expect, it } from "vitest";
import { defaultTaskTitle, deltaLabel, expectationLine, outcomeNote, taskChip } from "../lib/task-words";

const metric = { id: "m", title: "New accounts" };

describe("task words", () => {
  it("words a task from its insight, and its expectation", () => {
    expect(defaultTaskTitle("New accounts fell more than usual in September 2026")).toBe(
      "Find out why New accounts fell more than usual in September 2026",
    );
    expect(expectationLine({ metric, direction: "up", horizonMonths: 2 })).toBe(
      "Expected: New accounts up, judged over the 2 whole months after it's done",
    );
    expect(expectationLine({ metric, direction: "down", horizonMonths: 1 })).toBe(
      "Expected: New accounts down, judged over the whole month after it's done",
    );
  });

  it("chips a task by where it is, then by its outcome", () => {
    expect(taskChip({ status: "accepted", checkAt: null, outcome: null })).toEqual({ label: "To do", tone: "default" });
    expect(taskChip({ status: "done", checkAt: "2027-02-01T06:00:00Z", outcome: null }).label).toBe("Checked Feb 1");
    const outcome = {
      verdict: "improved" as const,
      reason: null,
      observed: null,
      projected: null,
      delta: 0.1,
      trendMonths: 6,
      checkedAt: "2027-01-01T06:00:00Z",
    };
    expect(taskChip({ status: "done", checkAt: null, outcome })).toEqual({ label: "Improved", tone: "success" });
    expect(deltaLabel(0.104)).toBe("+10%");
    expect(deltaLabel(-0.06)).toBe("−6%");
  });

  it("says when it's checked, how it was, or why it couldn't be", () => {
    const t = { metric, horizonMonths: 3, checkAt: "2027-02-01T06:00:00Z" };
    expect(outcomeNote(t, null)).toBe(
      "Its outcome is checked on Feb 1, 2027, after the 3 whole months that follow it, against what New accounts would have done on its trend.",
    );
    const base = {
      reason: null,
      observed: null,
      projected: null,
      delta: 0.1,
      trendMonths: 6,
      checkedAt: "2027-01-01T06:00:00Z",
    };
    expect(outcomeNote({ ...t, horizonMonths: 2 }, { ...base, verdict: "improved" })).toBe(
      "Checked Jan 1, 2027, over the 2 whole months after it was done. The projection extends how New accounts changed in the 6 months before; it isn't a query cell.",
    );
    expect(
      outcomeNote(t, { ...base, verdict: "inconclusive", reason: "The horizon's last month has no value yet." }),
    ).toBe("It couldn't be checked: the horizon's last month has no value yet.");
  });
});

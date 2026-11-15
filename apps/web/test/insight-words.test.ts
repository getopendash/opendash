// Insights v0 in words: the question Investigate asks, the card's chip, and when it was found.
import { describe, expect, it } from "vitest";
import { foundLine, investigateQuestion, resolvedLine, severityChip } from "../lib/insight-words";

describe("investigateQuestion", () => {
  it("turns each title into its question", () => {
    expect(investigateQuestion("New accounts fell more than usual in September 2026")).toBe(
      "Why did New accounts fall more than usual in September 2026?",
    );
    expect(investigateQuestion("Monthly recurring revenue grew less than usual in May 2026")).toBe(
      "Why did Monthly recurring revenue grow less than usual in May 2026?",
    );
    expect(investigateQuestion("Churned MRR rose more than usual in August 2026")).toBe(
      "Why did Churned MRR rise more than usual in August 2026?",
    );
    expect(investigateQuestion("Something else")).toBe("What's behind this: Something else?");
    expect(investigateQuestion("Monthly recurring revenue is on course to miss its goal for Dec 31, 2026")).toBe(
      "What would it take for Monthly recurring revenue to reach its goal for Dec 31, 2026?",
    );
    expect(investigateQuestion("Churned MRR is on course to go over its goal for Dec 31, 2026")).toBe(
      "What would it take for Churned MRR to stay within its goal for Dec 31, 2026?",
    );
    expect(investigateQuestion("Monthly recurring revenue's growth slowed over the last 3 months")).toBe(
      "Why did Monthly recurring revenue's growth slow over the last 3 months?",
    );
    expect(investigateQuestion("Paying customers' decline steepened over the last 4 months")).toBe(
      "Why did Paying customers' decline steepen over the last 4 months?",
    );
    expect(investigateQuestion("Net adds turned from growth to decline over the last 3 months")).toBe(
      "Why did Net adds turn from growth to decline over the last 3 months?",
    );
  });
});

describe("the card's words", () => {
  it("names the severity, and a late month as data late", () => {
    expect(severityChip({ kind: "anomaly", severity: 1 })).toEqual({ label: "Notable", tone: "default" });
    expect(severityChip({ kind: "anomaly", severity: 3 })).toEqual({ label: "Very large change", tone: "danger" });
    expect(severityChip({ kind: "data_quality", severity: 1 })).toEqual({ label: "Data late", tone: "warning" });
    expect(severityChip({ kind: "goal_risk", severity: 1 })).toEqual({ label: "Goal at risk", tone: "warning" });
    expect(severityChip({ kind: "trend", severity: 1 })).toEqual({ label: "Notable", tone: "default" });
    expect(severityChip({ kind: "trend", severity: 2 })).toEqual({ label: "Large shift", tone: "warning" });
    expect(resolvedLine("trend")).toBe("Resolved: the shift didn't hold, or is now the usual");
  });

  it("says when it was found, and when it was seen again", () => {
    const now = Date.parse("2026-10-11T12:00:00Z");
    expect(
      foundLine({ firstSeenAt: "2026-10-11T06:00:00Z", lastSeenAt: "2026-10-11T06:00:00Z", occurrences: 1 }, now),
    ).toBe("Found today");
    expect(
      foundLine({ firstSeenAt: "2026-10-09T06:00:00Z", lastSeenAt: "2026-10-11T06:00:00Z", occurrences: 3 }, now),
    ).toBe("Found Oct 9 · seen again today");
  });
});

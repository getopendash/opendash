// The definition editor's impact line: what a definition change reaches once approved, said plainly.
import { describe, expect, it } from "vitest";
import { impactOf } from "../lib/impact";

const none = { metrics: [], dashboards: { visible: [], hidden: 0 }, verifiedQueries: [], evalQuestions: 0, goals: [] };

describe("impactOf", () => {
  it("is nothing when nothing depends on it", () => {
    expect(impactOf(none, "metric")).toBeNull();
  });

  it("lists what it reaches, counting private dashboards in", () => {
    expect(
      impactOf(
        {
          ...none,
          dashboards: { visible: [{ id: "a", title: "Revenue" }], hidden: 2 },
          verifiedQueries: [{ id: "q", title: "MRR lately?" }],
          evalQuestions: 4,
        },
        "metric",
      ),
    ).toBe("Once approved, the change reaches 3 dashboards (2 private), 1 verified query and 4 eval questions.");
    expect(impactOf({ ...none, evalQuestions: 1 }, "metric")).toBe(
      "Once approved, the change reaches 1 eval question.",
    );
  });

  it("counts the goals a metric measures", () => {
    expect(impactOf({ ...none, goals: [{ id: "g", title: "MRR to $500k" }], evalQuestions: 2 }, "metric")).toBe(
      "Once approved, the change reaches 1 goal and 2 eval questions.",
    );
  });

  it("counts a dataset's metrics, and only a dataset's", () => {
    const metrics = [
      { id: "m1", title: "MRR" },
      { id: "m2", title: "ARPA" },
    ];
    expect(impactOf({ ...none, metrics }, "dataset")).toBe("Once approved, the change reaches 2 metrics.");
    expect(impactOf({ ...none, metrics }, "metric")).toBeNull();
  });
});

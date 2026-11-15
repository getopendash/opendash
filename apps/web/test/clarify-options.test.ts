// A clarifying question's options: readings as buttons, dashboards as stacked rows with a bold title.
import { describe, expect, it } from "vitest";
import { optionViews } from "../lib/clarify-options";

describe("a clarifying question's options", () => {
  it("keeps short readings as a row of buttons", () => {
    expect(optionViews(["Revenue churn", "Customer churn"])).toEqual({
      stacked: false,
      options: [
        { text: "Revenue churn", title: "Revenue churn", detail: null },
        { text: "Customer churn", title: "Customer churn", detail: null },
      ],
    });
  });

  it("stacks dashboards, each with its title, what it holds and its filter, sending the option as written", () => {
    const option = "Revenue health: MRR, new and churned MRR, net retention; filter by plan";
    expect(optionViews([option, "Growth: new accounts by month; filter by channel"])).toEqual({
      stacked: true,
      options: [
        { text: option, title: "Revenue health", detail: "MRR, new and churned MRR, net retention · filter by plan" },
        {
          text: "Growth: new accounts by month; filter by channel",
          title: "Growth",
          detail: "New accounts by month · filter by channel",
        },
      ],
    });
  });

  it("stacks a long reading too, and leaves a time or a ratio alone", () => {
    expect(optionViews(["Churned MRR as a share of MRR at the start of each month, by plan", "Logos"]).stacked).toBe(
      true,
    );
    expect(optionViews(["Ratio 3:1", "Monthly"]).stacked).toBe(false);
  });
});

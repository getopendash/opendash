// Changing a reading: the question asked again, with the changed reading as an instruction.
import { describe, expect, it } from "vitest";
import { chipText, rereadQuestion } from "../lib/readings";

describe("rereadQuestion", () => {
  it("asks the question again with the reading changed", () => {
    expect(rereadQuestion("Why did churn rise in September?", "September vs August 2026", "  Q3   vs Q2 2026 ")).toBe(
      "Why did churn rise in September?\n\nRead “September vs August 2026” as “Q3 vs Q2 2026”.",
    );
  });

  it("asks nothing when the reading is empty or unchanged", () => {
    expect(rereadQuestion("Why?", "All plans", "   ")).toBeNull();
    expect(rereadQuestion("Why?", "All plans", "all plans ")).toBeNull();
  });

  it("caps the reading, and doesn't repeat a question near the limit", () => {
    const long = rereadQuestion("Why?", "All plans", "x".repeat(500));
    expect(long).toBe(`Why?\n\nRead “All plans” as “${"x".repeat(200)}”.`);
    expect(rereadQuestion("q".repeat(3990), "All plans", "Pro only")).toBe(
      "Ask that again. Read “All plans” as “Pro only”.",
    );
  });
});

describe("chipText", () => {
  it("reads a chip with a figure in it as the answer shows it", () => {
    expect(
      chipText([
        { text: "Excludes " },
        { ref: "q1:0:n", display: "12", kind: "number", citations: [] },
        { text: " test accounts" },
      ]),
    ).toBe("Excludes 12 test accounts");
  });
});

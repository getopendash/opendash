import { describe, expect, it } from "vitest";
import { FALLBACK, friendlyProblem } from "@/lib/step-problems";

describe("friendlyProblem", () => {
  it("says what a failed step was about, in plain words", () => {
    expect(friendlyProblem("system.columns isn't a table in this source's catalog.")).toBe("A table wasn't found");
    expect(friendlyProblem("billing.tickets is a ReplacingMergeTree: a row can have older versions")).toBe(
      "Needed the latest versions",
    );
    expect(friendlyProblem("undefined_column: There's no column no_such_column")).toBe("A column wasn't found");
    expect(friendlyProblem("canceling statement due to statement timeout")).toBe("Took too long");
    expect(friendlyProblem("DROP isn't allowed: OpenDash only runs SELECT queries.")).toBe(
      "That kind of query isn't allowed",
    );
  });

  it("falls back to a calm general line, never the raw text", () => {
    expect(friendlyProblem("Code: 999. DB::Exception: something nobody planned for")).toBe(FALLBACK);
    expect(friendlyProblem(undefined)).toBe(FALLBACK);
    expect(friendlyProblem("   ")).toBe(FALLBACK);
  });
});

// The guided setup's first questions: about the sample data's own tables when that's the source (only the ones it
// has learned, one a topic), and openers that work on any database otherwise.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { ONBOARDING_STEPS, SAMPLE_SOURCE_NAME, SAMPLE_TABLES, starterQuestions } = await import("../lib/onboarding");

const source = (sample: boolean) => ({
  id: "0190a000-0000-7000-8000-00000000000a",
  name: sample ? SAMPLE_SOURCE_NAME : "warehouse",
  sample,
  ready: true,
  working: false,
  failed: false,
});

describe("the guided setup's first questions", () => {
  it("are one per topic of the sample data, about tables it has learned", () => {
    const questions = starterQuestions(source(true), SAMPLE_TABLES);
    expect(questions.map((q) => q.topic)).toEqual(["UK house prices", "Hacker News", "Flights", "COVID-19"]);
    expect(new Set(questions.map((q) => q.question)).size).toBe(4);
  });

  it("leave out a table the playground no longer has", () => {
    const questions = starterQuestions(source(true), ["default.uk_price_paid", "default.covid"]);
    expect(questions.map((q) => q.topic)).toEqual(["UK house prices", "COVID-19"]);
  });

  it("work on any database when the source is someone's own, or there's none yet", () => {
    for (const s of [source(false), null]) {
      const questions = starterQuestions(s, []);
      expect(questions.length).toBeGreaterThanOrEqual(3);
      // Nothing about the sample data's tables.
      expect(questions.map((q) => q.question).join(" ")).not.toMatch(/house|Hacker News|flights|COVID/i);
    }
  });

  it("names its steps in order: the welcome, then the three the bar counts", () => {
    expect(ONBOARDING_STEPS.map((s) => s.href)).toEqual([
      "/get-started",
      "/get-started/data",
      "/get-started/ai",
      "/get-started/ask",
    ]);
  });
});

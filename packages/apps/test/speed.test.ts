// What the render check says about an App's speed, from how its answers came in: queries asked in rounds that wait
// for each other, and a query that takes seconds in the warehouse. Nothing is said of an App that asks once, quickly.
import { describe, expect, it } from "vitest";
import { speedFindings } from "../src/runtime/probe";

describe("what makes an App slow to show its numbers", () => {
  it("says nothing of an App that asks for everything at once and is answered quickly", () => {
    expect(speedFindings(null)).toEqual([]);
    expect(
      speedFindings({ asked: 7, answered: 7, rounds: 1, looks: 2, slowest: [{ query: "q_mrr", ms: 1900 }] }),
    ).toEqual([]);
  });

  it("names the rounds, and each query of two seconds or more with its time, slowest first", () => {
    const found = speedFindings({
      asked: 7,
      answered: 7,
      rounds: 3,
      looks: 14,
      slowest: [
        { query: "q_book", ms: 10_001 },
        { query: "q_counts", ms: 2_000 },
        { query: "q_trend", ms: 640 },
      ],
    });
    expect(found.map((f) => f.kind)).toEqual(["speed", "speed", "speed"]);
    expect(found[0]?.message).toMatch(/asked for in 3 rounds/);
    expect(found[1]?.message).toMatch(/^q_book took 10\.0 s in the warehouse/);
    expect(found[2]?.message).toMatch(/^q_counts took 2\.0 s/);
    expect(found.some((f) => f.message.includes("q_trend"))).toBe(false);
  });
});

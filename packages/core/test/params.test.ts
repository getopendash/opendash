// How the gateway words a parameter problem: each placeholder as the dialect writes it ($2 on Postgres, the 2nd ? on
// MySQL), so the model can find the one it got wrong.
import { describe, expect, it } from "vitest";
import { paramProblem } from "../src/gateway/gateway";

const country = { name: "country", value: "DE" };
const plan = { name: "plan", value: "pro" };

describe("a parameter problem", () => {
  it("names Postgres placeholders by their number", () => {
    expect(paramProblem([country, plan], [1])).toBe("$2 (plan) isn't used in the SQL.");
    expect(paramProblem([], [1])).toBe("The SQL uses $1 but no parameters were given.");
  });

  it("names MySQL placeholders by their place", () => {
    expect(paramProblem([country, plan], [1], "positional", "?")).toBe("the 2nd ? (plan) isn't used in the SQL.");
    expect(paramProblem([country], [1, 2, 3], "positional", "?")).toBe(
      "The SQL uses the 3rd ? but only 1 parameter was given.",
    );
    expect(paramProblem([{ name: "Bad Name", value: 1 }], [1], "positional", "?")).toMatch(/^the 1st \? \(Bad Name\)/);
  });
});

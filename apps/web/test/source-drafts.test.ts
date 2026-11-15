import type { DraftCandidate } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { candidateWhy, draftCapText } from "../lib/source-drafts";

const table = (over: Partial<DraftCandidate>): DraftCandidate => ({
  name: "public.accounts",
  kind: "table",
  rows: null,
  queries: 0,
  joinedBy: 0,
  joins: [],
  modelled: false,
  ...over,
});

describe("why the picker ranks a table", () => {
  it("says its use first, then what joins to it, its size, what it joins: two facts at most", () => {
    expect(candidateWhy(table({ queries: 188, joinedBy: 6, rows: 1_240_000 }))).toBe(
      "Read by 188 queries · 6 tables join to it",
    );
    expect(candidateWhy(table({ kind: "view", queries: 412 }))).toBe("View · read by 412 queries");
    expect(candidateWhy(table({ rows: 1_240_000, joins: ["public.v_opportunities"] }))).toBe(
      "1.2M rows · joins v_opportunities",
    );
    expect(candidateWhy(table({ rows: 18_000_000 }))).toBe("18M rows");
    expect(candidateWhy(table({ rows: 1901, joins: ["a.b", "a.c", "a.d"] }))).toBe("1.9k rows · joins b and 2 more");
    expect(candidateWhy(table({ modelled: true, joinedBy: 1 }))).toBe("Has a dataset · 1 table joins to it");
    expect(candidateWhy(table({}))).toBe("");
  });
});

describe("what a draft costs at most", () => {
  const cost = { perTableUsd: 0.5, baseUsd: 0.5, leftUsd: 9.4, budgetUsd: 10 };
  it("states the run's cap and what's left of the background budget", () => {
    expect(draftCapText(5, cost)).toEqual({
      text: "At most $3.00 for 5 tables (the run stops there), from the background budget: $9.40 of $10.00 left this month.",
      over: false,
    });
    expect(draftCapText(1, { ...cost, leftUsd: 0.6 }).text).toBe(
      "At most $1.00 for 1 table (the run stops there), from the background budget: $0.60 of $10.00 left this month. That's more than what's left.",
    );
    expect(draftCapText(3, { ...cost, budgetUsd: 0, leftUsd: 0 })).toMatchObject({ over: true });
  });
});

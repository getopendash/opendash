// The words around a list of records: the period it covers, what narrows it, and whether it adds up to the number.
import { describe, expect, it } from "vitest";
import {
  fieldWords,
  hiddenWords,
  narrowingWords,
  periodWords,
  reconcileWords,
  segmentWords,
} from "../lib/records-words";

const range = (from: string, to: string) => ({ from: `${from}T00:00:00.000Z`, to: `${to}T00:00:00.000Z` });

describe("periodWords", () => {
  it("names a bucket by its grain", () => {
    expect(periodWords(range("2026-09-01", "2026-10-01"), "month")).toBe("September 2026");
    expect(periodWords(range("2026-07-01", "2026-10-01"), "quarter")).toBe("Q3 2026");
    expect(periodWords(range("2026-01-01", "2027-01-01"), "year")).toBe("2026");
    expect(periodWords(range("2026-09-07", "2026-09-14"), "week")).toBe("Week of Sep 7, 2026");
    expect(periodWords(range("2026-09-07", "2026-09-08"), "day")).toBe("Sep 7, 2026");
  });
  it("says a range without a grain as a month, a day or two dates", () => {
    expect(periodWords(range("2026-09-01", "2026-10-01"), null)).toBe("September 2026");
    expect(periodWords(range("2026-09-07", "2026-09-08"), null)).toBe("Sep 7, 2026");
    expect(periodWords(range("2026-07-01", "2026-09-15"), null)).toBe("Jul 1 – Sep 14, 2026");
    expect(periodWords(range("2025-12-15", "2026-02-01"), null)).toBe("Dec 15, 2025 – Jan 31, 2026");
    expect(periodWords(null, "month")).toBeNull();
  });
});

describe("what narrows the records", () => {
  it("reads each group and filter as a phrase", () => {
    expect(
      narrowingWords({
        groups: [
          { field: "priority", value: "urgent" },
          { field: "plans.name", value: null },
        ],
        filters: [
          { field: "channel", op: "in", value: ["chat", "web"] },
          { field: "csat", op: "is_not_null", value: null },
          { field: "seats", op: ">=", value: 10 },
        ],
      }),
    ).toEqual([
      "Priority is urgent",
      "Plans name is empty",
      "Channel is one of chat, web",
      "Csat is set",
      "Seats is at least 10",
    ]);
  });
  it("names fields, segments and hidden columns", () => {
    expect(fieldWords("billing_interval")).toBe("Billing interval");
    expect(segmentWords({ name: "exclude_test", description: "Leaves out internal and test accounts" })).toBe(
      "Leaves out internal and test accounts",
    );
    expect(segmentWords({ name: "exclude_test", description: null })).toBe("Exclude test");
    expect(hiddenWords(["accounts.billing_email", "requester"])).toEqual(["Billing email", "Requester"]);
  });
});

describe("reconcileWords", () => {
  const base = {
    kind: "count" as const,
    total: 10,
    value: 10,
    noun: "tickets",
    valueColumn: null,
    format: "number" as const,
  };
  it("says a count's records are the number, and what a sum's make", () => {
    expect(reconcileWords({ ...base, matches: true, expected: 10 })).toEqual({
      text: "10 tickets: the number you clicked.",
      ok: true,
    });
    expect(
      reconcileWords({
        ...base,
        kind: "sum",
        format: "usd",
        value: 412_633,
        total: 900,
        matches: true,
        expected: 412_633,
      }),
    ).toEqual({ text: "Together they make $412,633.00, the number you clicked.", ok: true });
  });
  it("says when they don't add up, and is silent when no number was clicked", () => {
    expect(reconcileWords({ ...base, total: 12, matches: false, expected: 10 })?.ok).toBe(false);
    expect(reconcileWords({ ...base, matches: false, expected: 10 })?.text).toMatch(/data may have changed/);
    expect(reconcileWords({ ...base, matches: null, expected: null })).toBeNull();
  });
});

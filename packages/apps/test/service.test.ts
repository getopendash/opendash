// A service's answer as rows: shaped by the dataset's declared paths and types, deterministically,
// with what was cut, what didn't read and whether it's all of it said.
import { describe, expect, it } from "vitest";
import { listsIn, rowLink, SERVICE_ROWS, ShapeProblem, shapeRows } from "../src/dashboard/service";

const issues = {
  total: 3,
  isLast: true,
  issues: [
    {
      key: "APP-1",
      fields: { summary: "Login fails", status: { name: "Open" }, created: "2026-10-01T09:30:00.000+0200", points: 3 },
    },
    {
      key: "APP-2",
      fields: { summary: "Slow list", status: { name: "Done" }, created: "2026-10-03T12:00:00Z", points: "5" },
    },
    { key: "APP-3", fields: { summary: "Typo", status: null, created: "not a date", points: "many" } },
  ],
};
const shape = {
  rows: "issues",
  columns: [
    { name: "key", path: "key", type: "string" as const },
    { name: "status", path: "fields.status.name", type: "string" as const },
    { name: "created", path: "fields.created", type: "time" as const },
    { name: "points", path: "fields.points", type: "number" as const },
    { name: "team", path: "fields.team.name", type: "string" as const },
  ],
};
const text = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });

describe("shaping a service's answer", () => {
  it("reads records at their path as typed columns, in UTC, saying what didn't read", () => {
    const s = shapeRows(text(issues), shape);
    expect(s.rows).toEqual([
      { key: "APP-1", status: "Open", created: "2026-10-01T07:30:00.000Z", points: 3, team: null },
      { key: "APP-2", status: "Done", created: "2026-10-03T12:00:00.000Z", points: 5, team: null },
      { key: "APP-3", status: null, created: null, points: null, team: null },
    ]);
    expect(s.unread).toEqual({ created: 1, points: 1 });
    expect(s.missing).toEqual(["team"]);
    expect(s.incomplete).toBe(false);
    // Structured content first, the same rows.
    expect(shapeRows({ structuredContent: issues, content: [] }, shape).rows).toEqual(s.rows);
  });

  it("says when there's more than it returned, and cuts past the cap", () => {
    expect(shapeRows(text({ ...issues, total: 40 }), shape).incomplete).toBe(true);
    expect(shapeRows(text({ ...issues, isLast: false }), shape).incomplete).toBe(true);
    expect(shapeRows(text({ ...issues, nextPageToken: "abc" }), shape).incomplete).toBe(true);
    const many = Array.from({ length: SERVICE_ROWS + 5 }, (_, i) => ({ key: `K-${i}` }));
    const s = shapeRows(text(many), { columns: [{ name: "key", path: "key", type: "string" }] });
    expect(s.rows).toHaveLength(SERVICE_ROWS);
    expect(s.cut).toBe(5);
    expect(s.incomplete).toBe(true);
  });

  it("refuses what isn't records, and never reads past a record's own keys", () => {
    const problem = (f: () => unknown) => {
      try {
        f();
        return "ok";
      } catch (e) {
        return e instanceof ShapeProblem ? e.message : "other";
      }
    };
    expect(problem(() => shapeRows({ isError: true, content: [{ type: "text", text: "No access" }] }, shape))).toBe(
      "The service answered with an error: No access",
    );
    expect(problem(() => shapeRows({ content: [{ type: "text", text: "hello" }] }, shape))).toBe(
      "The service's answer isn't data (it isn't JSON).",
    );
    expect(problem(() => shapeRows(text({ items: [] }), shape))).toBe(
      'There\'s no list of records at "issues" in the answer.',
    );
    const s = shapeRows(text([{ a: 1 }]), { columns: [{ name: "x", path: "constructor.name", type: "string" }] });
    expect(s.rows).toEqual([{ x: null }]);
  });

  it("never reads a number it can't hold exactly, an impossible day, or a time with no zone", () => {
    const cols = (type: "number" | "date" | "time") => ({ columns: [{ name: "v", path: "v", type }] });
    const one = (v: unknown, type: "number" | "date" | "time") => shapeRows(text([{ v }]), cols(type)).rows[0]?.v;
    expect(one("9007199254740993", "number")).toBeNull();
    expect(one("12.5", "number")).toBe(12.5);
    expect(one("2026-02-30", "date")).toBeNull();
    expect(one("2026-02-28", "date")).toBe("2026-02-28");
    expect(one("2026-10-01T10:00:00", "time")).toBeNull();
    expect(one("2026-10-01", "time")).toBe("2026-10-01T00:00:00.000Z");
    expect(one("2026-02-30T10:00:00Z", "time")).toBeNull();
  });

  it("makes a row's link from its template, encoded, or none when a slot is empty", () => {
    expect(rowLink("https://acme.example/browse/{key}", { key: "APP 1/x" })).toBe(
      "https://acme.example/browse/APP%201%2Fx",
    );
    expect(rowLink("https://acme.example/browse/{key}", { key: null })).toBeNull();
  });
});

describe("an answer whose list isn't where the dataset says", () => {
  it("names where its lists are, so the fix is one try", () => {
    const wrapped = { structuredContent: { data: { nextPageToken: "x", isLast: false, issues: issues.issues } } };
    expect(listsIn(wrapped.structuredContent)).toEqual(["data.issues"]);
    expect(() => shapeRows(wrapped, shape)).toThrow(/no list of records at "issues".*Its lists are at: "data\.issues"/);
    const fixed = shapeRows(wrapped, { ...shape, rows: "data.issues" });
    expect(fixed.rows).toHaveLength(3);
    // The page token beside the list says there's more: totals over it aren't totals.
    expect(fixed.incomplete).toBe(true);
  });

  it("never repeats a key no dataset could name", () => {
    const huge = "k".repeat(100_000);
    const answer = { structuredContent: { [huge]: [{ a: 1 }], data: { issues: [{ a: 1 }] } } };
    expect(listsIn(answer.structuredContent)).toEqual(["data.issues"]);
    try {
      shapeRows(answer, shape);
    } catch (e) {
      expect(String((e as Error).message).length).toBeLessThan(300);
    }
  });

  it("reads keys with spaces and a list's item by number", () => {
    const answer = { structuredContent: [{ key: "A-1", fields: { "Owner Team": { value: [{ value: "Billing" }] } } }] };
    const got = shapeRows(answer, {
      columns: [{ name: "team", path: "fields.Owner Team.value.0.value", type: "string" }],
    });
    expect(got.rows[0]?.team).toBe("Billing");
  });
});

// The conversations list's settings in the URL: parsed forgivingly, written back without defaults, groups by UTC day.
import { describe, expect, it } from "vitest";
import { filtersOf, historyHref, isNarrowed, pagesAround, parseHistory, whenGroup } from "../lib/ask-filters";

const project = "01a126d7-e0dd-73b6-b248-abb3cd436f58";

describe("parseHistory", () => {
  it("reads the settings, and falls back to the defaults on anything unknown", () => {
    expect(parseHistory({ q: "churn", scope: "shared", project, status: "needs_input", page: "3" })).toEqual({
      q: "churn",
      scope: "shared",
      project,
      state: "needs_input",
      page: 3,
    });
    expect(parseHistory({ scope: "everyone", project: "x", status: "toString", page: "-2" })).toEqual({
      q: "",
      scope: "all",
      project: null,
      state: null,
      page: 1,
    });
    expect(parseHistory({ q: ["first", "second"], page: "1.5" })).toMatchObject({ q: "first", page: 1 });
  });
});

describe("historyHref", () => {
  const p = parseHistory({ q: "churn", project, page: "4" });

  it("keeps what's set, drops the defaults, and goes back to the first page on a change", () => {
    expect(historyHref(p, { page: 4 })).toBe(`/ask?q=churn&project=${project}&page=4`);
    expect(historyHref(p, { state: "answered" })).toBe(`/ask?q=churn&project=${project}&status=answered`);
    expect(historyHref(p, { q: "  ", project: null })).toBe("/ask");
    expect(historyHref(p, { q: "net retention & churn" })).toBe(`/ask?q=net+retention+%26+churn&project=${project}`);
  });

  it("gives core the filters, and says when the list is narrowed", () => {
    expect(filtersOf(p)).toEqual({ scope: "all", q: "churn", projectId: project });
    expect(isNarrowed(p)).toBe(true);
    expect(isNarrowed(parseHistory({ scope: "mine" }))).toBe(false);
    expect(parseHistory({ scope: "starred" }).scope).toBe("starred");
  });
});

describe("whenGroup", () => {
  const now = Date.parse("2026-10-11T08:00:00Z");
  it("groups by UTC day", () => {
    expect(whenGroup("2026-10-11T00:01:00Z", now)).toBe("Today");
    expect(whenGroup("2026-10-10T23:59:00Z", now)).toBe("Yesterday");
    expect(whenGroup("2026-10-05T12:00:00Z", now)).toBe("Previous 7 days");
    expect(whenGroup("2026-09-20T12:00:00Z", now)).toBe("Previous 30 days");
    expect(whenGroup("2026-01-01T12:00:00Z", now)).toBe("Earlier");
  });
});

describe("pagesAround", () => {
  it("shows the first, the last and the neighbours, with gaps between", () => {
    expect(pagesAround(1, 1)).toEqual([1]);
    expect(pagesAround(1, 3)).toEqual([1, 2, 3]);
    expect(pagesAround(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pagesAround(2, 10)).toEqual([1, 2, 3, "gap", 10]);
    expect(pagesAround(10, 10)).toEqual([1, "gap", 9, 10]);
  });
});

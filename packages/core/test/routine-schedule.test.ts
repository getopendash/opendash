// When routines run and metrics are checked: local times in the workspace's zone, whatever daylight saving
// does to UTC; a late dispatcher runs only the latest missed time; a period is checked once it has closed everywhere.
import { describe, expect, it } from "vitest";
import {
  addPeriods,
  checkHourFrom,
  isTimeZone,
  lastWholePeriod,
  latestOccurrence,
  localDate,
  nextCheckAt,
  nextLocalTime,
  nextOccurrence,
  periodStart,
} from "../src/routines/schedule";
import type { ScheduleRule } from "../src/routines/spec";

const at = (iso: string) => new Date(iso);
const iso = (d: Date) => d.toISOString();
const mondays: ScheduleRule = { every: "week", days: ["mon"], at: "07:00" };

describe("nextOccurrence", () => {
  it("is the next Monday at 07:00 where the workspace is", () => {
    const sunday = at("2026-10-11T09:00:00Z");
    expect(iso(nextOccurrence(mondays, "UTC", sunday))).toBe("2026-10-12T07:00:00.000Z");
    expect(iso(nextOccurrence(mondays, "Europe/Berlin", sunday))).toBe("2026-10-12T05:00:00.000Z");
    expect(iso(nextOccurrence(mondays, "Asia/Kolkata", sunday))).toBe("2026-10-12T01:30:00.000Z");
  });

  it("is today before its time, and the next one at or after it", () => {
    expect(iso(nextOccurrence(mondays, "UTC", at("2026-10-12T06:59:00Z")))).toBe("2026-10-12T07:00:00.000Z");
    expect(iso(nextOccurrence(mondays, "UTC", at("2026-10-12T07:00:00Z")))).toBe("2026-10-19T07:00:00.000Z");
  });

  it("keeps the local time across daylight saving", () => {
    // New York leaves daylight saving on Nov 1, 2026: 07:00 is 11:00 UTC before and 12:00 after.
    expect(iso(nextOccurrence(mondays, "America/New_York", at("2026-10-20T00:00:00Z")))).toBe(
      "2026-10-26T11:00:00.000Z",
    );
    expect(iso(nextOccurrence(mondays, "America/New_York", at("2026-10-28T00:00:00Z")))).toBe(
      "2026-11-02T12:00:00.000Z",
    );
  });

  it("runs a time the clocks skip when they resume, and a time they repeat once", () => {
    // Berlin springs forward on Mar 29, 2026: 02:30 doesn't happen, so it runs at 03:30 local (01:30 UTC).
    const nightly: ScheduleRule = { every: "day", at: "02:30" };
    const skipped = nextOccurrence(nightly, "Europe/Berlin", at("2026-03-28T12:00:00Z"));
    expect(iso(skipped)).toBe("2026-03-29T01:30:00.000Z");
    // It falls back on Oct 25, 2026: 02:30 happens twice, and the run after it is the next day's.
    const repeated = nextOccurrence(nightly, "Europe/Berlin", at("2026-10-24T12:00:00Z"));
    const next = nextOccurrence(nightly, "Europe/Berlin", repeated);
    expect(iso(next).slice(0, 10)).toBe("2026-10-26");
    // West of UTC the same: New York springs forward on Mar 8, 2026, so 02:30 runs at 03:30 EDT (07:30 UTC), never
    // an hour early at 01:30.
    expect(iso(nextOccurrence(nightly, "America/New_York", at("2026-03-07T12:00:00Z")))).toBe(
      "2026-03-08T07:30:00.000Z",
    );
    // And it falls back on Nov 1: 01:30 happens twice, and runs at the first (EDT, 05:30 UTC).
    const early: ScheduleRule = { every: "day", at: "01:30" };
    expect(iso(nextOccurrence(early, "America/New_York", at("2026-10-31T12:00:00Z")))).toBe("2026-11-01T05:30:00.000Z");
  });

  it("knows weekdays, several days, and the first and last day of a month", () => {
    const weekdays: ScheduleRule = { every: "week", days: ["mon", "tue", "wed", "thu", "fri"], at: "09:00" };
    expect(iso(nextOccurrence(weekdays, "UTC", at("2026-10-16T10:00:00Z")))).toBe("2026-10-19T09:00:00.000Z");
    const twice: ScheduleRule = { every: "week", days: ["thu", "mon"], at: "09:00" };
    expect(iso(nextOccurrence(twice, "UTC", at("2026-10-13T00:00:00Z")))).toBe("2026-10-15T09:00:00.000Z");
    const first: ScheduleRule = { every: "month", on: "first", at: "08:00" };
    expect(iso(nextOccurrence(first, "UTC", at("2026-10-01T08:00:00Z")))).toBe("2026-11-01T08:00:00.000Z");
    const last: ScheduleRule = { every: "month", on: "last", at: "18:00" };
    expect(iso(nextOccurrence(last, "UTC", at("2026-02-03T00:00:00Z")))).toBe("2026-02-28T18:00:00.000Z");
    expect(iso(nextOccurrence(last, "UTC", at("2028-02-03T00:00:00Z")))).toBe("2028-02-29T18:00:00.000Z");
    expect(iso(nextOccurrence(last, "UTC", at("2026-01-31T18:00:00Z")))).toBe("2026-02-28T18:00:00.000Z");
  });
});

describe("latestOccurrence", () => {
  it("is the due time a late dispatcher runs: only the latest missed one", () => {
    // Down over Monday morning and back on Tuesday: one run, for the Monday it missed.
    expect(iso(latestOccurrence(mondays, "UTC", at("2026-10-20T08:00:00Z")))).toBe("2026-10-19T07:00:00.000Z");
    expect(iso(latestOccurrence(mondays, "UTC", at("2026-10-19T07:00:00Z")))).toBe("2026-10-19T07:00:00.000Z");
    expect(iso(latestOccurrence(mondays, "UTC", at("2026-10-19T06:59:59Z")))).toBe("2026-10-12T07:00:00.000Z");
  });
});

describe("checks", () => {
  it("judge the last whole week or month (weeks start on Monday)", () => {
    const wednesday = at("2026-10-14T10:00:00Z");
    expect(periodStart(wednesday, "week")).toBe("2026-10-12");
    expect(lastWholePeriod(wednesday, "week")).toBe("2026-10-05");
    expect(lastWholePeriod(wednesday, "month")).toBe("2026-09-01");
    expect(addPeriods("2026-01-01", 1, "month")).toBe("2026-02-01");
    expect(addPeriods("2026-12-28", 1, "week")).toBe("2027-01-04");
  });

  it("read at 06:00 where the workspace is, once the period has closed in UTC", () => {
    // Having judged the week of Oct 5, the next is the week of Oct 12, closing Monday Oct 19 at 00:00 UTC.
    // In Tokyo that's 09:00 Monday, after 06:00, so it's read on Tuesday; in Los Angeles it's 17:00 Sunday.
    expect(iso(nextCheckAt("2026-10-05", "week", "Asia/Tokyo"))).toBe("2026-10-19T21:00:00.000Z");
    expect(iso(nextCheckAt("2026-10-05", "week", "America/Los_Angeles"))).toBe("2026-10-19T13:00:00.000Z");
    expect(iso(nextCheckAt("2026-10-05", "week", "UTC"))).toBe("2026-10-19T06:00:00.000Z");
    // Months the same way: September judged, October closes on Nov 1.
    expect(iso(nextCheckAt("2026-09-01", "month", "Europe/Berlin"))).toBe("2026-11-01T05:00:00.000Z");
    expect(iso(checkHourFrom(at("2026-10-14T05:59:00Z"), "UTC"))).toBe("2026-10-14T06:00:00.000Z");
    expect(iso(checkHourFrom(at("2026-10-14T06:00:01Z"), "UTC"))).toBe("2026-10-15T06:00:00.000Z");
  });
});

describe("the roundup", () => {
  it("goes at the next 07:00, keyed by its local day", () => {
    const due = nextLocalTime("07:00", "Asia/Tokyo", at("2026-10-14T23:00:00Z"));
    expect(iso(due)).toBe("2026-10-15T22:00:00.000Z");
    expect(localDate(due, "Asia/Tokyo")).toBe("2026-10-16");
  });
});

describe("time zones", () => {
  it("knows one from a typo", () => {
    expect(isTimeZone("Europe/Berlin")).toBe(true);
    expect(isTimeZone("Europe/Berlinn")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(isTimeZone(7)).toBe(false);
  });
});

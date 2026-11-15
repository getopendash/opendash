/**
 * Time ranges for metric queries, in UTC (the org's timezone and fiscal calendar come later). A range is
 * [from, to): `last_month` on 2026-10-10 is 2026-09-01 to 2026-10-01. "last_N_<unit>" means the N whole periods before
 * the current one, never the current, partial one.
 */
import type { TimeGrain } from "@opendash/connectors";
import { LAST_N, type TimeRange } from "./spec";

export interface Range {
  from: Date;
  to: Date;
}

const UNIT: Record<string, TimeGrain> = {
  days: "day",
  weeks: "week",
  months: "month",
  quarters: "quarter",
  years: "year",
};

/** The first instant of the period of `grain` that contains `t`. Weeks start on Monday. */
export function startOf(t: Date, grain: TimeGrain): Date {
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth();
  switch (grain) {
    case "day":
      return new Date(Date.UTC(y, m, t.getUTCDate()));
    case "week": {
      const day = new Date(Date.UTC(y, m, t.getUTCDate()));
      return shift(day, -((day.getUTCDay() + 6) % 7), "day");
    }
    case "month":
      return new Date(Date.UTC(y, m, 1));
    case "quarter":
      return new Date(Date.UTC(y, m - (m % 3), 1));
    case "year":
      return new Date(Date.UTC(y, 0, 1));
  }
}

/** `t` moved by `n` periods of `grain`. Months land on the same day, which period starts always have (the 1st). */
export function shift(t: Date, n: number, grain: TimeGrain): Date {
  const d = new Date(t);
  if (grain === "day") d.setUTCDate(d.getUTCDate() + n);
  else if (grain === "week") d.setUTCDate(d.getUTCDate() + 7 * n);
  else if (grain === "month") d.setUTCMonth(d.getUTCMonth() + n);
  else if (grain === "quarter") d.setUTCMonth(d.getUTCMonth() + 3 * n);
  else d.setUTCFullYear(d.getUTCFullYear() + n);
  return d;
}

const period = (now: Date, grain: TimeGrain, offset: number): Range => {
  const start = shift(startOf(now, grain), offset, grain);
  return { from: start, to: shift(start, 1, grain) };
};

/** The range a token or two dates mean at `now`. */
export function resolveRange(range: TimeRange, now: Date): Range {
  if (typeof range === "object") {
    return { from: new Date(`${range.from}T00:00:00Z`), to: new Date(`${range.to}T00:00:00Z`) };
  }
  const n = LAST_N.exec(range);
  if (n) {
    const grain = UNIT[n[2] as string] as TimeGrain;
    const to = startOf(now, grain);
    return { from: shift(to, -Number(n[1]), grain), to };
  }
  switch (range) {
    case "today":
      return period(now, "day", 0);
    case "yesterday":
      return period(now, "day", -1);
    case "this_week":
      return period(now, "week", 0);
    case "last_week":
      return period(now, "week", -1);
    case "this_month":
      return period(now, "month", 0);
    case "last_month":
      return period(now, "month", -1);
    case "this_quarter":
      return period(now, "quarter", 0);
    case "last_quarter":
      return period(now, "quarter", -1);
    case "this_year":
      return period(now, "year", 0);
    case "last_year":
      return period(now, "year", -1);
    case "month_to_date":
      return { from: startOf(now, "month"), to: shift(startOf(now, "day"), 1, "day") };
    case "year_to_date":
      return { from: startOf(now, "year"), to: shift(startOf(now, "day"), 1, "day") };
  }
  throw new Error(`Unknown range ${range}`);
}

/** The grain a range naturally has (last_month → month), for a comparison that names no grain. */
export function rangeGrain(range: TimeRange | undefined): TimeGrain | null {
  if (!range || typeof range === "object") return null;
  const n = LAST_N.exec(range);
  if (n) return UNIT[n[2] as string] as TimeGrain;
  const unit = /(day|week|month|quarter|year)/.exec(range === "today" || range === "yesterday" ? "day" : range)?.[1];
  return (unit as TimeGrain | undefined) ?? null;
}

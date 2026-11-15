/**
 * A period filter's value as a range of days: `this_month`, `last_12_months`, or one month, `2026-09`. A range is
 * half-open, [from, to), as dates (`2026-09-01`), compared as the warehouse's calendar days at midnight UTC: the same
 * days a chart's months group by (the compiler truncates in UTC), and the same way an answer's periods are bound. The
 * workspace's time zone decides only what today is.
 *
 * A period still going (this month, this year) runs to the end of today, and the period before it compares the same
 * stretch: this month to the 7th against last month to the 7th (to its last day when it's shorter).
 *
 * Bound on the server only (bind.ts): the frame sends the value it shows, never dates.
 */

export const PERIODS = [
  "this_month",
  "last_month",
  "last_3_months",
  "last_6_months",
  "last_12_months",
  "this_year",
  "last_year",
] as const;
export type PeriodPreset = (typeof PERIODS)[number];

/** A range of days, [from, to), as ISO dates. */
export interface Range {
  from: string;
  to: string;
}

interface Day {
  y: number;
  m: number;
  d: number;
}

/** Today's date where the workspace is. */
function today(now: Date, tz: string): Day {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day") };
}

const iso = (d: Day) =>
  `${String(d.y).padStart(4, "0")}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
const daysIn = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
/** A day months later (negative: earlier), its day of the month kept or, past the month's end, its last day. */
const addMonths = (day: Day, n: number): Day => {
  const i = day.y * 12 + (day.m - 1) + n;
  const y = Math.floor(i / 12);
  const m = (i % 12) + 1;
  return { y, m, d: Math.min(day.d, daysIn(y, m)) };
};
const nextDay = (day: Day): Day => {
  const t = new Date(Date.UTC(day.y, day.m - 1, day.d + 1));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;
/** A range of days someone picked: `2026-01-05..2026-02-10`, both days in it. */
const RANGE = /^(\d{4})-(\d{2})-(\d{2})\.\.(\d{4})-(\d{2})-(\d{2})$/;
/** The longest range a period may be: five years of days. */
const MAX_RANGE_DAYS = 5 * 366;

const dayOf = (y: string, m: string, d: string): Day | null => {
  const t = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return t.getUTCFullYear() === Number(y) && t.getUTCMonth() === Number(m) - 1 && t.getUTCDate() === Number(d)
    ? { y: Number(y), m: Number(m), d: Number(d) }
    : null;
};
const epochDay = (d: Day) => Date.UTC(d.y, d.m - 1, d.d) / 86_400_000;
const fromEpochDay = (n: number): Day => {
  const t = new Date(n * 86_400_000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};

/** A picked range's first and last days, or null when it isn't one (a day that doesn't exist, backwards, too long). */
function rangeOf(value: string): { first: Day; last: Day } | null {
  const r = RANGE.exec(value);
  if (!r) return null;
  const first = dayOf(r[1] as string, r[2] as string, r[3] as string);
  const last = dayOf(r[4] as string, r[5] as string, r[6] as string);
  if (!first || !last) return null;
  const days = epochDay(last) - epochDay(first);
  return days >= 0 && days <= MAX_RANGE_DAYS ? { first, last } : null;
}

/** Whether a value is a period: a preset, a month, or a picked range of days. */
export function isPeriodValue(value: string): boolean {
  return (PERIODS as readonly string[]).includes(value) || MONTH.test(value) || rangeOf(value) !== null;
}

/** A period's first day, its months, and whether it's still going (it runs to the end of today). */
function shape(value: string, t: Day): { start: Day; months: number; toDate: boolean } | null {
  const month = MONTH.exec(value);
  const first = { y: t.y, m: t.m, d: 1 };
  if (month) return { start: { y: Number(month[1]), m: Number(month[2]), d: 1 }, months: 1, toDate: false };
  if (value === "this_month") return { start: first, months: 1, toDate: true };
  if (value === "last_month") return { start: addMonths(first, -1), months: 1, toDate: false };
  if (value === "last_3_months") return { start: addMonths(first, -3), months: 3, toDate: false };
  if (value === "last_6_months") return { start: addMonths(first, -6), months: 6, toDate: false };
  if (value === "last_12_months") return { start: addMonths(first, -12), months: 12, toDate: false };
  if (value === "this_year") return { start: { y: t.y, m: 1, d: 1 }, months: 12, toDate: true };
  if (value === "last_year") return { start: { y: t.y - 1, m: 1, d: 1 }, months: 12, toDate: false };
  return null;
}

/** A period's days now; null for a value that isn't a period. */
export function periodRange(value: string, now: Date, tz: string): Range | null {
  const picked = rangeOf(value);
  if (picked) return { from: iso(picked.first), to: iso(nextDay(picked.last)) };
  const t = today(now, tz);
  const p = shape(value, t);
  if (!p) return null;
  return { from: iso(p.start), to: iso(p.toDate ? nextDay(t) : addMonths(p.start, p.months)) };
}

/** The same days a year before: a period's range moved back twelve months (29 February to the 28th). */
export function yearBeforeRange(value: string, now: Date, tz: string): Range | null {
  const r = periodRange(value, now, tz);
  if (!r) return null;
  const day = (s: string): Day => {
    const [y, m, d] = s.split("-").map(Number) as [number, number, number];
    return { y, m, d };
  };
  // The last day in it moved back a year, then its end: a one-day period keeps its day (29 Feb's is 28 Feb).
  const last = fromEpochDay(epochDay(day(r.to)) - 1);
  return { from: iso(addMonths(day(r.from), -12)), to: iso(nextDay(addMonths(last, -12))) };
}

/** The period before a period, the same length; for one still going, the same stretch of the one before. */
export function previousRange(value: string, now: Date, tz: string): Range | null {
  const picked = rangeOf(value);
  if (picked) {
    const days = epochDay(picked.last) - epochDay(picked.first) + 1;
    return { from: iso(fromEpochDay(epochDay(picked.first) - days)), to: iso(picked.first) };
  }
  const t = today(now, tz);
  const p = shape(value, t);
  if (!p) return null;
  const start = addMonths(p.start, -p.months);
  return { from: iso(start), to: iso(p.toDate ? nextDay(addMonths(t, -p.months)) : p.start) };
}

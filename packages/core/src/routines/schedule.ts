/**
 * When routines run and metrics are checked, in the workspace's time zone. Computed with Intl, so daylight
 * saving moves the UTC instant, never the local time. A local time that doesn't exist (a spring-forward hour) runs
 * when the clocks resume; one that happens twice (a fall-back hour) runs once.
 */
import type { ScheduleRule, Weekday } from "./spec";

/** A metric is checked at this local hour, once its period has closed: after midnight anywhere, before work starts. */
export const CHECK_HOUR = 6;
/** The day's roundup of findings goes out at this local time. */
export const ROUNDUP_AT = "07:00";

const DAY_MS = 86_400_000;
/** How far back or ahead an occurrence is looked for: past the longest gap between two (a month's last day). */
const HORIZON_DAYS = 66;
const WEEKDAY_INDEX: Record<Weekday, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The wall-clock time in `tz` at `date`, as if it were UTC (milliseconds). */
function zoned(date: Date, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  ) as Record<string, string | undefined>;
  const n = (k: string) => Number(parts[k] ?? 0);
  return Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
}

/**
 * The UTC instant of a local wall-clock time in `tz` (day `d` of month `m`, 0-based, may overflow). Tried at the
 * zone's offset a day either side: a time that happens twice is the first; one the clocks skip is as far past the
 * change as it would have been (02:30 in a 02:00–03:00 gap is 03:30), east or west of UTC alike.
 */
function fromZoned(y: number, m: number, d: number, hour: number, minute: number, tz: string): Date {
  const wall = Date.UTC(y, m, d, hour, minute);
  const offsets = [wall - DAY_MS, wall + DAY_MS].map((t) => zoned(new Date(t), tz) - t);
  const candidates = [...new Set(offsets)].map((offset) => wall - offset);
  const exact = candidates.filter((t) => zoned(new Date(t), tz) === wall);
  return new Date(exact.length ? Math.min(...exact) : Math.max(...candidates));
}

/** The local calendar day of `date` in `tz`, at UTC midnight (for stepping through days). */
function localDay(date: Date, tz: string): Date {
  const local = new Date(zoned(date, tz));
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()));
}

/** "YYYY-MM-DD" of the local day `date` falls on in `tz`. */
export function localDate(date: Date, tz: string): string {
  return localDay(date, tz).toISOString().slice(0, 10);
}

const parseAt = (at: string) => {
  const [h, m] = at.split(":").map(Number);
  return { hour: h ?? 0, minute: m ?? 0 };
};

function matches(rule: ScheduleRule, day: Date): boolean {
  if (rule.every === "day") return true;
  if (rule.every === "week") return rule.days.some((d) => WEEKDAY_INDEX[d] === day.getUTCDay());
  if (rule.on === "first") return day.getUTCDate() === 1;
  return new Date(day.getTime() + DAY_MS).getUTCDate() === 1;
}

const at = (rule: { at: string }, day: Date, tz: string) => {
  const { hour, minute } = parseAt(rule.at);
  return fromZoned(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute, tz);
};

/** The rule's first occurrence strictly after `after`. */
export function nextOccurrence(rule: ScheduleRule, tz: string, after: Date): Date {
  const first = localDay(after, tz);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = new Date(first.getTime() + i * DAY_MS);
    if (!matches(rule, day)) continue;
    const when = at(rule, day, tz);
    if (when > after) return when;
  }
  throw new Error("A schedule rule with no occurrence");
}

/** The rule's latest occurrence at or before `t`: a run's due time, however late the dispatcher is. */
export function latestOccurrence(rule: ScheduleRule, tz: string, t: Date): Date {
  const last = localDay(t, tz);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const day = new Date(last.getTime() - i * DAY_MS);
    if (!matches(rule, day)) continue;
    const when = at(rule, day, tz);
    if (when <= t) return when;
  }
  throw new Error("A schedule rule with no occurrence");
}

/** The first CHECK_HOUR:00 local at or after `instant`. */
export function checkHourFrom(instant: Date, tz: string): Date {
  const day = localDay(instant, tz);
  for (let i = 0; i <= 2; i++) {
    const when = at({ at: `0${CHECK_HOUR}:00` }, new Date(day.getTime() + i * DAY_MS), tz);
    if (when >= instant) return when;
  }
  throw new Error("No check hour within two days");
}

/** The next local time `HH:MM` strictly after `after` (the roundup's due time). */
/** `atTime` on the local day `day` ("YYYY-MM-DD") in `tz`. */
export function localTimeOn(day: string, atTime: string, tz: string): Date {
  return at({ at: atTime }, new Date(`${day}T00:00:00Z`), tz);
}

export function nextLocalTime(atTime: string, tz: string, after: Date): Date {
  return nextOccurrence({ every: "day", at: atTime }, tz, after);
}

export type CheckGrain = "week" | "month";

/** The first day (UTC, "YYYY-MM-DD") of the period of `grain` containing `t`. Weeks start on Monday. */
export function periodStart(t: Date, grain: CheckGrain): string {
  const day = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
  if (grain === "month") return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1)).toISOString().slice(0, 10);
  const back = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - back * DAY_MS).toISOString().slice(0, 10);
}

/** The period of `grain` `n` periods from the one starting on `period` ("YYYY-MM-DD"). */
export function addPeriods(period: string, n: number, grain: CheckGrain): string {
  const d = new Date(`${period.slice(0, 10)}T00:00:00Z`);
  if (grain === "week") d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

/** The last whole period before `now`'s (the one a check judges). */
export function lastWholePeriod(now: Date, grain: CheckGrain): string {
  return addPeriods(periodStart(now, grain), -1, grain);
}

/**
 * When a check next reads, having judged `period` (or before its first read, with null): the check hour where the
 * workspace is, on or after the instant the following period closes in UTC. In Tokyo a week closes on Monday at 09:00,
 * so its check is on Tuesday at 06:00; in Los Angeles it closes on Sunday at 17:00, and is checked on Monday.
 */
export function nextCheckAt(judged: string, grain: CheckGrain, tz: string): Date {
  const closes = new Date(`${addPeriods(judged, 2, grain)}T00:00:00Z`);
  return checkHourFrom(closes, tz);
}

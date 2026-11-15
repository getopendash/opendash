/**
 * Lumen's calendar: the store reports in America/New_York, so the generator works in New York days. A day is the UTC
 * midnight that stands for that calendar date; an order's UTC instant is its New York wall time plus the offset in
 * force that day (UTC-4 in daylight time, UTC-5 otherwise).
 *
 * The data ends at a moment the caller chooses (`asOf`); the storylines sit on fixed dates, so they hold for any
 * `asOf` after them.
 */
export const DAY = 86_400_000;
export const HOUR = 3_600_000;
/** The first New York day of the history: October 1, 2024. */
export const START = Date.UTC(2024, 9, 1);
/** The end the tests and the reference numbers use: the end of Oct 7, 2026 (UTC). */
export const PINNED_AS_OF = Date.UTC(2026, 9, 7, 23, 59, 59);

/** The end of yesterday (UTC) on the day of `now`: "data up to recent days". */
export const defaultAsOf = (now = Date.now()) => Math.floor(now / DAY) * DAY - 1000;

/** The end of a UTC date given as YYYY-MM-DD. */
export function parseAsOf(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Use a date as YYYY-MM-DD.");
  const t = Date.parse(`${value}T23:59:59Z`);
  if (Number.isNaN(t)) throw new Error("Use a date as YYYY-MM-DD.");
  if (t < Date.UTC(2025, 0, 1)) throw new Error("The data starts in October 2024: choose a date after 2024-12-31.");
  return t;
}

/** The last New York day of data, as an index from START. */
export const lastDayIndex = (asOf: number) => Math.floor((asOf - 4 * HOUR - START) / DAY);

const nthSunday = (year: number, month: number, n: number) => {
  const first = Date.UTC(year, month, 1);
  return first + ((7 - new Date(first).getUTCDay()) % 7) * DAY + (n - 1) * 7 * DAY;
};
/** United States daylight saving time: the second Sunday of March to the first Sunday of November. */
const dstStart = (year: number) => nthSunday(year, 2, 2);
const dstEnd = (year: number) => nthSunday(year, 10, 1);
/** The two dates a year whose small hours are skipped or repeated: no order is placed in them. */
const isTransition = (localDate: number) => {
  const y = new Date(localDate).getUTCFullYear();
  return localDate === dstStart(y) || localDate === dstEnd(y);
};

export const dayStart = (i: number) => START + i * DAY;
export const isDst = (localDate: number) => {
  const y = new Date(localDate).getUTCFullYear();
  return localDate >= dstStart(y) && localDate < dstEnd(y);
};
/** Hours to add to New York wall time to get UTC on a local date. */
export const etOffset = (localDate: number) => (isDst(localDate) ? 4 : 5);

/** The UTC instant of a New York wall time on day `i`. */
export function etInstant(i: number, hour: number, minute: number, second: number) {
  const date = dayStart(i);
  const h = isTransition(date) && hour <= 3 ? 4 : hour;
  return date + (h + etOffset(date)) * HOUR + minute * 60_000 + second * 1000;
}

/** The New York calendar date (as its UTC midnight) of a UTC instant. */
export function etDate(t: number) {
  const guess = Math.floor((t - 4 * HOUR) / DAY) * DAY;
  if (isDst(guess)) return guess;
  return Math.floor((t - 5 * HOUR) / DAY) * DAY;
}
export const etDayIndex = (t: number) => Math.round((etDate(t) - START) / DAY);

export const ymd = (t: number) => new Date(t).toISOString().slice(0, 10);
export const day = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - START) / DAY);

/** Days of the storylines and cutovers, as New York day indexes. */
export const EVENTS = {
  /** Black Friday and its weekend in 2025 (Friday Nov 28), and Cyber Monday. */
  bf25: day(2025, 11, 28),
  cm25: day(2025, 12, 1),
  bf26: day(2026, 11, 27),
  cm26: day(2026, 11, 30),
  bf24: day(2024, 11, 29),
  cm24: day(2024, 12, 2),
  /** The 2025 promotion: Nov 24 to Dec 2. */
  promo25: [day(2025, 11, 24), day(2025, 12, 2)] as const,
  promo24: [day(2024, 11, 25), day(2024, 12, 3)] as const,
  promo26: [day(2026, 11, 23), day(2026, 12, 1)] as const,
  /** Holiday orders whose return window runs to the end of January. */
  holiday25: [day(2025, 11, 15), day(2025, 12, 24)] as const,
  /** The Halo price rise, and where conversion fell. */
  priceRise: day(2026, 3, 10),
  /** The top SKU is out of stock from July 6 to July 26, 2026 (21 days). */
  stockout: [day(2026, 7, 6), day(2026, 7, 26)] as const,
  /** Parcelo's backlog: UK orders shipped from Sep 8 to Sep 30, 2026. */
  delay: [day(2026, 9, 8), day(2026, 9, 30)] as const,
  /** Meta Lookalike – Winter Glow runs from Oct 15, 2025 to Apr 30, 2026. */
  winterGlow: [day(2025, 10, 15), day(2026, 4, 30)] as const,
  /** Status spellings changed: 'shipped' became 'fulfilled', 'canceled' became 'cancelled'. */
  fulfilledFrom: day(2025, 4, 15),
  cancelledFrom: day(2025, 6, 1),
  /** The Aurora Table Lamp's variants were re-SKUed. */
  reSku: day(2025, 9, 1),
  /** The Ember Taper Set was discontinued and soft-deleted. */
  taperDeleted: day(2026, 2, 1),
  haloClusterLaunch: day(2025, 3, 1),
  duneLaunch: day(2025, 4, 1),
};

export const inRange = (i: number, r: readonly [number, number]) => i >= r[0] && i <= r[1];

/** Seasonality of demand by calendar month (0 = January): the summer dip and the holiday peak. */
const MONTH_INDEX = [0.86, 0.8, 0.9, 0.93, 0.96, 0.9, 0.8, 0.77, 0.93, 1.06, 1.46, 1.5];
/** The seasonal multiplier on a New York day, smoothed between months. */
export function season(i: number) {
  const d = new Date(dayStart(i));
  const m = d.getUTCMonth();
  const dim = new Date(Date.UTC(d.getUTCFullYear(), m + 1, 0)).getUTCDate();
  const t = (d.getUTCDate() - 1) / dim;
  const a = MONTH_INDEX[m] as number;
  const b = MONTH_INDEX[(m + 1) % 12] as number;
  let s = a + (b - a) * t * t;
  // The holiday peak falls off after the 20th of December.
  if (m === 11 && d.getUTCDate() > 20) s *= 1 - (d.getUTCDate() - 20) * 0.045;
  return s;
}

/** Weekday pattern: Sunday and Monday evenings are busy, Saturday is quiet. */
const DOW = [1.04, 1.08, 1.03, 1.0, 0.97, 0.94, 0.9];
export const weekday = (i: number) => DOW[new Date(dayStart(i)).getUTCDay()] as number;

/** Sessions, and conversion, on the Black Friday weekends. */
export function eventTraffic(i: number) {
  if (i === EVENTS.bf25) return { sessions: 3.6, cr: 1.45 };
  if (i === EVENTS.bf25 + 1) return { sessions: 2.5, cr: 1.3 };
  if (i === EVENTS.bf25 + 2) return { sessions: 2.1, cr: 1.25 };
  if (i === EVENTS.cm25) return { sessions: 2.9, cr: 1.4 };
  if (i === EVENTS.cm25 + 1) return { sessions: 1.6, cr: 1.15 };
  if (i === EVENTS.bf26) return { sessions: 3.6, cr: 1.45 };
  if (i === EVENTS.bf26 + 1) return { sessions: 2.5, cr: 1.3 };
  if (i === EVENTS.bf26 + 2) return { sessions: 2.1, cr: 1.25 };
  if (i === EVENTS.cm26) return { sessions: 2.9, cr: 1.4 };
  if (i === EVENTS.cm26 + 1) return { sessions: 1.6, cr: 1.15 };
  if (i === EVENTS.bf24) return { sessions: 3.0, cr: 1.4 };
  if (i === EVENTS.bf24 + 1) return { sessions: 2.1, cr: 1.25 };
  if (i === EVENTS.bf24 + 2) return { sessions: 1.8, cr: 1.2 };
  if (i === EVENTS.cm24) return { sessions: 2.4, cr: 1.35 };
  return { sessions: 1, cr: 1 };
}

/** Hours of the New York day orders are placed in, by where the customer is: a UK evening is early afternoon here. */
const HOURS_US = [
  1.5, 0.8, 0.5, 0.4, 0.5, 1, 2, 3.5, 4.5, 5, 5, 5.2, 5.2, 5, 4.8, 4.6, 4.8, 5.4, 6.2, 7.2, 8, 7.4, 5.4, 3,
];
const HOURS_EU = [
  0.3, 0.2, 0.2, 0.2, 0.3, 1.2, 3, 5, 6.5, 8, 8.4, 8, 7.6, 7, 6.2, 4.8, 3.4, 2.4, 1.8, 1.4, 1.2, 0.8, 0.6, 0.4,
];
const HOURS_GB = [
  0.4, 0.3, 0.2, 0.2, 0.3, 0.6, 1.4, 3, 5, 6.4, 7, 7.4, 7.6, 7.8, 7, 5.6, 4.4, 3.2, 2.4, 1.8, 1.4, 1, 0.7, 0.5,
];
export const hourWeights = (country: string) =>
  country === "GB" ? HOURS_GB : country === "US" || country === "CA" ? HOURS_US : HOURS_EU;

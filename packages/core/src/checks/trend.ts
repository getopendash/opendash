/**
 * Trend shifts (change-point detector): a metric whose month-on-month change moved, and stayed
 * moved, rather than one odd month (the anomaly detector's job). The shift is the longest run of recent changes, at
 * least 3, whose median differs from the median of the 6 changes before the run by more than a threshold (k scaled
 * MADs of those 6, and at least a minimum shift), with every change in it past that median by half the threshold.
 * Its first month is where the shift began, so it stays put while the shift goes on (an insight's key). A shift held
 * for more than 6 months is the new normal: a later shift is measured against months inside it.
 * Deterministic: no model.
 */
import { formatNumber } from "../answer/format";
import { displayMetric, type MetricFormat } from "../figures/metric";
import type { SeriesPoint } from "./detect";

export const TREND_RECENT = 3;
export const TREND_BEFORE = 6;
/** Longer than this, a shift is the new normal. */
export const TREND_LONGEST = 6;

export interface TrendSpec {
  /** The threshold in scaled MADs of the changes before. */
  madK: number;
  /** The smallest shift worth saying: 0.015 is 1.5 points of growth a month (relative), or that share of the level. */
  minShift: number;
}

export const DEFAULT_TREND: TrendSpec = { madK: 3, minShift: 0.015 };

export interface TrendShift {
  direction: "up" | "down";
  /** Changes as shares a month (a metric that stays positive), else in the metric's units. */
  relative: boolean;
  /** The median change over the 6 months before the shift, and over the shift. */
  before: number;
  recent: number;
  /** The shift's first month, and how many months it's held. */
  since: string;
  months: number;
  /** The latest month (a cell of the query run). */
  latest: { period: string; value: number; row: number };
  severity: 1 | 2 | 3;
}

type Known = SeriesPoint & { value: number };
type Candidate = Pick<TrendShift, "direction" | "before" | "recent" | "months" | "severity">;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const next = (period: string) => {
  const d = new Date(`${period.slice(0, 10)}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
};

/** The shift that ends at the latest month, or null when there isn't one (or too few months in a row to tell). */
export function trendShift(points: SeriesPoint[], spec: TrendSpec = DEFAULT_TREND): TrendShift | null {
  const known = points.filter((p): p is Known => p.value !== null && Number.isFinite(p.value));
  // The months in a row that end at the latest one.
  const run: Known[] = [];
  for (let i = known.length - 1; i >= 0; i--) {
    const p = known[i] as Known;
    if (run.length && next(p.period) !== (run[0] as Known).period.slice(0, 10)) break;
    run.unshift(p);
  }
  if (run.length < TREND_BEFORE + TREND_RECENT + 1) return null;
  const relative = run.every((p) => p.value > 0);
  const changes = run.slice(1).map((p, i) => {
    const before = (run[i] as Known).value;
    return relative ? p.value / before - 1 : p.value - before;
  });
  const level = Math.abs(median(run.map((p) => p.value))) || 1;
  const floor = relative ? spec.minShift : spec.minShift * level;
  // Each trailing run of changes, against the 6 before it.
  const shifted: Candidate[] = [];
  for (let n = TREND_RECENT; n <= changes.length - TREND_BEFORE; n++) {
    const recent = changes.slice(changes.length - n);
    const earlier = changes.slice(changes.length - n - TREND_BEFORE, changes.length - n);
    const before = median(earlier);
    const lately = median(recent);
    const sigma = 1.4826 * median(earlier.map((c) => Math.abs(c - before)));
    const threshold = Math.max(spec.madK * sigma, floor);
    const shift = lately - before;
    if (Math.abs(shift) <= threshold) continue;
    const direction = shift > 0 ? "up" : "down";
    const margin = threshold / 2;
    if (!recent.every((c) => (direction === "up" ? c > before + margin : c < before - margin))) continue;
    const ratio = Math.abs(shift) / threshold;
    shifted.push({ direction, before, recent: lately, months: n, severity: ratio >= 3 ? 3 : ratio >= 2 ? 2 : 1 });
  }
  // The longest is the shift; past 6 months it's the new normal, and only a shift inside it counts.
  let found: Candidate | undefined;
  let limit = changes.length - TREND_BEFORE;
  for (;;) {
    found = shifted.filter((c) => c.months <= limit).at(-1);
    if (!found || found.months <= TREND_LONGEST) break;
    limit = found.months - TREND_BEFORE;
  }
  if (!found) return null;
  const last = run.at(-1) as Known;
  return {
    ...found,
    relative,
    since: (run[run.length - found.months] as Known).period.slice(0, 10),
    latest: { period: last.period.slice(0, 10), value: last.value, row: last.row },
  };
}

/** The shift in words, true to its signs: "growth slowed", "decline eased", "turned from growth to decline". */
export function trendPhrase(t: Pick<TrendShift, "before" | "recent" | "direction">): {
  /** A noun phrase takes the metric's possessive ("MRR's growth slowed"); a verb phrase doesn't. */
  phrase: string;
  noun: boolean;
} {
  if (t.before > 0 && t.recent > 0)
    return { phrase: t.direction === "up" ? "growth sped up" : "growth slowed", noun: true };
  if (t.before < 0 && t.recent < 0) {
    return { phrase: t.direction === "up" ? "decline eased" : "decline steepened", noun: true };
  }
  if (t.recent === 0) return { phrase: t.before > 0 ? "stopped growing" : "stopped falling", noun: false };
  if (t.before === 0) return { phrase: t.recent > 0 ? "started growing" : "started falling", noun: false };
  return { phrase: t.recent < 0 ? "turned from growth to decline" : "turned from decline to growth", noun: false };
}

/** "New accounts' growth slowed over the last 3 months". Words only. */
export function trendTitle(title: string, t: Pick<TrendShift, "before" | "recent" | "direction" | "months">): string {
  const { phrase, noun } = trendPhrase(t);
  const who = noun ? (title.endsWith("s") ? `${title}'` : `${title}'s`) : title;
  return `${who} ${phrase} over the last ${t.months} months`;
}

/** A change a month: "6.4% a month" (relative), "+$12.3k a month" (in the metric's units). */
export function trendRate(format: MetricFormat, relative: boolean, change: number): string {
  const sign = change < 0 ? "−" : change > 0 && !relative ? "+" : "";
  const size = relative
    ? formatNumber(Math.abs(change), { percent: true, decimals: 1 })
    : displayMetric(format, Math.abs(change));
  return `${sign}${size} a month`;
}

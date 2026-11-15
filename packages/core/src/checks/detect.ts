/**
 * Detection: deterministic, no model. A metric's weekly or monthly series is judged against its own
 * recent behaviour: each period's change from the one before is compared with the median change of the periods before
 * it, within k scaled MADs (median absolute deviations). Changes are relative for a metric that stays positive (MRR
 * growing 4% a month is its normal) and absolute otherwise. A period only has a band once enough periods precede it.
 * Each observation keeps its band's width per unit of k (`spread`), so every routine judges the same read at its own
 * sensitivity.
 */
import { addPeriods, type CheckGrain } from "../routines/schedule";

export interface DetectorSpec {
  /** How many prior changes the baseline uses at most. */
  window: number;
  /** Minimum prior changes before a period gets a band; fewer, and the check abstains. */
  minHistory: number;
  /** The band's half-width in scaled MADs: higher is calmer. */
  madK: number;
  /** A change smaller than this, against the expected value, is never an insight (relative, absolute, or both). */
  materiality: { pct?: number; abs?: number };
  /** How many consecutive periods beyond the band, the same way, before it's an insight. */
  persistence: number;
}

export const DEFAULT_DETECTOR: DetectorSpec = {
  window: 12,
  minHistory: 6,
  madK: 3,
  materiality: { pct: 0.05 },
  persistence: 1,
};

export interface SeriesPoint {
  /** The period's first day, YYYY-MM-DD. */
  period: string;
  value: number | null;
  /** Its row in the query run, for the trace. */
  row: number;
}

export interface Observed {
  period: string;
  value: number;
  row: number;
  /** The band (at the spec's k) and its centre; null while too few periods precede it. */
  expected: number | null;
  expectedLo: number | null;
  expectedHi: number | null;
  /** The band's half-width at k = 1, in the metric's units; null without a band. */
  spread: number | null;
  /** How far the change is from the median change, in scaled MADs (capped at ±99); null without a band. */
  score: number | null;
}

/** MAD × 1.4826 estimates a normal distribution's standard deviation. */
const MAD_SCALE = 1.4826;
const SCORE_CAP = 99;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** Each period with a value, judged against the periods before it. */
export function observe(points: SeriesPoint[], spec: DetectorSpec, grain: CheckGrain = "month"): Observed[] {
  const known = points.filter(
    (p): p is SeriesPoint & { value: number } => p.value !== null && Number.isFinite(p.value),
  );
  const relative = known.every((p) => p.value > 0);
  // The change into each period, when the one before it is known and adjacent (a gap is never read as a change).
  const changes: (number | null)[] = known.map((p, i) => {
    const before = known[i - 1];
    if (!before || addPeriods(before.period, 1, grain) !== p.period.slice(0, 10)) return null;
    return relative ? p.value / before.value - 1 : p.value - before.value;
  });
  return known.map((p, i) => {
    const prior = changes
      .slice(0, i)
      .filter((c): c is number => c !== null)
      .slice(-spec.window);
    const change = changes[i];
    const before = known[i - 1];
    const none = {
      period: p.period,
      value: p.value,
      row: p.row,
      expected: null,
      expectedLo: null,
      expectedHi: null,
      spread: null,
      score: null,
    };
    if (change === null || change === undefined || !before || prior.length < spec.minHistory) return none;
    const centre = median(prior);
    const sigma = MAD_SCALE * median(prior.map((c) => Math.abs(c - centre)));
    const spread = sigma * (relative ? before.value : 1);
    const half = spec.madK * spread;
    const expected = relative ? before.value * (1 + centre) : before.value + centre;
    const raw = sigma > 0 ? (change - centre) / sigma : change === centre ? 0 : Math.sign(change - centre) * SCORE_CAP;
    return {
      ...none,
      expected,
      // A metric that's always been positive can't be expected below zero.
      expectedLo: relative ? Math.max(0, expected - half) : expected - half,
      expectedHi: expected + half,
      spread,
      score: Math.max(-SCORE_CAP, Math.min(SCORE_CAP, raw)),
    };
  });
}

export interface Candidate {
  observed: Observed & { expected: number; expectedLo: number; expectedHi: number; spread: number };
  direction: "up" | "down";
  /** How many times the materiality threshold the miss is. */
  impact: number;
  /** 1 notable, 2 large, 3 very large. */
  severity: 1 | 2 | 3;
}

/**
 * The latest period as an insight's candidate: beyond its band, by more than the materiality threshold, and
 * for `persistence` periods in a row the same way. Null otherwise, or while it has no band.
 */
export function candidateOf(observed: Observed[], spec: DetectorSpec): Candidate | null {
  const last = observed.at(-1);
  if (!last || last.expected === null || last.expectedLo === null || last.expectedHi === null || last.spread === null) {
    return null;
  }
  const direction = last.value > last.expectedHi ? "up" : last.value < last.expectedLo ? "down" : null;
  if (!direction) return null;
  const run = observed.slice(-spec.persistence);
  const beyond = (o: Observed) =>
    o.expectedLo !== null &&
    o.expectedHi !== null &&
    (direction === "up" ? o.value > o.expectedHi : o.value < o.expectedLo);
  if (run.length < spec.persistence || !run.every(beyond)) return null;
  const miss = Math.abs(last.value - last.expected);
  const threshold = Math.max(spec.materiality.abs ?? 0, (spec.materiality.pct ?? 0) * Math.abs(last.expected));
  if (threshold <= 0 || miss < threshold) return null;
  const impact = miss / threshold;
  return {
    observed: {
      ...last,
      expected: last.expected,
      expectedLo: last.expectedLo,
      expectedHi: last.expectedHi,
      spread: last.spread,
    },
    direction,
    impact,
    severity: impact >= 4 ? 3 : impact >= 2 ? 2 : 1,
  };
}

/**
 * Whether a candidate found at one sensitivity is beyond the band at another (a routine's own k): the same centre, the
 * band `k × spread` wide each side. (A floor at zero changes nothing here: it only binds for values that stay positive.)
 */
export function beyondAt(o: { value: number; expected: number; spread: number }, k: number): boolean {
  return Math.abs(o.value - o.expected) > k * o.spread;
}

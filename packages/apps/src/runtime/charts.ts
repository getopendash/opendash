// Charts as drawn: a query's answer, as an App's Chart asks for it, turned into what ECharts draws, the
// same numbers as a table, the points the arrow keys step through, and what was cut, said. Pure (no DOM, no ECharts): the kit draws
// what this returns, and the tests read it.
//
// Each type reads its query in the one shape `checkDefinition` holds it to (contracts.ts). Dates line up by their
// buckets across the period the filter chose (a bucket with no row is a zero for a count or a sum, a gap otherwise);
// the period before lines up bucket for bucket. Series past the palette's six are summed into "Other" only when the
// measure adds up and every row came back; otherwise the cut is said. Colours follow the series, never their rank.
import {
  type ChartType,
  grainOf,
  groupsOf,
  isAdditive,
  MAX_BOXES,
  MAX_BULLETS,
  MAX_DAYS,
  MAX_FLOWS,
  MAX_HEAT_COLUMNS,
  MAX_HEAT_ROWS,
  MAX_PANELS,
  MAX_SERIES,
  MAX_SPANS,
} from "../dashboard/contracts";
import type { NamedQuery } from "../dashboard/definition";
import type { Range } from "../dashboard/periods";
import type { Grain } from "../protocol";
import type { Result } from "./data";
import { type Format, format } from "./values";

/** The colours a chart draws with, read from the page's theme. */
export interface Theme {
  /** The six series colours, in the validated order. */
  series: string[];
  /** Text. */
  ink: string;
  /** Secondary text: axis labels, a ghost line. */
  muted: string;
  /** Grid lines and borders. */
  rule: string;
  /** What the chart sits on: the gaps between fills. */
  surface: string;
  /** Status colours, for zones that mean good, watch or bad (absent: the muted colour). */
  good?: string;
  warn?: string;
  bad?: string;
}

export type Option = Record<string, unknown>;

/** One row of points the arrow keys step through: a series, or a small chart's series. */
export interface Lane {
  panel: number;
  /** The ECharts series it is, for its tooltip. */
  series: number;
  name: string;
  /** `index`: the point's place in its series (-1: none drawn, read out only). */
  points: { index: number; text: string }[];
}

export interface Drawn {
  /** One chart, or the small charts of one: each its own ECharts option, under a key that stays with it. */
  panels: { key: string; title?: string; option: Option }[];
  /** Each series named beside its colour: shown for two or more. */
  legend: { name: string; color: string; mark: "box" | "line" | "dash" | "tick" }[];
  /** The same numbers as a table. */
  table: { head: string[]; numeric: boolean[]; rows: string[][] };
  lanes: Lane[];
  /** What was cut or left out, said. */
  notes: string[];
  /** Points drawn: none, and the chart says it's empty. */
  points: number;
  /** A panel's height; and the width under which it scrolls sideways. */
  height: number;
  minWidth?: number;
  /** What it is in words, for a screen reader. */
  summary: string;
  /** The group a press on a point opens (its rows, through the query's drill); null for "Other" or a ghost. */
  pick(
    panel: number,
    series: number,
    index: number,
  ): { group: Record<string, string | number | null>; label: string } | null;
}

export interface ChartInput {
  type: ChartType;
  x?: string | undefined;
  y: string[];
  format: Format;
  series?: string | undefined;
  facet?: string | undefined;
  stack?: boolean | undefined;
  top?: number | undefined;
  horizontal?: boolean | undefined;
  target?: number | string | undefined;
  label?: string | undefined;
  stages?: string[] | undefined;
  cumulative?: boolean | undefined;
  title?: string | undefined;
  query: NamedQuery;
  result: Result;
  /** The period before, for a query that compares. */
  previous?: Result | undefined;
  theme: Theme;
  /** The colours for the series drawn, by name: kept for a series while it's drawn. */
  colors: Palette;
  /** The column the query's period filter narrows: dates run along the period only when it's the one grouped by. */
  periodColumn?: string | undefined;
  /** The width it has, for a calendar's cells. */
  width?: number | undefined;
  /** Small multiples on one scale (the default) or each on its own. */
  scale?: "shared" | "own" | undefined;
  /** Lines across it at a value, a band of values, and moments marked along its dates. */
  lines?: { y: number; label: string }[] | undefined;
  band?: { from: number; to: number; label: string } | undefined;
  events?: { at: string; say: string }[] | undefined;
  /** A scatter's named zones and quadrant lines. */
  zones?: { x: [number, number]; y: [number, number]; label: string; tone?: string | undefined }[] | undefined;
  split?: { x?: number | undefined; y?: number | undefined } | undefined;
}

/**
 * What a chart says besides its marks: a target line, a normal band, the moments that explain a change, and the
 * period still running drawn lighter ("Nov so far") so it's never read as a drop. On the first series of a chart
 * with an axis.
 */
function explain(
  option: Record<string, unknown>,
  i: ChartInput,
  axis: { keys: string[]; labels: { axis: string; full: string }[]; dense: boolean },
  grain: Grain | undefined,
  horizontal: boolean,
  notes: string[],
) {
  const t = i.theme;
  const series = option.series as Record<string, unknown>[] | undefined;
  const first = series?.[0];
  if (!series || !first) return;
  // The bucket a day falls in, on a date axis: the one whose span holds it (any grain, any place on the axis).
  const bucketOf = (day: string) =>
    grain ? axis.keys.findIndex((k) => /^\d{4}-\d{2}-\d{2}$/.test(k) && k <= day && day < bucketAt(k, grain, 1)) : -1;
  // The bucket still running, wherever it is: its bars lighter (never the period before's), and said.
  const today = new Date().toISOString().slice(0, 10);
  const now = bucketOf(today);
  if (now >= 0 && grain && bucketAt(axis.keys[now] as string, grain, 1) > today) {
    let styled = false;
    for (const s of series) {
      // The ghost (the period before) is history: drawn as it was.
      if (s.type !== "bar" || !Array.isArray(s.data) || s.z === 1) continue;
      s.data = (s.data as unknown[]).map((v, k) =>
        k === now ? { value: v, itemStyle: { opacity: 0.45 }, emphasis: { itemStyle: { opacity: 0.6 } } } : v,
      );
      styled = true;
    }
    if (styled)
      notes.push(`${axis.labels[now]?.full ?? "The last"} isn't over: it's drawn lighter, as it stands so far.`);
  }
  const lineStyle = { type: "dashed", width: 1, color: mix(t.ink, t.surface, 0.45) };
  const label = (text: string, position: string) => ({
    formatter: text,
    position,
    color: t.muted,
    fontSize: 11,
    backgroundColor: t.surface,
    padding: [1, 4],
  });
  const marks: Record<string, unknown>[] = [];
  for (const l of i.lines ?? []) {
    marks.push({ ...(horizontal ? { xAxis: l.y } : { yAxis: l.y }), label: label(l.label, "insideEndTop") });
    // Said too, not only drawn.
    notes.push(`${l.label}: ${cell(l.y, i.format)}.`);
  }
  for (const e of i.events ?? []) {
    // A month or a day, placed in the bucket that holds it (a day inside a month, a week, a quarter).
    const at = bucketOf(e.at.length === 7 ? `${e.at}-01` : e.at);
    if (at >= 0 && !horizontal) {
      marks.push({ xAxis: at, label: label(e.say, "insideEndTop") });
      notes.push(`${e.say}: ${axis.labels[at]?.full ?? e.at}.`);
    } else notes.push(`"${e.say}" (${e.at}) is outside the dates shown.`);
  }
  if (i.band) notes.push(`${i.band.label}: ${cell(i.band.from, i.format)} to ${cell(i.band.to, i.format)}.`);
  if (marks.length) first.markLine = { silent: true, symbol: "none", lineStyle, data: marks };
  if (i.band) {
    const b = i.band;
    first.markArea = {
      silent: true,
      // A faint wash over the bars, never a block: what's normal, read through.
      itemStyle: { color: t.series[0] ?? t.ink, opacity: 0.1 },
      label: label(b.label, "insideTopLeft"),
      data: [[horizontal ? { xAxis: b.from } : { yAxis: b.from }, horizontal ? { xAxis: b.to } : { yAxis: b.to }]],
    };
  }
}

// ---- colours that follow their series --------------------------------------------------------------------------

/**
 * A chart's colours, kept for its life: a series keeps its colour while it's drawn, so a filter that drops one never
 * repaints the others; a new one takes the first colour none of the drawn ones holds.
 */
export class Palette {
  private held = new Map<string, number>();
  private drawn = new Set<string>();
  /** Slots (0–5) for these names, in their order: at most six, never two the same. */
  assign(names: string[]): number[] {
    const taken = new Set<number>();
    const out: number[] = new Array(names.length).fill(-1);
    // Those drawn last time keep theirs first, then those seen before take theirs back if it's free, then the new.
    const keep = (i: number, n: string, only: boolean) => {
      const had = this.held.get(n);
      if (out[i] === -1 && had !== undefined && (!only || this.drawn.has(n)) && !taken.has(had)) {
        out[i] = had;
        taken.add(had);
      }
    };
    for (const [i, n] of names.entries()) keep(i, n, true);
    for (const [i, n] of names.entries()) keep(i, n, false);
    for (const [i, n] of names.entries()) {
      if (out[i] === -1) {
        let slot = 0;
        while (taken.has(slot)) slot++;
        out[i] = slot;
        taken.add(slot);
      }
      this.held.set(n, out[i] as number);
    }
    this.drawn = new Set(names);
    return out;
  }
}

// ---- small helpers -----------------------------------------------------------------------------------------------

/** Words read as letters (MRR, not Mrr). */
const ACRONYMS = new Set([
  "mrr",
  "arr",
  "csat",
  "nps",
  "id",
  "sla",
  "ltv",
  "cac",
  "roi",
  "kpi",
  "url",
  "api",
  "gmv",
  "aov",
  "arpu",
]);

/** A column's name as a label: "seat_limit" → "Seat limit", "mrr" → "MRR". */
export const human = (name: string) =>
  name
    .split("_")
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w))
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};
const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A number on an axis: short. */
function compact(v: number, f: Format): string {
  if (f === "money" || f === "money-compact") return format(v, "money-compact");
  if (f === "percent") return format(v, "percent");
  return Math.abs(v) >= 10_000
    ? new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(v)
    : format(v, "number");
}

/** A round number at or above n, for a shared axis: 1, 2, 2.5 or 5 times a power of ten. */
export function nice(n: number): number {
  if (!(n > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(n));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= n) return m * p;
  return 10 * p;
}

/** #rrggbb mixed toward another: t of a, the rest b. Colours not in that form come back as a. */
export function mix(a: string, b: string, t: number): string {
  const rgb = (h: string) =>
    /^#[0-9a-f]{6}$/i.test(h) ? [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) : null;
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return a;
  return `#${x
    .map((c, i) =>
      Math.round(c * t + (y[i] as number) * (1 - t))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/** Text that reads on a fill: the dark ink or white, whichever contrasts more with it. */
export function inkOn(fill: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return "#ffffff";
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(fill.slice(i, i + 2), 16) / 255) as [number, number, number];
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const l = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  // Against white (luminance 1) and against the dark ink (#16171c, about 0.009).
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.059 ? "#ffffff" : "#16171c";
}

// ---- dates, by their buckets ---------------------------------------------------------------------------------------

const dayOf = (iso: string) =>
  Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))) / 86_400_000;
const isoOf = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const dateKey = (v: unknown) => String(v).slice(0, 10);
/** A week's Monday (the warehouse's weeks start on Mondays). */
const monday = (day: number) => day - ((new Date(day * 86_400_000).getUTCDay() + 6) % 7);

/** Which bucket of a period a date falls in: 0 for the one holding the period's first day. */
export function bucketIndex(iso: string, from: string, grain: Grain): number {
  const [y, m] = [Number(iso.slice(0, 4)), Number(iso.slice(5, 7))];
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  switch (grain) {
    case "day":
      return dayOf(iso) - dayOf(from);
    case "week":
      return Math.floor((monday(dayOf(iso)) - monday(dayOf(from))) / 7);
    case "month":
      return y * 12 + m - (fy * 12 + fm);
    case "quarter":
      return y * 4 + Math.floor((m - 1) / 3) - (fy * 4 + Math.floor((fm - 1) / 3));
    case "year":
      return y - fy;
  }
}

/** The first day of a period's i-th bucket at a grain. */
export function bucketAt(from: string, grain: Grain, i: number): string {
  if (grain === "day") return isoOf(dayOf(from) + i);
  if (grain === "week") return isoOf(monday(dayOf(from)) + 7 * i);
  const [fy, fm] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
  const months = grain === "month" ? i : grain === "quarter" ? 3 * i - ((fm - 1) % 3) : 12 * i - (fm - 1);
  const t = fy * 12 + fm - 1 + months;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}-01`;
}

/** A period's buckets at a grain, each as its first day: the axis a date runs along, none missing. */
export function bucketsOf(period: Range, grain: Grain, cap = 1_000): string[] | null {
  const last = isoOf(dayOf(period.to) - 1);
  const n = bucketIndex(last, period.from, grain) + 1;
  if (n < 1 || n > cap) return null;
  return Array.from({ length: n }, (_, i) => bucketAt(period.from, grain, i));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A bucket in words: short on an axis, whole in a tooltip or a table. */
export function dateLabel(iso: string, grain: Grain | undefined): { axis: string; full: string } {
  const y = iso.slice(0, 4);
  const m = MONTHS[Number(iso.slice(5, 7)) - 1] ?? "";
  const d = Number(iso.slice(8, 10));
  switch (grain) {
    case "year":
      return { axis: y, full: y };
    case "quarter":
      return {
        axis: `Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1} ${y}`,
        full: `Q${Math.floor((Number(iso.slice(5, 7)) - 1) / 3) + 1} ${y}`,
      };
    case "month":
      return { axis: `${m} ${y}`, full: `${m} ${y}` };
    case "week":
      return { axis: `${m} ${d}`, full: `Week of ${m} ${d}, ${y}` };
    default:
      return { axis: `${m} ${d}`, full: `${m} ${d}, ${y}` };
  }
}

// ---- groups and the axis a cartesian chart runs along ----------------------------------------------------------

/** A group's identity: its type and value, so NULL, an empty text and the text "(none)" stay three groups. */
const groupKey = (v: unknown) => (v === null || v === undefined ? "\u0000" : `${typeof v}:${String(v)}`);
/** A group's value in words. */
export const groupLabel = (v: unknown) => (v === null || v === undefined ? "(none)" : v === "" ? "(empty)" : String(v));

/** Rows by a column's value, in the order they came. */
function groupBy(rows: Record<string, unknown>[], col: string) {
  const out = new Map<string, { raw: string | number | null; label: string; rows: Record<string, unknown>[] }>();
  for (const row of rows) {
    const k = groupKey(row[col]);
    const g = out.get(k);
    if (g) g.rows.push(row);
    else out.set(k, { raw: (row[col] ?? null) as string | number | null, label: groupLabel(row[col]), rows: [row] });
  }
  return out;
}

interface Axis {
  /** Each category's label, and its key (a date's first day, a group's identity). */
  labels: { axis: string; full: string }[];
  keys: string[];
  /** A row's place on it, or -1. */
  indexOf(v: unknown): number;
  /** Laid out along the period's buckets: a bucket no row is in is still on it. */
  dense: boolean;
}

/** Dates on an axis with no period around them: the buckets from the first to the last that came back. */
const SPAN_CAP = 400;
function spanOf(rows: Record<string, unknown>[], x: string, grain: Grain): Range | undefined {
  const keys = rows
    .map((r) => r[x])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map(dateKey)
    .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k))
    .sort();
  const first = keys[0];
  const last = keys[keys.length - 1];
  return first && last ? { from: first, to: bucketAt(last, grain, 1) } : undefined;
}

/**
 * The grain of dates that came without one (an App's own SQL returning plain dates: an axis once
 * read "2026-01-01T00:00:00.000Z"): months when every one is a month's first day, else days; none when any value
 * isn't a date.
 */
function grainOfValues(rows: Record<string, unknown>[], x: string): Grain | undefined {
  const values = rows.map((r) => r[x]).filter((v) => v !== null && v !== undefined && v !== "");
  if (!values.length) return undefined;
  const days: string[] = [];
  for (const v of values) {
    const text = v instanceof Date ? v.toISOString() : typeof v === "string" ? v : "";
    if (Number.isNaN(Date.parse(text)) || !/^\d{4}-\d{2}-\d{2}/.test(text)) return undefined;
    days.push(text.slice(0, 10));
  }
  return days.every((d) => d.endsWith("-01")) ? "month" : "day";
}

function axisOf(
  rows: Record<string, unknown>[],
  x: string,
  givenGrain: Grain | undefined,
  given: Range | undefined,
): Axis {
  const grain = givenGrain ?? grainOfValues(rows, x);
  // Without a period (no filter narrows the date), the buckets between the first and the last are on the axis too:
  // an empty month is a month, never a jump from 2021 to 2024.
  const period = given ?? (grain ? spanOf(rows, x, grain) : undefined);
  if (grain && period) {
    const buckets = bucketsOf(period, grain, given ? undefined : SPAN_CAP);
    if (buckets) {
      return {
        labels: buckets.map((b) => dateLabel(b, grain)),
        keys: buckets,
        indexOf: (v) => {
          const i = bucketIndex(dateKey(v), period.from, grain);
          return i >= 0 && i < buckets.length ? i : -1;
        },
        dense: true,
      };
    }
  }
  // The values as they came (the query's order); dates oldest first.
  const keyOf = (v: unknown) => (grain ? dateKey(v) : groupKey(v));
  const seen = new Map<string, unknown>();
  for (const r of rows) if (!seen.has(keyOf(r[x]))) seen.set(keyOf(r[x]), r[x]);
  const keys = [...seen.keys()];
  if (grain) keys.sort();
  const at = new Map(keys.map((k, i) => [k, i]));
  return {
    labels: keys.map((k) =>
      grain ? dateLabel(k, grain) : { axis: groupLabel(seen.get(k)), full: groupLabel(seen.get(k)) },
    ),
    keys,
    indexOf: (v) => at.get(keyOf(v)) ?? -1,
    dense: false,
  };
}

/**
 * The values of y along an axis, each row at its place, and the value of x each place has a row for (undefined where
 * none does: a place no row is in opens nothing). A place with no row is a zero only when `zero` (the axis runs along
 * the period, the measure adds up and every row came back); otherwise it's a gap.
 */
function along(rows: Record<string, unknown>[], axis: Axis, x: string, y: string, zero: boolean) {
  const values: (number | null)[] = axis.labels.map(() => (zero ? 0 : null));
  const raws: (string | number | null | undefined)[] = axis.labels.map(() => undefined);
  for (const r of rows) {
    const i = axis.indexOf(r[x]);
    if (i < 0) continue;
    values[i] = num(r[y]);
    raws[i] = (r[x] ?? null) as string | number | null;
  }
  return { values, raws };
}

/** Whether every row of the answer came back (none past the cap or the query's limit). */
const whole = (r: Result) => r.rowCount >= r.total;

/** The days a chart's dates run along: the period's, when the period narrows the date the chart is grouped by. */
function periodFor(i: ChartInput, x: string, r: Result | undefined): Range | undefined {
  const b = i.query.by?.[groupsOf(i.query).indexOf(x)];
  return b?.includes(":") && i.periodColumn && b.split(":")[0] === i.periodColumn ? r?.period : undefined;
}

/** The same calendar day a year before (29 February the 28th's, as the server compares them). */
function yearBack(iso: string): string {
  const y = Number(iso.slice(0, 4)) - 1;
  return `${y}-${iso.slice(5, 10) === "02-29" ? "02-28" : iso.slice(5, 10)}`;
}

/** The same calendar day a year on (29 February to the 28th). */
function yearOn(iso: string): string {
  const y = Number(iso.slice(0, 4)) + 1;
  const md =
    iso.slice(5, 10) === "02-29" && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? "02-28" : iso.slice(5, 10);
  return `${y}-${md}`;
}

const cutNote = (r: Result) =>
  `Only the first ${r.rowCount.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")} rows came back.`;

// ---- the shared look --------------------------------------------------------------------------------------------

/** How wide a bar's name may be beside a horizontal bar chart, in pixels, before it's cut. */
const CATEGORY_LABEL_WIDTH = 160;
/** How wide a name under a vertical bar may be. */
const CATEGORY_LABEL_WIDTH_UNDER = 96;

function cartesianFrame(t: Theme, f: Format, horizontal: boolean, categories: string[], small = false): Option {
  const axisLabel = { color: t.muted, fontSize: small ? 10 : 11 };
  // Numbers that would touch are left out, never run together ("80100"); a long category name is cut with an
  // ellipsis at a fixed width, so it never takes the plot's room (the tooltip says it whole).
  const value = {
    type: "value",
    axisLabel: { ...axisLabel, hideOverlap: true, formatter: (v: number) => compact(v, f) },
    splitLine: { lineStyle: { color: t.rule } },
    splitNumber: small ? 3 : 5,
  };
  const category = {
    type: "category",
    data: categories,
    axisLabel: {
      ...axisLabel,
      hideOverlap: true,
      // A long name is cut with an ellipsis at a fixed width, beside a bar or under one (the tooltip says it whole).
      width: horizontal ? CATEGORY_LABEL_WIDTH : CATEGORY_LABEL_WIDTH_UNDER,
      overflow: "truncate",
      ellipsis: "…",
    },
    axisLine: { lineStyle: { color: t.rule } },
    axisTick: { show: false },
  };
  return {
    // No entry animation: a screenshot mid-animation shows half-drawn bars, and reduced-motion readers don't want it.
    animation: false,
    grid: { left: 4, right: horizontal ? 56 : 12, top: 10, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "axis",
      renderMode: "richText",
      confine: true,
      valueFormatter: (v: number) => format(v, f),
      axisPointer: { type: "line", lineStyle: { color: t.rule } },
    },
    xAxis: horizontal ? value : category,
    yAxis: horizontal ? { ...category, inverse: true } : value,
  };
}

const cell = (v: number | null, f: Format) => (v === null ? "—" : format(v, f));

// ---- line, bar, area: one or several measures, series, stacked, ranked, with the period before -----------------

function cartesian(i: ChartInput): Drawn {
  const { result: r, query: q, theme: t, format: f } = i;
  const x = i.x as string;
  const grain = grainOf(q, x);
  const rows = r.rows;
  const period = periodFor(i, x, r);
  const axis = axisOf(rows, x, grain, period);
  const notes: string[] = [];
  const horizontal = i.type === "bar" && (i.horizontal ?? i.top !== undefined);
  const categories = axis.labels.map((l) => l.axis);
  /** A zero where a place has no row: the axis runs along the period, the measure adds up, every row came back. */
  const zeroes = (y: string, of: Result = r) => axis.dense && isAdditive(q, y) && whole(of);
  type S = {
    name: string;
    data: (number | null)[];
    color: string;
    kind: "main" | "other" | "ghost";
    /** The value of x at each place this series has a row for. */
    raws?: (string | number | null | undefined)[];
    /** The series' own group value, for a split. */
    raw?: string | number | null;
  };
  let drawn: S[] = [];
  const groups = groupsOf(q);

  if (i.top !== undefined) {
    // Ranked: the largest first (an empty value last); past the top N, "Other" when it adds up and every row is here.
    const y = i.y[0] as string;
    const ranked = rows
      .map((row) => ({ label: groupLabel(row[x]), raw: (row[x] ?? null) as string | number | null, v: num(row[y]) }))
      .sort((a, b) => (a.v === null ? 1 : b.v === null ? -1 : b.v - a.v));
    const shown = ranked.slice(0, i.top);
    const rest = ranked.slice(i.top);
    const hasOther = rest.length > 0 && whole(r) && isAdditive(q, y);
    // Nothing known past the top: Other isn't a zero.
    const other = hasOther && rest.some((p) => p.v !== null) ? sum(rest.map((p) => p.v)) : null;
    if (rest.length || !whole(r)) {
      notes.push(
        hasOther
          ? `The largest ${shown.length} of ${r.total.toLocaleString("en-US")}; the rest as Other.`
          : !whole(r)
            ? `The largest ${shown.length} among the first ${r.rowCount.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")} that came back.`
            : `The largest ${shown.length} of ${r.total.toLocaleString("en-US")}; the rest left out (${human(y).toLowerCase()} doesn't add up into Other).`,
      );
    }
    const [slot] = i.colors.assign([y]);
    const color = t.series[slot ?? 0] as string;
    const labels = [...shown.map((p) => p.label), ...(hasOther ? ["Other"] : [])];
    const values = [...shown.map((p) => p.v), ...(hasOther ? [other] : [])];
    const grey = mix(t.muted, t.surface, 0.5);
    const option = cartesianFrame(t, f, horizontal, labels);
    option.tooltip = {
      ...(option.tooltip as object),
      axisPointer: { type: "shadow", z: 1, shadowStyle: { color: mix(t.rule, t.surface, 0.4) } },
    };
    option.series = [
      {
        type: "bar",
        name: human(y),
        data: values.map((v, k) => ({ value: v, itemStyle: { color: k === shown.length ? grey : color } })),
        barMaxWidth: 22,
        itemStyle: { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] },
        label: {
          show: true,
          position: horizontal ? "right" : "top",
          color: t.muted,
          fontSize: 11,
          formatter: (p: { value: number | null }) => (p.value === null ? "—" : compact(p.value, f)),
        },
      },
    ];
    return {
      panels: [{ key: "", option }],
      legend: [],
      table: {
        head: [human(x), human(y)],
        numeric: [false, true],
        rows: labels.map((l, k) => [l, cell(values[k] ?? null, f)]),
      },
      lanes: [
        {
          panel: 0,
          series: 0,
          name: human(y),
          points: labels.map((l, k) => ({ index: k, text: `${k + 1}. ${l}: ${cell(values[k] ?? null, f)}` })),
        },
      ],
      notes,
      points: values.filter((v) => v !== null).length,
      height: horizontal ? Math.max(120, 26 * labels.length + 24) : 260,
      summary: `${i.title ?? human(y)}: the largest ${shown.length} by ${human(y).toLowerCase()}, as bars.`,
      pick: (_p, _s, index) =>
        index < shown.length && groups.length === 1
          ? { group: { [x]: shown[index]?.raw ?? null }, label: `${i.title ?? human(y)}, ${shown[index]?.label}` }
          : null,
    };
  }

  if (i.series) {
    // Series: the second grouping's values, the largest six by their total; the rest "Other" when it adds up.
    const y = i.y[0] as string;
    const ranked = [...groupBy(rows, i.series).values()]
      .map((g) => ({ ...g, total: sum(g.rows.map((rr) => num(rr[y]))) }))
      .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
    const shown = ranked.slice(0, MAX_SERIES);
    const rest = ranked.slice(MAX_SERIES);
    const adds = isAdditive(q, y);
    const slots = i.colors.assign(shown.map((g) => groupKey(g.raw)));
    drawn = shown.map((g, k) => {
      const a = along(g.rows, axis, x, y, zeroes(y));
      return {
        name: g.label,
        data: a.values,
        raws: a.raws,
        color: t.series[slots[k] ?? 0] as string,
        kind: "main",
        raw: g.raw,
      };
    });
    if (rest.length) {
      if (adds && whole(r)) {
        const data = along([], axis, x, y, true).values;
        for (const g of rest) {
          along(g.rows, axis, x, y, true).values.forEach((v, k) => {
            data[k] = (data[k] ?? 0) + (v ?? 0);
          });
        }
        drawn.push({ name: "Other", data, color: mix(t.muted, t.surface, 0.5), kind: "other" });
        notes.push(
          `The ${shown.length} largest of ${ranked.length} ${human(i.series).toLowerCase()} values; the rest as Other.`,
        );
      } else {
        notes.push(
          `The ${shown.length} largest of ${ranked.length} ${human(i.series).toLowerCase()} values; the rest left out${adds && whole(r) ? "" : adds ? " (not every row came back)" : ` (${human(y).toLowerCase()} doesn't add up into Other)`}.`,
        );
      }
    }
    if (!whole(r)) notes.push(cutNote(r));
  } else {
    const slots = i.colors.assign(i.y);
    drawn = i.y.map((y, k) => {
      const a = along(rows, axis, x, y, zeroes(y));
      return { name: human(y), data: a.values, raws: a.raws, color: t.series[slots[k] ?? 0] as string, kind: "main" };
    });
    if (!whole(r)) notes.push(cutNote(r));
  }

  // The period before, bucket for bucket, behind the period's own: one measure by the date the period narrows.
  let ghost: S | null = null;
  const prev = i.previous;
  if (q.compare && prev) {
    const y = i.y[0] as string;
    const before = periodFor(i, x, prev);
    if (grain && period && before && i.y.length === 1 && drawn.length === 1) {
      const data: (number | null)[] = axis.labels.map(() => (zeroes(y, prev) ? 0 : null));
      if (q.compare === "previous_year" && grain === "day") {
        // Each day shown takes the same day a year before (29 February the 28th's): a row's NULL stays a gap.
        const then = new Map(prev.rows.map((row) => [dateKey(row[x]), num(row[y])]));
        axis.keys.forEach((day, at) => {
          const k = yearBack(day);
          if (then.has(k)) data[at] = then.get(k) ?? null;
        });
      } else {
        for (const row of prev.rows) {
          const d = dateKey(row[x]);
          // A week, month, quarter or year before lines up by the calendar; the period just before, by its place.
          const k =
            q.compare === "previous_year"
              ? bucketIndex(yearOn(d), period.from, grain)
              : bucketIndex(d, before.from, grain);
          const at = axis.indexOf(bucketAt(period.from, grain, k));
          if (at >= 0) data[at] = num(row[y]);
        }
      }
      ghost = {
        name: q.compare === "previous_year" ? "Year before" : "Period before",
        data,
        color: i.type === "bar" ? mix(t.muted, t.surface, 0.3) : t.muted,
        kind: "ghost",
      };
      if (!whole(prev))
        notes.push(`Only the first ${prev.rowCount.toLocaleString("en-US")} of the period before's rows came back.`);
    } else {
      notes.push(
        `${q.compare === "previous_year" ? "The year before" : "The period before"} isn't drawn here: it's drawn for one measure along the date its period filter narrows.`,
      );
    }
  }

  const stacked = !!i.stack && (i.type === "bar" || i.type === "area");
  const all = ghost ? [ghost, ...drawn] : drawn;
  const option = cartesianFrame(t, f, horizontal, categories);
  if (i.type === "bar") {
    option.tooltip = {
      ...(option.tooltip as object),
      axisPointer: { type: "shadow", z: 1, shadowStyle: { color: mix(t.rule, t.surface, 0.4) } },
    };
  }
  option.series = all.map((s, k) => {
    const last = k === all.length - 1;
    if (i.type === "bar") {
      return {
        type: "bar",
        name: s.name,
        data: s.data,
        barMaxWidth: 28,
        ...(stacked && s.kind !== "ghost" ? { stack: "all" } : {}),
        // The ghost behind its bar, not beside it.
        ...(ghost && last ? { barGap: "-100%" } : {}),
        itemStyle: {
          color: s.color,
          ...(stacked
            ? { borderColor: t.surface, borderWidth: 1 }
            : { borderRadius: horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0] }),
        },
        z: s.kind === "ghost" ? 1 : 2,
      };
    }
    return {
      type: "line",
      name: s.name,
      data: s.data,
      // Smooth, never past its points (smooth instead of sharp edges; monotone so a curve
      // never shows a dip or a peak the data doesn't have).
      smooth: 0.35,
      smoothMonotone: "x",
      showSymbol: false,
      symbolSize: 8,
      connectNulls: false,
      sampling: s.data.length > 400 ? "lttb" : undefined,
      lineStyle: {
        width: s.kind === "ghost" ? 1.5 : 2,
        color: s.color,
        ...(s.kind === "ghost" ? { type: "dashed" } : {}),
      },
      itemStyle: { color: s.color },
      ...(stacked && s.kind !== "ghost" ? { stack: "all" } : {}),
      ...(i.type === "area" && s.kind !== "ghost"
        ? { areaStyle: { color: s.color, opacity: stacked ? 0.85 : 0.15 } }
        : {}),
      z: s.kind === "ghost" ? 1 : 2,
    };
  });

  explain(option, i, axis, grain, horizontal, notes);
  const offset = ghost ? 1 : 0;
  const name = (s: S) => (all.length === 1 ? "" : `${s.name}: `);
  const lanes: Lane[] = drawn.map((s, k) => ({
    panel: 0,
    series: k + offset,
    name: s.name,
    points: s.data.map((v, idx) => ({
      index: idx,
      text:
        `${axis.labels[idx]?.full}, ${name(s)}${cell(v, f)}` +
        (ghost ? `; ${ghost.name.toLowerCase()}: ${cell(ghost.data[idx] ?? null, f)}` : ""),
    })),
  }));
  const points = drawn.reduce((n, s) => n + s.data.filter((v) => v !== null).length, 0);
  return {
    panels: [{ key: "", option }],
    legend:
      all.length > 1
        ? all.map((s) => ({
            name: s.name,
            color: s.color,
            mark:
              s.kind === "ghost" ? (i.type === "bar" ? "box" : "dash") : i.type === "bar" || stacked ? "box" : "line",
          }))
        : [],
    table: {
      head: [human(grain ? x.replace(/_(day|week|month|quarter|year)$/, "") : x), ...all.map((s) => s.name)],
      numeric: [false, ...all.map(() => true)],
      rows: axis.labels.map((l, idx) => [l.full, ...all.map((s) => cell(s.data[idx] ?? null, f))]),
    },
    lanes,
    notes,
    points,
    height: horizontal ? Math.max(160, 26 * categories.length * Math.max(1, all.length) + 24) : 260,
    summary: `${i.title ?? i.y.map(human).join(", ")}: ${stacked ? "stacked " : ""}${i.type === "area" ? "area" : i.type} chart${i.series ? ` by ${human(i.series).toLowerCase()}` : ""}, ${axis.labels[0]?.full ?? ""} to ${axis.labels.at(-1)?.full ?? ""}${ghost ? `, against the ${ghost.name.toLowerCase()}` : ""}.`,
    pick: (_panel, series, index) => {
      const s = all[series];
      const raw = s?.kind === "main" ? s.raws?.[index] : undefined;
      // Only a place the series has a row for opens rows: never Other, the ghost, or a zero filled in.
      if (!s || raw === undefined) return null;
      const group = { [x]: raw, ...(i.series ? { [i.series]: s.raw ?? null } : {}) };
      return { group, label: `${i.title ?? s.name}, ${axis.labels[index]?.full ?? ""}` };
    },
  };
}

// ---- small multiples: one small chart per value of the facet, on one scale ----------------------------------------

/** One small chart's own scale, from zero (or below it). */
function panelScale(series: { values: (number | null)[] }[]) {
  const all = series.flatMap((a) => a.values).filter((v): v is number => v !== null);
  const hi = Math.max(0, ...all);
  const lo = Math.min(0, ...all);
  return lo < 0
    ? { min: -nice(-lo), max: hi > 0 ? nice(hi) : 0 }
    : { min: 0, max: nice(hi) || 1, interval: (nice(hi) || 1) / 2 };
}

function multiples(i: ChartInput): Drawn {
  const { result: r, query: q, theme: t, format: f } = i;
  const x = i.x as string;
  const facet = i.facet as string;
  const grain = grainOf(q, x);
  const axis = axisOf(r.rows, x, grain, periodFor(i, x, r));
  const first = i.y[0] as string;
  const ranked = [...groupBy(r.rows, facet).values()]
    .map((g) => ({ ...g, total: sum(g.rows.map((rr) => num(rr[first]))) }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
  const shown = ranked.slice(0, MAX_PANELS);
  const notes: string[] = [];
  if (ranked.length > shown.length)
    notes.push(`The ${shown.length} largest of ${ranked.length} ${human(facet).toLowerCase()} values.`);
  if (!whole(r)) notes.push(cutNote(r));
  if (i.scale === "own") notes.push("Each on its own scale: compare their shapes, not their sizes.");
  const slots = i.colors.assign(i.y);
  const colorOf = (k: number) => t.series[slots[k] ?? 0] as string;
  const data = shown.map((p) => i.y.map((y) => along(p.rows, axis, x, y, axis.dense && isAdditive(q, y) && whole(r))));
  // One scale for every small chart: they're compared by eye. From zero, or from below it when a value is.
  const all = data.flatMap((p) => p.flatMap((a) => a.values)).filter((v): v is number => v !== null);
  const hi = Math.max(0, ...all);
  const lo = Math.min(0, ...all);
  const scale =
    lo < 0 ? { min: -nice(-lo), max: hi > 0 ? nice(hi) : 0 } : { min: 0, max: nice(hi), interval: nice(hi) / 2 };
  const panels = shown.map((p, pi) => {
    const option = cartesianFrame(
      t,
      f,
      false,
      axis.labels.map((l) => l.axis),
      true,
    );
    // Each on its own scale when asked: shapes compared, not sizes (said under them).
    const own = i.scale === "own" ? panelScale(data[pi] ?? []) : null;
    Object.assign(option.yAxis as Record<string, unknown>, own ?? scale);
    // Room on the right for the last label, centred under the last point: a small panel cuts it otherwise.
    option.grid = { left: 2, right: 22, top: 6, bottom: 2, containLabel: true };
    option.series = i.y.map((y, k) =>
      i.type === "bar"
        ? {
            type: "bar",
            name: human(y),
            data: data[pi]?.[k]?.values,
            barMaxWidth: 14,
            itemStyle: { color: colorOf(k), borderRadius: [3, 3, 0, 0] },
          }
        : {
            type: "line",
            name: human(y),
            data: data[pi]?.[k]?.values,
            smooth: 0.35,
            smoothMonotone: "x",
            showSymbol: false,
            symbolSize: 7,
            lineStyle: { width: 2, color: colorOf(k) },
            itemStyle: { color: colorOf(k) },
            ...(i.type === "area" ? { areaStyle: { color: colorOf(k), opacity: 0.15 } } : {}),
          },
    );
    return { key: groupKey(p.raw), title: p.label, option };
  });
  const lanes: Lane[] = shown.flatMap((p, pi) =>
    i.y.map((y, k) => ({
      panel: pi,
      series: k,
      name: `${p.label}${i.y.length > 1 ? `, ${human(y)}` : ""}`,
      points: (data[pi]?.[k]?.values ?? []).map((v, idx) => ({
        index: idx,
        text: `${p.label}, ${axis.labels[idx]?.full}${i.y.length > 1 ? `, ${human(y)}` : ""}: ${cell(v, f)}`,
      })),
    })),
  );
  return {
    panels,
    legend:
      i.y.length > 1
        ? i.y.map((y, k) => ({ name: human(y), color: colorOf(k), mark: i.type === "bar" ? "box" : "line" }))
        : [],
    table: {
      head: [human(facet), human(grain ? x.replace(/_(day|week|month|quarter|year)$/, "") : x), ...i.y.map(human)],
      numeric: [false, false, ...i.y.map(() => true)],
      rows: shown.flatMap((p, pi) =>
        axis.labels.map((l, idx) => [
          p.label,
          l.full,
          ...i.y.map((_, k) => cell(data[pi]?.[k]?.values[idx] ?? null, f)),
        ]),
      ),
    },
    lanes,
    notes,
    points: all.length,
    height: 150,
    summary: `${i.title ?? i.y.map(human).join(", ")}: one small chart for each of ${shown.length} ${human(facet).toLowerCase()} values, ${i.scale === "own" ? ", each on its own scale" : ", on one scale"}.`,
    pick: (panel, series, index) => {
      const p = shown[panel];
      const raw = data[panel]?.[series]?.raws[index];
      return p && raw !== undefined
        ? { group: { [x]: raw, [facet]: p.raw }, label: `${p.label}, ${axis.labels[index]?.full ?? ""}` }
        : null;
    },
  };
}

// ---- scatter: two measures of each thing -----------------------------------------------------------------------

function scatter(i: ChartInput): Drawn {
  const { result: r, theme: t, format: f } = i;
  const x = i.x as string;
  const y = i.y[0] as string;
  const label = i.label as string;
  const pts = r.rows
    .map((row) => ({
      name: groupLabel(row[label]),
      raw: row[label] as string | number | null,
      x: num(row[x]),
      y: num(row[y]),
    }))
    .filter(
      (p): p is { name: string; raw: string | number | null; x: number; y: number } => p.x !== null && p.y !== null,
    );
  const notes: string[] = [];
  if (pts.length < r.rowCount) notes.push(`${plural(r.rowCount - pts.length, "point")} without both numbers left out.`);
  if (!whole(r))
    notes.push(`The first ${r.rowCount.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")} points.`);
  const color = t.series[0] as string;
  const axisLabel = { color: t.muted, fontSize: 11 };
  const value = (name: string, fmt: Format) => ({
    type: "value",
    name,
    nameTextStyle: { color: t.muted, fontSize: 11 },
    axisLabel: { ...axisLabel, formatter: (v: number) => compact(v, fmt) },
    splitLine: { lineStyle: { color: t.rule } },
    scale: true,
  });
  const option: Option = {
    animation: false,
    grid: { left: 8, right: 24, top: 28, bottom: 28, containLabel: true },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { name: string; value: [number, number] }) =>
        `${p.name}\n${human(x)}: ${format(p.value[0], "number")}\n${human(y)}: ${format(p.value[1], f)}`,
    },
    xAxis: { ...value(human(x), "number"), nameLocation: "middle", nameGap: 24 },
    yAxis: value(human(y), f),
    series: [
      {
        type: "scatter",
        name: human(y),
        symbolSize: 9,
        large: pts.length > 2000,
        itemStyle: { color, opacity: 0.85, borderColor: t.surface, borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 2 } },
        data: pts.map((p) => ({ name: p.name, value: [p.x, p.y] })),
        // Named zones as faint washes, and lines splitting it into quadrants, said in its notes too.
        ...(i.zones?.length
          ? {
              markArea: {
                silent: true,
                data: i.zones.map((z) => [
                  {
                    name: z.label,
                    xAxis: z.x[0],
                    yAxis: z.y[0],
                    itemStyle: {
                      color:
                        (z.tone === "bad" ? t.bad : z.tone === "good" ? t.good : z.tone === "warn" ? t.warn : null) ??
                        t.muted,
                      opacity: 0.1,
                    },
                    label: { color: t.muted, fontSize: 11, position: "insideTopLeft" },
                  },
                  { xAxis: z.x[1], yAxis: z.y[1] },
                ]),
              },
            }
          : {}),
        ...(i.split && (i.split.x !== undefined || i.split.y !== undefined)
          ? {
              markLine: {
                silent: true,
                symbol: "none",
                lineStyle: { color: t.rule, type: "solid", width: 1 },
                label: { show: false },
                data: [
                  ...(i.split.x !== undefined ? [{ xAxis: i.split.x }] : []),
                  ...(i.split.y !== undefined ? [{ yAxis: i.split.y }] : []),
                ],
              },
            }
          : {}),
      },
    ],
  };
  for (const z of i.zones ?? []) {
    const inside = pts.filter((p) => p.x >= z.x[0] && p.x <= z.x[1] && p.y >= z.y[0] && p.y <= z.y[1]).length;
    notes.push(`${z.label}: ${plural(inside, "point")}.`);
  }
  const order = pts.map((p, k) => ({ ...p, k })).sort((a, b) => a.x - b.x);
  return {
    panels: [{ key: "", option }],
    legend: [],
    table: {
      head: [human(label), human(x), human(y)],
      numeric: [false, true, true],
      rows: pts.map((p) => [p.name, format(p.x, "number"), format(p.y, f)]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: order.map((p) => ({
          index: p.k,
          text: `${p.name}: ${human(x).toLowerCase()} ${format(p.x, "number")}, ${human(y).toLowerCase()} ${format(p.y, f)}`,
        })),
      },
    ],
    notes,
    points: pts.length,
    height: 300,
    summary: `${i.title ?? `${human(y)} against ${human(x).toLowerCase()}`}: ${plural(pts.length, "point")}, one for each ${human(label).toLowerCase()}.`,
    pick: (_p, _s, index) => {
      const p = pts[index];
      return p ? { group: { [label]: p.raw }, label: p.name } : null;
    },
  };
}

// ---- bullet: a value against its target ----------------------------------------------------------------------------

function bullet(i: ChartInput): Drawn {
  const { result: r, theme: t, format: f } = i;
  const y = i.y[0] as string;
  const all = r.rows.map((row) => ({
    name: i.x ? groupLabel(row[i.x]) : (i.title ?? human(y)),
    raw: i.x ? (row[i.x] as string | number | null) : null,
    v: num(row[y]),
    target: typeof i.target === "number" ? i.target : num(row[i.target as string]),
  }));
  const rows = all.slice(0, MAX_BULLETS);
  const notes: string[] = [];
  if (all.length > rows.length || !whole(r))
    notes.push(`The first ${rows.length} of ${r.total.toLocaleString("en-US")}.`);
  // From zero, or from below it when a value or a target is.
  const marks = rows.flatMap((p) => [p.v, p.target]).filter((v): v is number => v !== null);
  const hi = Math.max(0, ...marks);
  const lo = Math.min(0, ...marks);
  const top = hi > 0 ? nice(hi * 1.02) : 0;
  const bottom = lo < 0 ? -nice(-lo * 1.02) : 0;
  const pct = (p: { v: number | null; target: number | null }) =>
    p.v !== null && p.target ? format(p.v / p.target, "percent") : "—";
  const [slot] = i.colors.assign([y]);
  const color = t.series[slot ?? 0] as string;
  const option: Option = {
    animation: false,
    grid: { left: 4, right: 64, top: 6, bottom: 4, containLabel: true },
    // One line, on the bar: a bullet is short, and a shadow over its row would hide the bar it explains.
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { dataIndex: number }) => {
        const row = rows[p.dataIndex];
        return row ? `${row.name}  ${cell(row.v, f)} · ${pct(row)} of ${cell(row.target, f)}` : "";
      },
    },
    xAxis: {
      type: "value",
      min: bottom,
      max: top,
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => compact(v, f) },
      splitLine: { lineStyle: { color: t.rule } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rows.map((p) => p.name),
      axisLabel: { color: t.muted, fontSize: 11, show: !!i.x },
      axisLine: { lineStyle: { color: t.rule } },
      axisTick: { show: false },
    },
    series: [
      {
        type: "bar",
        name: human(y),
        data: rows.map((p) => p.v),
        barWidth: 12,
        itemStyle: { color, borderRadius: [0, 4, 4, 0] },
        emphasis: { disabled: true },
        label: {
          show: true,
          position: "right",
          color: t.muted,
          fontSize: 11,
          formatter: (p: { value: number }) => compact(p.value, f),
        },
        z: 2,
      },
      {
        // The target: a mark in ink across the bar, never a series colour.
        type: "scatter",
        name: "Target",
        data: rows.map((p) => p.target),
        symbol: "rect",
        symbolSize: [3, 22],
        itemStyle: { color: t.ink },
        emphasis: { disabled: true },
        z: 3,
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend: [
      { name: human(y), color, mark: "box" },
      { name: "Target", color: t.ink, mark: "tick" },
    ],
    table: {
      head: [...(i.x ? [human(i.x)] : []), human(y), "Target", "Of target"],
      numeric: [...(i.x ? [false] : []), true, true, true],
      rows: rows.map((p) => [...(i.x ? [p.name] : []), cell(p.v, f), cell(p.target, f), pct(p)]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: rows.map((p, k) => ({
          index: k,
          text: `${p.name}: ${cell(p.v, f)}, ${pct(p)} of the ${cell(p.target, f)} target`,
        })),
      },
    ],
    notes,
    points: rows.filter((p) => p.v !== null).length,
    // Room for its one-line tooltip above or below the bar.
    height: Math.max(84, 36 * rows.length + 40),
    summary: `${i.title ?? human(y)}: ${rows.length === 1 ? "a value" : `${rows.length} values`} against a target.`,
    pick: (_p, _s, index) => {
      const p = rows[index];
      return p && i.x ? { group: { [i.x]: p.raw }, label: `${i.title ?? human(y)}, ${p.name}` } : null;
    },
  };
}

// ---- calendar: a value per day, a period's days, zero told from no rows ------------------------------------------

function calendar(i: ChartInput): Drawn {
  const { result: r, theme: t, format: f } = i;
  const x = i.x as string;
  const y = i.y[0] as string;
  const notes: string[] = [];
  const values = new Map<string, number | null>();
  for (const row of r.rows) values.set(dateKey(row[x]), num(row[y]));
  const keys = [...values.keys()].sort();
  const period =
    periodFor(i, x, r) ??
    (keys.length ? { from: keys[0] as string, to: isoOf(dayOf(keys.at(-1) as string) + 1) } : null);
  if (!period) {
    return { ...nothing(i), summary: `${i.title ?? human(y)}: a calendar, with no days.` };
  }
  let from = dayOf(period.from);
  const to = dayOf(period.to);
  if (to - from > MAX_DAYS) {
    from = to - MAX_DAYS;
    notes.push(`The last ${MAX_DAYS} days of the period.`);
  }
  const days: string[] = [];
  for (let d = from; d < to; d++) days.push(isoOf(d));
  const data: [string, number][] = [];
  const at = new Map<string, number>();
  for (const day of days) {
    const v = values.get(day);
    if (v === undefined || v === null) continue;
    at.set(day, data.length);
    data.push([day, v]);
  }
  const blank = days.length - data.length;
  if (blank)
    notes.push(
      `${plural(blank, "day")} with no rows ${blank === 1 ? "is" : "are"} left blank; a zero is the lightest shade.`,
    );
  if (!whole(r))
    notes.push(
      `Only the first ${r.rowCount.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")} days came back.`,
    );
  const weeks = Math.ceil((days.length + ((new Date(from * 86_400_000).getUTCDay() + 6) % 7)) / 7) + 1;
  const width = i.width ?? 640;
  const size = Math.max(8, Math.min(18, Math.floor((width - 48) / weeks)));
  const minWidth = size === 8 ? weeks * 8 + 48 : undefined;
  const max = Math.max(0, ...data.map(([, v]) => v));
  const min = Math.min(0, ...data.map(([, v]) => v));
  const hue = t.series[0] as string;
  const option: Option = {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { value: [string, number] }) => `${dateLabel(p.value[0], "day").full}: ${format(p.value[1], f)}`,
    },
    visualMap: {
      type: "continuous",
      min,
      max: max > min ? max : min + 1,
      calculable: false,
      orient: "horizontal",
      left: 36,
      bottom: 0,
      itemWidth: 10,
      itemHeight: 120,
      text: [compact(max, f), compact(min, f)],
      textStyle: { color: t.muted, fontSize: 10 },
      // One hue, light to dark; the lightest is still a shade, so a zero is told from a blank day.
      inRange: { color: [mix(hue, t.surface, 0.2), hue] },
    },
    calendar: {
      top: 22,
      left: 36,
      right: 8,
      cellSize: [size, size],
      range: [isoOf(from), isoOf(to - 1)],
      orient: "horizontal",
      splitLine: { show: false },
      itemStyle: { color: t.surface, borderColor: t.rule, borderWidth: 1 },
      dayLabel: { firstDay: 1, nameMap: ["", "Mon", "", "Wed", "", "Fri", ""], color: t.muted, fontSize: 10 },
      monthLabel: { color: t.muted, fontSize: 10 },
      yearLabel: { show: false },
    },
    series: [
      {
        type: "heatmap",
        coordinateSystem: "calendar",
        name: human(y),
        data,
        itemStyle: { borderColor: t.surface, borderWidth: 1 },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1.5 } },
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend: [],
    table: {
      head: ["Day", human(y)],
      numeric: [false, true],
      rows: days.map((day) => [
        dateLabel(day, "day").full,
        at.has(day) ? format(data[at.get(day) as number]?.[1], f) : "No rows",
      ]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: days.map((day) => ({
          index: at.get(day) ?? -1,
          text: `${dateLabel(day, "day").full}: ${at.has(day) ? format(data[at.get(day) as number]?.[1], f) : "no rows"}`,
        })),
      },
    ],
    notes,
    points: data.length,
    height: size * 7 + 64,
    ...(minWidth ? { minWidth } : {}),
    summary: `${i.title ?? human(y)}: a calendar of ${plural(days.length, "day")}, ${dateLabel(isoOf(from), "day").full} to ${dateLabel(isoOf(to - 1), "day").full}.`,
    pick: (_p, _s, index) => {
      const d = data[index];
      const raw = d ? r.rows.find((row) => dateKey(row[x]) === d[0])?.[x] : undefined;
      return d && raw !== undefined
        ? { group: { [x]: raw as string }, label: `${i.title ?? human(y)}, ${dateLabel(d[0], "day").full}` }
        : null;
    },
  };
}

// ---- funnel: stages in order, each one's share of the first -------------------------------------------------------

function funnel(i: ChartInput): Drawn {
  const { result: r, query: q, theme: t, format: f } = i;
  const x = i.x as string;
  const y = i.y[0] as string;
  const stages = i.stages ?? [];
  const at = new Map<string, { v: number | null; raw: string | number | null }>();
  let outside = 0;
  for (const row of r.rows) {
    // A stage is matched by its text: a stage column of numbers matches "1", "2".
    const k = row[x] === null || row[x] === undefined ? null : String(row[x]);
    if (k !== null && stages.includes(k)) at.set(k, { v: num(row[y]), raw: row[x] as string | number });
    else outside += 1;
  }
  const complete = whole(r);
  // A stage with no row is a zero only for a count or sum with every row here; otherwise it isn't known.
  let values: (number | null)[] = stages.map((s) =>
    at.has(s) ? (at.get(s)?.v ?? null) : complete && isAdditive(q, y) ? 0 : null,
  );
  const cumulative = !!i.cumulative && complete;
  // Counting the later stages in; a run of stages none of which is known isn't a zero.
  if (cumulative)
    values = values.map((_, k) => (values.slice(k).some((v) => v !== null) ? sum(values.slice(k)) : null));
  const first = values[0] ?? null;
  const notes: string[] = [];
  if (cumulative) notes.push("Each stage counts those at it or a later one.");
  else if (i.cumulative) notes.push("Not every row came back, so each stage is counted on its own.");
  if (outside) notes.push(`${plural(outside, `${human(x).toLowerCase()} value`)} outside the stages left out.`);
  if (!complete) notes.push(cutNote(r));
  const ratio = (a: number | null | undefined, b: number | null | undefined) =>
    a === null || a === undefined || !b ? "—" : format(a / b, "percent");
  const share = (k: number) => ratio(values[k], first);
  const step = (k: number) => (k ? ratio(values[k], values[k - 1]) : "—");
  const hue = t.series[0] as string;
  const option: Option = {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { name: string; value: number; dataIndex: number }) =>
        `${p.name}: ${cell(values[p.dataIndex] ?? null, f)}\n${share(p.dataIndex)} of ${stages[0]}`,
    },
    series: [
      {
        type: "funnel",
        name: human(y),
        sort: "none",
        left: 8,
        width: "56%",
        top: 8,
        bottom: 8,
        min: 0,
        max: first || 1,
        minSize: "6%",
        gap: 2,
        label: {
          position: "right",
          color: t.ink,
          fontSize: 11,
          formatter: (p: { name: string; dataIndex: number }) => {
            const v = values[p.dataIndex] ?? null;
            return `${p.name} · ${v === null ? "—" : compact(v, f)} · ${share(p.dataIndex)}`;
          },
        },
        labelLine: { lineStyle: { color: t.rule } },
        itemStyle: { borderWidth: 0 },
        // One hue, deepest first: a funnel is one series, its stages told apart by place and name.
        data: stages.map((s, k) => ({
          name: s,
          value: values[k] ?? 0,
          itemStyle: { color: mix(hue, t.surface, 1 - (0.55 * k) / Math.max(1, stages.length - 1)) },
        })),
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend: [],
    table: {
      head: [human(x), human(y), `Share of ${stages[0] ?? "the first"}`, "From the stage before"],
      numeric: [false, true, true, true],
      rows: stages.map((s, k) => [s, cell(values[k] ?? null, f), share(k), step(k)]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: stages.map((s, k) => ({
          index: k,
          text: `${s}: ${cell(values[k] ?? null, f)}, ${share(k)} of ${stages[0]}`,
        })),
      },
    ],
    notes,
    points: values.filter((v) => v !== null && v > 0).length,
    height: Math.max(200, 40 * stages.length + 24),
    summary: `${i.title ?? human(y)}: a funnel of ${stages.length} stages, ${stages[0]} to ${stages.at(-1)}.`,
    pick: (_p, _s, index) => {
      const s = stages[index];
      const hit = s ? at.get(s) : undefined;
      // A stage counting the later ones in opens more than its own rows: only a stage's own opens.
      return hit && !i.cumulative ? { group: { [x]: hit.raw }, label: `${i.title ?? human(y)}, ${s}` } : null;
    },
  };
}

// ---- treemap: parts of a whole, one or two groupings deep ---------------------------------------------------------

function treemap(i: ChartInput): Drawn {
  const { result: r, query: q, theme: t, format: f } = i;
  const [outerCol, innerCol] = groupsOf(q) as [string, string | undefined];
  const y = i.y[0] as string;
  const outer = new Map<
    string,
    {
      raw: string | number | null;
      label: string;
      total: number;
      children: { label: string; raw: string | number | null; v: number }[];
    }
  >();
  let dropped = 0;
  for (const row of r.rows) {
    const v = num(row[y]);
    if (v === null || v <= 0) {
      dropped += 1;
      continue;
    }
    const k = groupKey(row[outerCol]);
    const o = outer.get(k) ?? {
      raw: (row[outerCol] ?? null) as string | number | null,
      label: groupLabel(row[outerCol]),
      total: 0,
      children: [],
    };
    o.total += v;
    if (innerCol)
      o.children.push({ label: groupLabel(row[innerCol]), raw: (row[innerCol] ?? null) as string | number | null, v });
    outer.set(k, o);
  }
  const ranked = [...outer.entries()].sort((a, b) => b[1].total - a[1].total);
  const coloured = ranked.slice(0, MAX_SERIES);
  const slots = i.colors.assign(coloured.map(([k]) => k));
  const grey = mix(t.muted, t.surface, 0.5);
  const colorOf = (k: number) => (k < coloured.length ? (t.series[slots[k] ?? 0] as string) : grey);
  const total = sum(ranked.map(([, o]) => o.total));
  const notes: string[] = [];
  if (dropped)
    notes.push(`${plural(dropped, "group")} of zero or less left out: a treemap's areas are parts of a whole.`);
  if (!whole(r))
    notes.push(
      `Only the first ${r.rowCount.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")} groups came back.`,
    );
  if (ranked.length > MAX_SERIES) notes.push(`The ${MAX_SERIES} largest coloured; the rest in grey.`);
  // A share of everything only when everything came back; otherwise of what's shown, and said so.
  const of = whole(r) ? "of all" : "of those shown";
  const share = (v: number) => (total ? format(v / total, "percent") : "—");
  const data = ranked.map(([, o], k) => {
    const color = colorOf(k);
    const label = { color: inkOn(color) };
    return {
      name: o.label,
      value: o.total,
      // Its border is its own colour: the strip naming it along its top reads as part of it.
      itemStyle: { color, borderColor: color },
      label,
      upperLabel: { color: inkOn(color) },
      ...(innerCol
        ? {
            children: o.children
              .sort((a, b) => b.v - a.v)
              .map((c) => ({ name: c.label, value: c.v, itemStyle: { color }, label })),
          }
        : {}),
    };
  });
  const option: Option = {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { name: string; value: number; treePathInfo?: { name: string }[] }) => {
        const path =
          (p.treePathInfo ?? [])
            .slice(1)
            .map((n) => n.name)
            .join(" › ") || p.name;
        return `${path}: ${format(p.value, f)} (${share(p.value)} ${of})`;
      },
    },
    series: [
      {
        type: "treemap",
        name: human(y),
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        label: {
          show: true,
          fontSize: 11,
          formatter: (p: { name: string; value: number }) => `${p.name}\n${compact(p.value, f)}`,
        },
        // The first level is the whole; then the outer groups (named in a strip along their top when they nest), then
        // the inner ones, each a surface gap apart.
        levels: [
          { itemStyle: { borderWidth: 0, gapWidth: 2 } },
          {
            itemStyle: { borderWidth: innerCol ? 1 : 0, gapWidth: innerCol ? 1 : 2 },
            ...(innerCol ? { upperLabel: { show: true, height: 20, fontSize: 11, fontWeight: 500 } } : {}),
          },
          { itemStyle: { borderColor: t.surface, borderWidth: 1, gapWidth: 0 } },
        ],
        data,
      },
    ],
  };
  const leaves = ranked
    .flatMap(([, o]) =>
      innerCol ? o.children.map((c) => ({ names: [o.label, c.label], v: c.v })) : [{ names: [o.label], v: o.total }],
    )
    .sort((a, b) => b.v - a.v);
  return {
    panels: [{ key: "", option }],
    legend:
      ranked.length > 1
        ? [
            ...coloured.map(([, o], k) => ({ name: o.label, color: colorOf(k), mark: "box" as const })),
            ...(ranked.length > MAX_SERIES ? [{ name: "The rest", color: grey, mark: "box" as const }] : []),
          ]
        : [],
    table: {
      head: [
        human(outerCol),
        ...(innerCol ? [human(innerCol)] : []),
        human(y),
        whole(r) ? "Share" : "Share of those shown",
      ],
      numeric: [false, ...(innerCol ? [false] : []), true, true],
      rows: leaves.map((l) => [...l.names, format(l.v, f), share(l.v)]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: leaves.map((l) => ({
          index: -1,
          text: `${l.names.join(" › ")}: ${format(l.v, f)}, ${share(l.v)} ${of}`,
        })),
      },
    ],
    notes,
    points: leaves.length,
    height: 300,
    summary: `${i.title ?? human(y)}: a treemap of ${plural(ranked.length, human(outerCol).toLowerCase())}${innerCol ? ` by ${human(innerCol).toLowerCase()}` : ""}, each area its share.`,
    pick: () => null,
  };
}

// ---- waterfall: a level from period to period, each step's change -----------------------------------------------

function waterfall(i: ChartInput): Drawn {
  const { result: r, query: q, theme: t, format: f } = i;
  const x = i.x as string;
  const y = i.y[0] as string;
  const grain = grainOf(q, x);
  const rows = r.rows
    .map((row) => ({ key: dateKey(row[x]), raw: row[x] as string, v: num(row[y]) }))
    .filter((p): p is { key: string; raw: string; v: number } => p.v !== null)
    .sort((a, b) => a.key.localeCompare(b.key));
  const notes: string[] = [];
  if (!whole(r))
    notes.push(
      `Only the first ${r.rowCount.toLocaleString("en-US")} of ${r.total.toLocaleString("en-US")} periods came back.`,
    );
  const labels = rows.map((p) => dateLabel(p.key, grain));
  const up = t.series[1] as string;
  const down = t.series[3] as string;
  const level = mix(t.muted, t.surface, 0.55);
  const n = rows.length;
  const values = rows.map((p) => p.v);
  const negative = values.some((v) => v < 0);
  // Start, each change, end: the start and end are levels from zero; a change floats from the level before.
  const cats = n ? [labels[0]?.axis ?? "", ...labels.slice(1).map((l) => l.axis), "End"] : [];
  const fulls = n
    ? [labels[0]?.full ?? "", ...labels.slice(1).map((l) => l.full), `End, ${labels.at(-1)?.full ?? ""}`]
    : [];
  const base: (number | null)[] = [];
  const ups: (number | null)[] = [];
  const downs: (number | null)[] = [];
  const levels: (number | null)[] = [];
  const texts: string[] = [];
  const changes: (number | null)[] = [];
  for (let k = 0; k < n + (n ? 1 : 0); k++) {
    const isLevel = k === 0 || k === n;
    const v = values[Math.min(k, n - 1)] as number;
    if (isLevel) {
      base.push(negative ? null : 0);
      levels.push(v);
      ups.push(null);
      downs.push(null);
      changes.push(null);
      texts.push(`${fulls[k]}: ${format(v, f)}`);
      continue;
    }
    const before = values[k - 1] as number;
    const d = v - before;
    changes.push(d);
    levels.push(null);
    if (negative) {
      base.push(null);
      ups.push(d >= 0 ? d : null);
      downs.push(d < 0 ? d : null);
    } else {
      base.push(Math.min(before, v));
      ups.push(d >= 0 ? d : null);
      downs.push(d < 0 ? -d : null);
    }
    texts.push(`${fulls[k]}: ${d >= 0 ? "up" : "down"} ${format(Math.abs(d), f)}, to ${format(v, f)}`);
  }
  if (negative && n) notes.push("Below zero, the changes are drawn from zero.");
  const option = cartesianFrame(t, f, false, cats);
  option.tooltip = {
    trigger: "axis",
    renderMode: "richText",
    confine: true,
    axisPointer: { type: "shadow", z: 1, shadowStyle: { color: mix(t.rule, t.surface, 0.4) } },
    formatter: (ps: { dataIndex: number }[]) => texts[ps[0]?.dataIndex ?? -1] ?? "",
  };
  option.series = [
    // An invisible base the change stands on.
    {
      type: "bar",
      name: "base",
      stack: "w",
      data: base,
      itemStyle: { color: "transparent" },
      emphasis: { disabled: true },
      silent: true,
      barMaxWidth: 32,
    },
    { type: "bar", name: "Level", stack: "w", data: levels, itemStyle: { color: level, borderRadius: [4, 4, 0, 0] } },
    {
      type: "bar",
      name: "Increase",
      stack: negative ? "up" : "w",
      data: ups,
      itemStyle: { color: up, borderRadius: [4, 4, 0, 0] },
    },
    {
      type: "bar",
      name: "Decrease",
      stack: negative ? "down" : "w",
      data: downs,
      itemStyle: { color: down, borderRadius: negative ? [0, 0, 4, 4] : [4, 4, 0, 0] },
    },
  ];
  return {
    panels: [{ key: "", option }],
    legend: [
      { name: "Level", color: level, mark: "box" },
      { name: "Increase", color: up, mark: "box" },
      { name: "Decrease", color: down, mark: "box" },
    ],
    table: {
      head: [human(x.replace(/_(day|week|month|quarter|year)$/, "")), human(y), "Change"],
      numeric: [false, true, true],
      rows: rows.map((p, k) => [
        labels[k]?.full ?? "",
        format(p.v, f),
        k ? format(p.v - (values[k - 1] as number), f, true) : "—",
      ]),
    },
    lanes: [{ panel: 0, series: 0, name: human(y), points: texts.map((text, k) => ({ index: k, text })) }],
    notes,
    points: n,
    height: 260,
    summary: `${i.title ?? human(y)}: a waterfall from ${labels[0]?.full ?? ""} to ${labels.at(-1)?.full ?? ""}, each period's change.`,
    pick: (_p, _s, index) => {
      const p = rows[index];
      return p && index < n
        ? { group: { [x]: p.raw }, label: `${i.title ?? human(y)}, ${labels[index]?.full ?? ""}` }
        : null;
    },
  };
}

// ---- heatmap: a measure across two groupings (a cohort's months, weekday by hour, plan by country) ---------------

/** A group's values in their order: dates oldest first; values by their total, largest first. */
function ordered(
  rows: Record<string, unknown>[],
  col: string,
  y: string,
  grain: Grain | undefined,
  cap: number,
): { keys: string[]; label: Map<string, string>; raw: Map<string, string | number | null>; cut: number } {
  const totals = new Map<string, number>();
  const label = new Map<string, string>();
  const raw = new Map<string, string | number | null>();
  for (const row of rows) {
    const k = grain ? dateKey(row[col]) : groupKey(row[col]);
    totals.set(k, (totals.get(k) ?? 0) + Math.abs(num(row[y]) ?? 0));
    if (!label.has(k)) {
      label.set(k, grain ? dateLabel(dateKey(row[col]), grain).axis : groupLabel(row[col]));
      raw.set(k, (row[col] ?? null) as string | number | null);
    }
  }
  const all = grain ? [...totals.keys()].sort() : [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  // Dates keep their latest; values their largest.
  const keys = grain ? all.slice(-cap) : all.slice(0, cap);
  return { keys, label, raw, cut: all.length - keys.length };
}

function heatmap(i: ChartInput): Drawn {
  const { result: r, query: q, theme: t, format: f } = i;
  const x = i.x as string;
  const down = i.series as string;
  const y = i.y[0] as string;
  const across = ordered(r.rows, x, y, grainOf(q, x), MAX_HEAT_COLUMNS);
  const rowsOf = ordered(r.rows, down, y, grainOf(q, down), MAX_HEAT_ROWS);
  const xi = new Map(across.keys.map((k, n) => [k, n]));
  const yi = new Map(rowsOf.keys.map((k, n) => [k, n]));
  const xKey = (v: unknown) => (grainOf(q, x) ? dateKey(v) : groupKey(v));
  const yKey = (v: unknown) => (grainOf(q, down) ? dateKey(v) : groupKey(v));
  const data: [number, number, number][] = [];
  for (const row of r.rows) {
    const a = xi.get(xKey(row[x]));
    const b = yi.get(yKey(row[down]));
    const v = num(row[y]);
    if (a === undefined || b === undefined || v === null) continue;
    data.push([a, b, v]);
  }
  const notes: string[] = [];
  if (across.cut) notes.push(`${plural(across.cut, "column")} past the ${across.keys.length} shown left out.`);
  if (rowsOf.cut) notes.push(`${plural(rowsOf.cut, "row")} past the ${rowsOf.keys.length} shown left out.`);
  if (!whole(r)) notes.push(cutNote(r));
  const values = data.map(([, , v]) => v);
  const max = Math.max(0, ...values);
  const min = Math.min(0, ...values);
  const hue = t.series[0] as string;
  const cells = across.keys.length * rowsOf.keys.length;
  const option: Option = {
    animation: false,
    grid: { left: 4, right: 8, top: 8, bottom: 34, containLabel: true },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { value: [number, number, number] }) =>
        `${rowsOf.label.get(rowsOf.keys[p.value[1]] ?? "") ?? ""} · ${across.label.get(across.keys[p.value[0]] ?? "") ?? ""}: ${format(p.value[2], f)}`,
    },
    xAxis: {
      type: "category",
      data: across.keys.map((k) => across.label.get(k) ?? ""),
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
      axisLine: { lineStyle: { color: t.rule } },
      axisTick: { show: false },
      splitArea: { show: false },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: rowsOf.keys.map((k) => rowsOf.label.get(k) ?? ""),
      axisLabel: { color: t.muted, fontSize: 11 },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    visualMap: {
      type: "continuous",
      min,
      max: max > min ? max : min + 1,
      calculable: false,
      orient: "horizontal",
      left: "center",
      bottom: 0,
      itemWidth: 10,
      itemHeight: 120,
      text: [compact(max, f), compact(min, f)],
      textStyle: { color: t.muted, fontSize: 10 },
      // One hue, light to dark: the lightest is still a shade, so a zero is told from a missing cell.
      inRange: { color: [mix(hue, t.surface, 0.15), hue] },
    },
    series: [
      {
        type: "heatmap",
        name: human(y),
        data,
        // Values in the cells while they're few enough to read.
        label: {
          show: cells <= 80,
          fontSize: 10,
          formatter: (p: { value: [number, number, number] }) => compact(p.value[2], f),
        },
        itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        emphasis: { itemStyle: { borderColor: t.ink, borderWidth: 1.5 } },
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend: [],
    table: {
      head: [human(down), human(x), human(y)],
      numeric: [false, false, true],
      rows: data.map(([a, b, v]) => [
        rowsOf.label.get(rowsOf.keys[b] ?? "") ?? "",
        across.label.get(across.keys[a] ?? "") ?? "",
        format(v, f),
      ]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: data.map(([a, b, v], index) => ({
          index,
          text: `${rowsOf.label.get(rowsOf.keys[b] ?? "") ?? ""}, ${across.label.get(across.keys[a] ?? "") ?? ""}: ${format(v, f)}`,
        })),
      },
    ],
    notes,
    points: data.length,
    height: Math.max(180, rowsOf.keys.length * 26 + 70),
    summary: `${i.title ?? human(y)}: ${human(y)} by ${human(x)} and ${human(down)}, darker for more.`,
    pick: (_p, _s, index) => {
      const d = data[index];
      if (!d) return null;
      return {
        group: {
          [x]: across.raw.get(across.keys[d[0]] ?? "") ?? null,
          [down]: rowsOf.raw.get(rowsOf.keys[d[1]] ?? "") ?? null,
        },
        label: `${i.title ?? human(y)}, ${rowsOf.label.get(rowsOf.keys[d[1]] ?? "") ?? ""} · ${across.label.get(across.keys[d[0]] ?? "") ?? ""}`,
      };
    },
  };
}

// ---- sankey: an amount flowing from one value to another (plan moves, channel to outcome) -----------------------

function sankey(i: ChartInput): Drawn {
  const { result: r, theme: t, format: f } = i;
  const from = i.x as string;
  const to = i.series as string;
  const y = i.y[0] as string;
  const all = r.rows
    .map((row) => ({
      a: groupLabel(row[from]),
      b: groupLabel(row[to]),
      rawA: (row[from] ?? null) as string | number | null,
      rawB: (row[to] ?? null) as string | number | null,
      v: num(row[y]) ?? 0,
    }))
    .filter((l) => l.v > 0)
    .sort((m, n) => n.v - m.v);
  const links = all.slice(0, MAX_FLOWS);
  const notes: string[] = [];
  if (all.length > links.length)
    notes.push(`The ${links.length} largest flows of ${all.length.toLocaleString("en-US")}.`);
  const dropped = r.rows.length - all.length;
  if (dropped) notes.push(`${plural(dropped, "flow")} of zero or less left out.`);
  if (!whole(r)) notes.push(cutNote(r));
  // The same value on both sides is two nodes (a plan kept is a flow from it to itself): the end side is marked.
  const END = "​";
  const starts = [...new Set(links.map((l) => l.a))];
  const ends = [...new Set(links.map((l) => l.b))];
  const slots = i.colors.assign(starts.slice(0, MAX_SERIES));
  const grey = mix(t.muted, t.surface, 0.5);
  const colorOf = (name: string) => {
    const k = starts.indexOf(name);
    return k >= 0 && k < MAX_SERIES ? (t.series[slots[k] ?? 0] as string) : grey;
  };
  const option: Option = {
    animation: false,
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: {
        dataType: string;
        data: { source?: string; target?: string; value?: number };
        name: string;
        value: number;
      }) =>
        p.dataType === "edge"
          ? `${(p.data.source ?? "").replaceAll(END, "")} → ${(p.data.target ?? "").replaceAll(END, "")}: ${format(p.data.value ?? 0, f)}`
          : `${p.name.replaceAll(END, "")}: ${format(p.value, f)}`,
    },
    series: [
      {
        type: "sankey",
        name: human(y),
        left: 4,
        right: 120,
        top: 8,
        bottom: 8,
        nodeGap: 10,
        nodeWidth: 10,
        draggable: false,
        emphasis: { focus: "adjacency" },
        data: [
          ...starts.map((name) => ({ name, itemStyle: { color: colorOf(name), borderWidth: 0 } })),
          ...ends.map((name) => ({ name: `${name}${END}`, itemStyle: { color: grey, borderWidth: 0 } })),
        ],
        links: links.map((l) => ({ source: l.a, target: `${l.b}${END}`, value: l.v })),
        lineStyle: { color: "source", opacity: 0.32, curveness: 0.5 },
        label: {
          color: t.ink,
          fontSize: 11,
          formatter: (p: { name: string }) => p.name.replaceAll(END, ""),
        },
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend: [],
    table: {
      head: [human(from), human(to), human(y)],
      numeric: [false, false, true],
      rows: links.map((l) => [l.a, l.b, format(l.v, f)]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: links.map((l) => ({ index: -1, text: `${l.a} to ${l.b}: ${format(l.v, f)}` })),
      },
    ],
    notes,
    points: links.length,
    height: Math.max(220, Math.max(starts.length, ends.length) * 30 + 40),
    summary: `${i.title ?? human(y)}: ${human(y)} flowing from ${human(from)} to ${human(to)}, wider for more.`,
    pick: () => null,
  };
}

// ---- timeline: each row a bar from its start to its end (projects, renewals, incidents) --------------------------

function timeline(i: ChartInput): Drawn {
  const { result: r, theme: t } = i;
  const x = i.x as string;
  const [startCol, endCol] = i.y as [string, string];
  const now = Date.now();
  const all = r.rows
    .map((row) => {
      const start = Date.parse(String(row[startCol] ?? ""));
      const endRaw = row[endCol];
      const end = endRaw === null || endRaw === undefined || endRaw === "" ? null : Date.parse(String(endRaw));
      return {
        label: groupLabel(row[x]),
        raw: (row[x] ?? null) as string | number | null,
        group: i.series ? groupLabel(row[i.series]) : null,
        start,
        end: end !== null && Number.isFinite(end) ? end : null,
      };
    })
    .filter((s) => Number.isFinite(s.start))
    .sort((a, b) => a.start - b.start);
  const spans = all.slice(0, MAX_SPANS);
  const notes: string[] = [];
  if (all.length > spans.length) notes.push(`The ${spans.length} earliest of ${all.length.toLocaleString("en-US")}.`);
  const skipped = r.rows.length - all.length;
  if (skipped) notes.push(`${plural(skipped, "row")} with no start left out.`);
  const open = spans.filter((s) => s.end === null).length;
  if (open)
    notes.push(`${plural(open, "bar")} with no end yet ${open === 1 ? "runs" : "run"} to today, drawn lighter.`);
  if (!whole(r)) notes.push(cutNote(r));
  const groups = [...new Set(spans.map((s) => s.group ?? ""))];
  const slots = i.colors.assign(groups.slice(0, MAX_SERIES));
  const colorOf = (g: string | null) => {
    const k = groups.indexOf(g ?? "");
    return k >= 0 && k < MAX_SERIES ? (t.series[slots[k] ?? 0] as string) : mix(t.muted, t.surface, 0.4);
  };
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const words = (ms: number) => dateLabel(day(ms), "day").full;
  const data = spans.map((s, k) => ({
    value: [k, s.start, s.end ?? Math.max(now, s.start)],
    itemStyle: { color: colorOf(s.group), opacity: s.end === null ? 0.45 : 1 },
  }));
  const option: Option = {
    animation: false,
    grid: { left: 4, right: 16, top: 8, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { dataIndex: number }) => {
        const s = spans[p.dataIndex];
        return s ? `${s.label}: ${words(s.start)} to ${s.end === null ? "now" : words(s.end)}` : "";
      },
    },
    xAxis: {
      type: "time",
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
      axisLine: { lineStyle: { color: t.rule } },
      splitLine: { lineStyle: { color: t.rule } },
    },
    yAxis: {
      type: "category",
      inverse: true,
      data: spans.map((s) => s.label),
      axisLabel: { color: t.muted, fontSize: 11, width: 140, overflow: "truncate" },
      axisLine: { show: false },
      axisTick: { show: false },
    },
    series: [
      {
        type: "custom",
        name: human(x),
        encode: { x: [1, 2], y: 0 },
        data,
        renderItem: (
          _params: unknown,
          api: {
            value: (n: number) => number;
            coord: (v: [number, number]) => [number, number];
            size: (v: [number, number]) => [number, number];
            style: () => Record<string, unknown>;
          },
        ) => {
          const lane = api.value(0);
          const a = api.coord([api.value(1), lane]);
          const b = api.coord([api.value(2), lane]);
          const h = Math.min(14, api.size([0, 1])[1] * 0.6);
          return {
            type: "rect",
            shape: { x: a[0], y: a[1] - h / 2, width: Math.max(3, b[0] - a[0]), height: h, r: 3 },
            style: api.style(),
          };
        },
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend:
      i.series && groups.length > 1
        ? groups.slice(0, MAX_SERIES).map((g) => ({ name: g, color: colorOf(g), mark: "box" as const }))
        : [],
    table: {
      head: [human(x), human(startCol), human(endCol), ...(i.series ? [human(i.series)] : [])],
      numeric: [false, false, false, ...(i.series ? [false] : [])],
      rows: spans.map((s) => [
        s.label,
        words(s.start),
        s.end === null ? "Not yet" : words(s.end),
        ...(i.series ? [s.group ?? ""] : []),
      ]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(x),
        points: spans.map((s, index) => ({
          index,
          text: `${s.label}: ${words(s.start)} to ${s.end === null ? "now" : words(s.end)}`,
        })),
      },
    ],
    notes,
    points: spans.length,
    height: Math.max(160, spans.length * 26 + 40),
    summary: `${i.title ?? human(x)}: each ${human(x)} from its ${human(startCol)} to its ${human(endCol)}.`,
    pick: (_p, _s, index) => {
      const s = spans[index];
      return s ? { group: { [x]: s.raw }, label: `${i.title ?? human(x)}, ${s.label}` } : null;
    },
  };
}

// ---- box plot: a number's spread in each group, from its rows (deal sizes by plan, response times by team) -----------

/** The value at a fraction of a sorted list, between its neighbours. */
function quantile(sorted: number[], p: number): number {
  const at = (sorted.length - 1) * p;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (at - lo);
}

function boxplot(i: ChartInput): Drawn {
  const { result: r, theme: t, format: f } = i;
  const x = i.x as string;
  const y = i.y[0] as string;
  const groups = new Map<string, { label: string; raw: string | number | null; values: number[] }>();
  let missing = 0;
  for (const row of r.rows) {
    const v = num(row[y]);
    if (v === null) {
      missing += 1;
      continue;
    }
    const k = groupKey(row[x]);
    const g = groups.get(k) ?? {
      label: groupLabel(row[x]),
      raw: (row[x] ?? null) as string | number | null,
      values: [],
    };
    g.values.push(v);
    groups.set(k, g);
  }
  const all = [...groups.values()].sort((a, b) => b.values.length - a.values.length);
  const shown = all.slice(0, MAX_BOXES);
  const boxes = shown.map((g) => {
    const v = [...g.values].sort((a, b) => a - b);
    const q1 = quantile(v, 0.25);
    const median = quantile(v, 0.5);
    const q3 = quantile(v, 0.75);
    const reach = 1.5 * (q3 - q1);
    const inside = v.filter((n) => n >= q1 - reach && n <= q3 + reach);
    const low = inside[0] ?? q1;
    const high = inside.at(-1) ?? q3;
    return { ...g, n: v.length, low, q1, median, q3, high, outliers: v.filter((n) => n < low || n > high) };
  });
  const notes: string[] = [];
  if (all.length > shown.length) notes.push(`The ${shown.length} groups with the most rows of ${all.length}.`);
  if (missing) notes.push(`${plural(missing, "row")} with no ${human(y)} left out.`);
  // Worked out from the rows that came back: a cut answer's spread is of those rows only.
  if (!whole(r)) notes.push(`${cutNote(r)} The spread is of those rows.`);
  notes.push(
    "Each box is the middle half of its values, its line the median; whiskers reach 1.5 times the box, dots are past them.",
  );
  const color = t.series[0] as string;
  const option: Option = {
    animation: false,
    grid: { left: 4, right: 12, top: 10, bottom: 4, containLabel: true },
    tooltip: {
      trigger: "item",
      renderMode: "richText",
      confine: true,
      formatter: (p: { seriesType: string; dataIndex: number; value: number[] }) => {
        const b = boxes[p.seriesType === "boxplot" ? p.dataIndex : (p.value[0] as number)];
        if (!b) return "";
        return p.seriesType === "boxplot"
          ? `${b.label} (${b.n.toLocaleString("en-US")}): median ${format(b.median, f)}, middle half ${format(b.q1, f)} to ${format(b.q3, f)}`
          : `${b.label}: ${format(p.value[1] as number, f)}, outside the usual`;
      },
    },
    xAxis: {
      type: "category",
      data: boxes.map((b) => b.label),
      axisLabel: { color: t.muted, fontSize: 11, hideOverlap: true },
      axisLine: { lineStyle: { color: t.rule } },
      axisTick: { show: false },
    },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { color: t.muted, fontSize: 11, formatter: (v: number) => compact(v, f) },
      splitLine: { lineStyle: { color: t.rule } },
    },
    series: [
      {
        type: "boxplot",
        name: human(y),
        data: boxes.map((b) => [b.low, b.q1, b.median, b.q3, b.high]),
        boxWidth: [8, 28],
        itemStyle: { color: mix(color, t.surface, 0.22), borderColor: color, borderWidth: 1.5 },
      },
      {
        type: "scatter",
        name: "Outside the usual",
        data: boxes.flatMap((b, k) => b.outliers.slice(0, 50).map((v) => [k, v])),
        symbolSize: 5,
        itemStyle: { color: mix(color, t.surface, 0.5) },
      },
    ],
  };
  return {
    panels: [{ key: "", option }],
    legend: [],
    table: {
      head: [human(x), "Rows", "Low", "Lower quarter", "Median", "Upper quarter", "High"],
      numeric: [false, true, true, true, true, true, true],
      rows: boxes.map((b) => [
        b.label,
        b.n.toLocaleString("en-US"),
        format(b.low, f),
        format(b.q1, f),
        format(b.median, f),
        format(b.q3, f),
        format(b.high, f),
      ]),
    },
    lanes: [
      {
        panel: 0,
        series: 0,
        name: human(y),
        points: boxes.map((b, index) => ({
          index,
          text: `${b.label}: median ${format(b.median, f)}, middle half ${format(b.q1, f)} to ${format(b.q3, f)}, ${plural(b.n, "row")}`,
        })),
      },
    ],
    notes,
    points: boxes.length,
    height: 280,
    summary: `${i.title ?? human(y)}: the spread of ${human(y)} in each ${human(x)}.`,
    pick: (_p, series, index) => {
      const b = series === 0 ? boxes[index] : undefined;
      return b ? { group: { [x]: b.raw }, label: `${i.title ?? human(y)}, ${b.label}` } : null;
    },
  };
}

function nothing(i: ChartInput): Drawn {
  return {
    panels: [{ key: "", option: { animation: false } }],
    legend: [],
    table: { head: [], numeric: [], rows: [] },
    lanes: [],
    notes: [],
    points: 0,
    height: 200,
    summary: i.title ?? "A chart",
    pick: () => null,
  };
}

/** A chart section's answer, drawn as its type. */
export function drawChart(i: ChartInput): Drawn {
  if (i.result.status !== "ok" && !i.result.rowCount) return nothing(i);
  switch (i.type) {
    case "scatter":
      return scatter(i);
    case "bullet":
      return bullet(i);
    case "calendar":
      return calendar(i);
    case "funnel":
      return funnel(i);
    case "treemap":
      return treemap(i);
    case "waterfall":
      return waterfall(i);
    case "heatmap":
      return heatmap(i);
    case "sankey":
      return sankey(i);
    case "timeline":
      return timeline(i);
    case "boxplot":
      return boxplot(i);
    default:
      return i.facet ? multiples(i) : cartesian(i);
  }
}

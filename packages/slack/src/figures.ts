/**
 * An answer's headline figures in Slack: each a card (its number on top, its label, its change with a dot, green for
 * good news and red for bad, its trend as a sparkline), two a row (Slack's carousel, so a row fits a desktop window
 * without scrolling), under its group's heading; or, where Slack refuses cards, Slack's classic fields. Every number is
 * the gate's display of a cell; nothing is computed here but the arrow and the dot, from the change's sign. Pure.
 */
import type { AnswerSegment, ResolvedFigure } from "@opendash/core";
import { quiet } from "./reply";

type Block = Record<string, unknown>;

/** Slack's limits for a card's text (a title and subtitle 150 characters, a body 200), and our cards a row. */
const CARD = { title: 150, subtitle: 150, body: 200, perRow: 2 } as const;

/** Segments as shown: each reference its display. */
export const shownOf = (segments: AnswerSegment[]) => segments.map((s) => ("ref" in s ? s.display : s.text)).join("");

/** Text for Slack's mrkdwn: mentions quieted, then `&`, `<` and `>` as entities, so nothing in it is markup. */
const mrkdwn = (text: string) =>
  quiet(text.replace(/\s+/g, " ").trim()).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const ARROW = { up: "▲", down: "▼", flat: "→" } as const;

/** A figure's change, said with its arrow: "▲ 6.1% vs last week" (the sign is the arrow's to say, taken off its number). */
export function changeLine(f: ResolvedFigure): string | null {
  if (!f.change) return f.vs ?? null;
  const magnitude = f.change.segments
    .map((s) => ("ref" in s ? s.display.replace(/^\s*[+\-−]\s*/, "") : s.text))
    .join("")
    .trim();
  return [ARROW[f.change.direction], magnitude, f.vs].filter(Boolean).join(" ");
}

/** Good news or bad: up is good unless it's a measure where down is (churn, cost). Flat is neither. */
export function tone(f: ResolvedFigure): "good" | "bad" | null {
  if (!f.change || f.change.direction === "flat") return null;
  return (f.change.direction === "up") !== Boolean(f.lowerIsBetter) ? "good" : "bad";
}

/** A figure's change with its dot: "🟢 ▲ 6.1% vs last week". */
function changeWithDot(f: ResolvedFigure): string | null {
  const change = changeLine(f);
  const t = tone(f);
  return change && t ? `${t === "good" ? "🟢" : "🔴"} ${change}` : change;
}

const BARS = "▁▂▃▄▅▆▇█";

/** Values as a sparkline, lowest to highest: "▁▃▅▇". Drawn for the eye; the numbers are the page's. */
export function sparkline(values: number[]): string {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return values.map((v) => BARS[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))]).join("");
}

/** A figure's trend in a line: "Last weeks ▁▂▄▅▇". */
export function trendLine(f: ResolvedFigure): string | null {
  if (!f.trend || f.trend.points.length < 2) return null;
  return `${f.trend.label ?? "Trend"} ${sparkline(f.trend.points.map((p) => p.value))}`;
}

/**
 * One figure as Slack's card: its number on top, its label under it, then its change with its dot, a line more and its
 * trend (the line more left out, then the trend, if too long). Null when its number or its change can't fit whole: never a
 * number cut.
 */
function card(f: ResolvedFigure): Block | null {
  const value = mrkdwn(shownOf(f.value));
  if (value.length + 2 > CARD.title) return null;
  const label = mrkdwn(f.label);
  const subtitle = label.length <= CARD.subtitle ? label : `${label.slice(0, CARD.subtitle - 1)}…`;
  const change = changeWithDot(f);
  const changed = change ? mrkdwn(change) : null;
  if (changed && changed.length > CARD.body) return null;
  const detail = f.detail ? mrkdwn(shownOf(f.detail)) : null;
  const trend = trendLine(f);
  const trended = trend ? mrkdwn(trend) : null;
  const fits = (lines: (string | null)[]) => {
    const text = lines.filter(Boolean).join("\n");
    return text.length <= CARD.body ? text : null;
  };
  const body = fits([changed, detail, trended]) ?? fits([changed, trended]) ?? fits([changed]);
  return {
    type: "card",
    title: { type: "mrkdwn", text: `*${value}*` },
    subtitle: { type: "mrkdwn", text: subtitle },
    ...(body ? { body: { type: "mrkdwn", text: body } } : {}),
  };
}

/** The figures in their groups, in the order they were given (the ungrouped ones as their own group). */
function grouped(figures: ResolvedFigure[]): { name: string | null; figures: ResolvedFigure[] }[] {
  const out: { name: string | null; figures: ResolvedFigure[] }[] = [];
  for (const f of figures) {
    const name = f.group ?? null;
    const at = out.find((g) => g.name === name);
    if (at) at.figures.push(f);
    else out.push({ name, figures: [f] });
  }
  return out;
}

/** Text Slack's mrkdwn would read as formatting (bold, italics, a strike, code): such a figure goes as plain fields. */
const MARKS = /[*_~`]/;
const marked = (f: ResolvedFigure) =>
  [
    f.label,
    f.group ?? "",
    shownOf(f.value),
    changeLine(f) ?? "",
    f.detail ? shownOf(f.detail) : "",
    trendLine(f) ?? "",
  ].some((t) => MARKS.test(t));

/**
 * The figures as Slack's cards: two a row, under their group's heading. A group with a figure whose numbers can't fit
 * a card whole, or whose words Slack would read as formatting, goes as Slack's classic fields instead.
 */
export function figureCards(figures: ResolvedFigure[]): Block[] {
  return grouped(figures).flatMap((g) => {
    const cards = g.figures.map((f) => (marked(f) ? null : card(f)));
    if (cards.some((c) => c === null)) return figureFields(g.figures);
    const rows = Array.from({ length: Math.ceil(cards.length / CARD.perRow) }, (_, i) =>
      cards.slice(i * CARD.perRow, (i + 1) * CARD.perRow),
    );
    return [
      ...(g.name ? [{ type: "section", text: { type: "mrkdwn", text: `*${mrkdwn(g.name)}*` } }] : []),
      ...rows.map((row) => ({ type: "carousel", elements: row })),
    ];
  });
}

/** Plain text for Slack: mentions quieted, nothing in it read as markup or formatting. */
const plain = (text: string) => ({
  type: "plain_text",
  text: quiet(text.replace(/[^\S\n]+/g, " ").trim()),
  emoji: false,
});

/**
 * The figures as Slack's classic fields, for a message without cards: a section a group (its heading its text), two
 * columns of plain-text fields, each the label, the value, the change, a line more and the trend. Past a field's room
 * (2,000 characters) the trend goes, then the line more: never a number cut.
 */
export function figureFields(figures: ResolvedFigure[]): Block[] {
  const field = (f: ResolvedFigure) => {
    const lines = (extra: (string | null)[]) =>
      [f.label, shownOf(f.value), changeWithDot(f), ...extra].filter((l): l is string => Boolean(l?.trim())).join("\n");
    const detail = f.detail ? shownOf(f.detail) : null;
    const text = [lines([detail, trendLine(f)]), lines([detail]), lines([])].find((t) => t.length <= 2_000);
    return plain(text ?? `${f.label}\n${shownOf(f.value)}`);
  };
  return grouped(figures).flatMap((g) =>
    // A section holds ten fields at most.
    Array.from({ length: Math.ceil(g.figures.length / 10) }, (_, i) => g.figures.slice(i * 10, i * 10 + 10)).map(
      (chunk, i) => ({
        type: "section",
        ...(g.name && i === 0 ? { text: plain(g.name) } : {}),
        fields: chunk.map(field),
      }),
    ),
  );
}

/**
 * The figures as plain lines, for what a notification and a screen reader say: "Starter · Orders: 40 (▼ 20% vs last
 * month) · 6 returns", its group first and its line more after.
 */
export function figureLines(figures: ResolvedFigure[]): string[] {
  return figures.map((f) => {
    const change = changeLine(f);
    const detail = f.detail ? shownOf(f.detail).trim() : "";
    return `${f.group ? `${f.group} · ` : ""}${f.label}: ${shownOf(f.value)}${change ? ` (${change})` : ""}${detail ? ` · ${detail}` : ""}`;
  });
}

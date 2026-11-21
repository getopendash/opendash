/**
 * An answer as a card in Slack: its first table as Slack's own table (sortable, a page at a time) and up to two of its
 * charts as Slack's own charts, in the message with its words, instead of a Markdown table and images in a later
 * message. Built from the checked answer only: the text is the answer's own (cut around the table where the parser
 * found it, never rewritten), the table's cells are its cells with each number as the gate shows it, a chart's points
 * are the gate's cells. The model writes nothing here. The table is read from the answer's segments with each
 * reference a placeholder, as the page and the PDF read it: a value (a customer's name with a `|` in it, say) is never
 * parsed as Markdown, so it can't move a checked number into another column. The table and charts go through json-render (`toCard`, its limits refusing what Slack
 * would degrade) and the Slack adapter's `cardToBlockKit`; the words stay Slack `markdown` blocks, as today.
 *
 * Null whenever a card isn't worth the risk: an answer that didn't pass every check, one too long for one message, one
 * with no table or chart Slack can draw, or one the converter didn't turn into exactly the blocks asked for. The reply
 * is then today's message. Pure, for tests.
 */
import { cardToBlockKit, type SlackCardElement } from "@chat-adapter/slack/blocks";
import { type CardLimits, toCard } from "@json-render/chat";
import type { Spec } from "@json-render/core";
import type { AnswerSegment, ResolvedChart, RunOutcome } from "@opendash/core";
import { hasDefinitions, REF_CLOSE, REF_OPEN, takeTable, visibleLinks } from "@opendash/markdown";
import { answerTail, hasNumbers, MESSAGE_LIMIT, quiet } from "./reply";

type Answer = Extract<RunOutcome, { kind: "answer" }>;
type Block = Record<string, unknown>;

/** Slack's limits for its own tables and charts, as the adapter knows them (past them it degrades to a code block). */
const SLACK = {
  tableRows: 100,
  tableColumns: 20,
  tableChars: 10_000,
  charts: 2,
  chartTitle: 50,
  chartLabel: 20,
  chartPoints: 20,
  chartSeries: 12,
} as const;

const LIMITS: CardLimits = {
  tables: 1,
  charts: SLACK.charts,
  tableRows: SLACK.tableRows,
  tableColumns: SLACK.tableColumns,
  chartTitle: SLACK.chartTitle,
  chartLabel: SLACK.chartLabel,
  chartPoints: SLACK.chartPoints,
  chartSeries: SLACK.chartSeries,
};

/** Rows a table shows a page at a time (Slack's default is 5). */
export const TABLE_PAGE = 10;

export interface AnswerCard {
  /** The answer's message as blocks: its words, its table where it was, its charts, then how it read and its caveats. */
  blocks: Block[];
  /** Which of the answer's charts (by index) the card draws: the rest go as images, as before. */
  charts: number[];
}

/** Text cut to Slack's length (counted as Slack counts it), never inside a character, with an ellipsis. */
export function shorten(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let out = "";
  for (const ch of clean) {
    if (out.length + ch.length > max - 1) break;
    out += ch;
  }
  return `${out.trimEnd()}…`;
}

/** Labels cut to Slack's length, or null when cutting makes two of them the same (a chart Slack can't tell apart). */
const labels = (names: string[]): string[] | null => {
  const cut = names.map((n) => shorten(n, SLACK.chartLabel));
  return cut.every((c) => c.length > 0) && new Set(cut).size === cut.length ? cut : null;
};

/**
 * A chart's props for Slack's own chart, or null when Slack can't draw it as the page does: more points than it takes,
 * a gap in a series (never drawn as zero), labels that can't be told apart once cut. Slack's axes show raw numbers,
 * so a percentage is scaled to what its labels say (0.061 → 6.1, the axis "%"), and the currency named on the axis;
 * values are never rounded.
 */
export function nativeChart(chart: ResolvedChart): Record<string, unknown> | null {
  const { categories, series, axis } = chart;
  // Slack's bars stand up: a chart drawn on its side stays the image that draws it so.
  if (chart.horizontal) return null;
  if (!categories.length || categories.length > SLACK.chartPoints) return null;
  if (!series.length || series.length > SLACK.chartSeries) return null;
  if (series.some((s) => s.points.length !== categories.length || s.points.some((p) => p === null))) return null;
  const cats = labels(categories);
  const names = labels(series.map((s) => s.name));
  const title = shorten(chart.title, SLACK.chartTitle);
  if (!cats || !names || !title) return null;
  // The value itself, never rounded (a tiny share stays above zero); a percentage in the units its labels use, without
  // the float noise of the scaling (0.07 × 100 is 7.000000000000001).
  const value = (v: number) => (axis.percent ? Number((v * 100).toPrecision(15)) : v);
  const values = series.map((s) => s.points.map((p) => value(p?.value ?? 0)));
  if (values.some((vs) => vs.some((v) => !Number.isFinite(v)))) return null;
  const yLabel = axis.percent ? "%" : axis.currency ? axis.currency : undefined;
  return {
    title,
    chart: {
      type: chart.type,
      categories: cats,
      series: series.map((_, i) => ({ name: names[i], values: values[i] })),
      ...(yLabel ? { yLabel } : {}),
    },
  };
}

const PLACEHOLDER = new RegExp(`${REF_OPEN}(\\d+)${REF_CLOSE}`, "g");

/** Segments as markdown with each reference a placeholder, and what each stands for (as the PDF reads them). */
function withPlaceholders(segments: AnswerSegment[]): { source: string; fill: (text: string) => string } {
  const displays: string[] = [];
  const source = segments
    .map((s) => {
      if (!("ref" in s)) return s.text;
      displays.push(s.display);
      return `${REF_OPEN}${displays.length - 1}${REF_CLOSE}`;
    })
    .join("");
  return { source, fill: (text) => text.replace(PLACEHOLDER, (_m, i: string) => displays[Number(i)] ?? "") };
}

/** Whether a table fits Slack's own: at least a row, and within its rows, columns and characters. */
const tableFits = (head: string[], rows: string[][]) =>
  head.length > 0 &&
  head.length <= SLACK.tableColumns &&
  rows.length > 0 &&
  rows.length + 1 <= SLACK.tableRows &&
  [head, ...rows].flat().reduce((n, c) => n + c.length, 0) <= SLACK.tableChars;

/**
 * The answer as a card, or null for today's message. `address` puts the asker's mention at its start (a channel's
 * thread holding someone else's conversation too), as the plain message's first line has it.
 */
export function answerCard(
  outcome: RunOutcome | null | undefined,
  address?: (markdown: string) => string,
): AnswerCard | null {
  const answer: Answer | null = outcome?.kind === "answer" ? outcome : null;
  if (answer?.status !== "answered" || !answer.verified || answer.problems.length || !hasNumbers(answer)) return null;
  // An older answer has no segments to read its table from safely: today's message.
  if (!answer.segments) return null;
  const segments = answer.segments.markdown;
  // Text that holds a placeholder's own characters could take a value that isn't its own: today's message.
  if (segments.some((s) => !("ref" in s) && (s.text.includes(REF_OPEN) || s.text.includes(REF_CLOSE)))) return null;
  // The table is read from the answer as written, each value a placeholder, so nothing in a value or a link can move
  // a cell; the values go back in after the parse.
  const { source, fill } = withPlaceholders(segments);
  const body = source.trim();
  // A link that uses a definition elsewhere (`[g]: https://…`) is shown with its address only when the whole reply is
  // read at once, as today's message reads it: that one, then.
  if ([body, ...answer.interpretation, ...answer.caveats].some(hasDefinitions)) return null;
  const taken = takeTable(body);
  const cells = taken && { head: taken.head.map(fill), rows: taken.rows.map((r) => r.map(fill)) };
  const table = taken?.flat && cells && tableFits(cells.head, cells.rows) ? { ...taken, ...cells } : null;
  const charts: { index: number; props: Record<string, unknown> }[] = [];
  for (const [index, chart] of (answer.charts ?? []).entries()) {
    if (charts.length >= SLACK.charts) break;
    const props = nativeChart(chart);
    // Two charts whose titles read the same once cut can't be told apart: the second stays an image.
    if (props && !charts.some((c) => c.props.title === props.title)) charts.push({ index, props });
  }
  if (!table && !charts.length) return null;

  // The words, as the plain message says them (mentions quieted, every link's address in sight, values included), in
  // one message.
  const said = (markdown: string) => quiet(visibleLinks(fill(markdown)));
  const before = said(table ? table.before : body);
  const after = table ? said(table.after) : "";
  const tail = quiet(visibleLinks(answerTail(answer).join("\n\n")));
  if ([before, after, tail].join("\n\n").length > MESSAGE_LIMIT) return null;
  const lead = address ? address(before) : before;

  // The table and the charts as one json-render spec of literal props (no state, no expressions), in order.
  const elements: Spec["elements"] = {};
  const order: string[] = [];
  if (table) {
    elements.table = {
      type: "Table",
      props: { headers: table.head.map((h) => quiet(h)), rows: table.rows.map((r) => r.map((c) => quiet(c))) },
      children: [],
    };
    order.push("table");
  }
  for (const [i, c] of charts.entries()) {
    elements[`chart${i}`] = { type: "Chart", props: c.props, children: [] };
    order.push(`chart${i}`);
  }
  elements.card = { type: "Card", props: {}, children: order };
  let converted: Block[];
  try {
    const card = toCard({ root: "card", elements, state: {} }, { limits: LIMITS });
    // Text as it is: the adapter would otherwise turn a literal `{{emoji:x}}` in a cell or a title into an emoji.
    converted = cardToBlockKit(card as unknown as SlackCardElement, { convertEmoji: (text) => text }) as Block[];
  } catch {
    return null;
  }
  // Exactly the blocks asked for: the adapter turns what Slack can't draw into a code block rather than refusing it.
  const kinds = converted.map((b) => b.type);
  const want = [...(table ? ["data_table"] : []), ...charts.map(() => "data_visualization")];
  if (kinds.length !== want.length || kinds.some((k, i) => k !== want[i])) return null;
  const tableBlock = table ? converted[0] : undefined;
  const chartBlocks = table ? converted.slice(1) : converted;
  if (table && tableBlock) tableBlock.page_size = Math.min(table.rows.length, TABLE_PAGE);

  const md = (text: string): Block[] => (text.trim() ? [{ type: "markdown", text }] : []);
  return {
    blocks: [...md(lead), ...(tableBlock ? [tableBlock] : []), ...md(after), ...chartBlocks, ...md(tail)],
    charts: charts.map((c) => c.index),
  };
}

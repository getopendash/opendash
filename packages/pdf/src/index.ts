import type { RunOutcome } from "@opendash/core";
import {
  type Inline,
  type Block as MdBlock,
  numericColumns,
  parseMarkdown,
  plainText,
  REF_CLOSE,
  REF_OPEN,
} from "@opendash/markdown";
import type { Face } from "./fonts";

export { CHART_SIZE, type ChartImage, chartPng, chartSize, chartSvg } from "./chart";
export { type RenderOptions, renderPdf } from "./draw";
export { packageFontDir } from "./fonts";

/**
 * An answer as a PDF: a report's or a Slack answer's, drawn from the answer as the gate
 * resolved it, not rendered from a page, so it needs no browser: the question, the answer, its charts and caveats,
 * and an appendix with the query cell every number was read from. Here, the answer as blocks; `draw.ts` lays them
 * out with react-pdf, in Geist with a Noto font for every script but CJK (`fonts.ts`). A chart is the page's own
 * drawing, rendered on the server (`chart.ts`).
 */

/** An answer, as the gate resolved it. */
export type Answer = Extract<RunOutcome, { kind: "answer" }>;
type Segment = NonNullable<Answer["segments"]>["markdown"][number];
export type Chart = NonNullable<Answer["charts"]>[number];

/** The query a cell came from, as the appendix names it. */
export interface QueryName {
  alias: string | null;
  title: string | null;
}

/** An answer laid out as blocks, top to bottom: what `renderPdf` draws. */
export type Block =
  | { kind: "head"; organization: string; answeredAt: string }
  | { kind: "title"; text: string }
  | { kind: "note"; text: string }
  /** `quote`: inside a block quote, drawn indented and quieter. */
  | { kind: "paragraph"; runs: Run[]; quote?: boolean }
  | { kind: "heading"; runs: Run[] }
  /** Each item with its marker (a dot, or its number) and how deep it's nested. */
  | { kind: "list"; items: { marker: string; depth: number; runs: Run[] }[] }
  /** `align`: each column's, as the page aligns it (a column of numbers to the right). */
  | { kind: "table"; header: Run[][]; rows: Run[][][]; align: CellAlign[] }
  | { kind: "code"; text: string }
  | { kind: "chips"; items: Run[][] }
  /** `source`: the query its values are cells of, as the page's card says it. */
  | { kind: "chart"; chart: Chart; source: string | null }
  | { kind: "caveat"; runs: Run[] }
  | { kind: "trace"; rows: { figure: string; query: string; cell: string }[] };

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A text's look, run by run: as written, bold (Geist Medium), or code (Geist Mono). */
export type RunStyle = Face;
export interface Run {
  text: string;
  style: RunStyle;
}

/** Where a table cell's text sits in its column. */
export type CellAlign = "left" | "right" | "center";

const PLACEHOLDER = new RegExp(`${REF_OPEN}(\\d+)${REF_CLOSE}`, "g");

/**
 * Segments as markdown with each reference a private-use placeholder, as the page parses them: the parse never sees a
 * number's display, so the PDF and the page read the same text. `displays` are what the placeholders stand for.
 */
function withPlaceholders(segments: Segment[]): { source: string; displays: string[] } {
  const displays: string[] = [];
  const source = segments
    .map((s) => {
      if (!("ref" in s)) return s.text;
      displays.push(s.display);
      return `${REF_OPEN}${displays.length - 1}${REF_CLOSE}`;
    })
    .join("");
  return { source, displays };
}

/**
 * Inline parts as runs: bold in Geist Medium, code in Geist Mono, italics, struck text and links as their text (Geist
 * has no italic face; a PDF follows no link). A reference is its display, in bold, as the page shows a traced number.
 */
function runsOf(parts: Inline[], displays: string[], style: RunStyle = "regular"): Run[] {
  const out: Run[] = [];
  const push = (text: string, s: RunStyle) => {
    if (!text) return;
    const last = out.at(-1);
    if (last?.style === s) last.text += text;
    else out.push({ text, style: s });
  };
  const text = (value: string, s: RunStyle) => {
    let at = 0;
    for (const m of value.matchAll(PLACEHOLDER)) {
      push(value.slice(at, m.index), s);
      push(displays[Number(m[1])] ?? "", s === "code" ? "code" : "bold");
      at = m.index + m[0].length;
    }
    push(value.slice(at), s);
  };
  for (const p of parts) {
    if (p.kind === "text") text(p.text, style);
    else if (p.kind === "code") text(p.text, "code");
    // A hard line break, as the page draws it.
    else if (p.kind === "break") push("\n", style);
    else out.push(...runsOf(p.children, displays, p.kind === "bold" && style !== "code" ? "bold" : style));
  }
  return joined(out);
}

/** A list's items, nested ones deeper: an item's first paragraph has its marker, anything after it carries on. */
function listItems(
  list: Extract<MdBlock, { kind: "list" }>,
  displays: string[],
  depth = 0,
): Extract<Block, { kind: "list" }>["items"] {
  return list.items.flatMap((item, i) => {
    const marker = list.start === null ? "•" : `${list.start + i}.`;
    let first = true;
    return item.flatMap((b) => {
      if (b.kind === "list") return listItems(b, displays, depth + 1);
      const runs =
        b.kind === "paragraph" || b.kind === "heading" ? runsOf(b.content, displays) : flatRuns([b], displays);
      const at = { marker: first ? marker : "", depth, runs };
      first = false;
      return [at];
    });
  });
}

/** Blocks' text as one line of runs (a chip, a caveat). */
function flatRuns(blocks: MdBlock[], displays: string[]): Run[] {
  const runs: Run[] = [];
  for (const b of blocks) {
    const more =
      b.kind === "paragraph" || b.kind === "heading"
        ? runsOf(b.content, displays)
        : b.kind === "code"
          ? [{ text: b.text, style: "code" as const }]
          : b.kind === "list"
            ? b.items.flatMap((item) => flatRuns(item, displays))
            : b.kind === "quote"
              ? flatRuns(b.children, displays)
              : b.kind === "table"
                ? [...b.head, ...b.rows.flat()].flatMap((cell) => runsOf(cell, displays))
                : [];
    if (runs.length && more.length) runs.push({ text: " ", style: "regular" });
    runs.push(...more);
  }
  return joined(runs);
}

/** Segments read as markdown, the page's way, as one line of runs. */
const lineOf = (segments: Segment[]) => {
  const { source, displays } = withPlaceholders(segments);
  return flatRuns(parseMarkdown(source), displays);
};

/**
 * The answer's text as blocks, read the CommonMark way as the page reads it (@opendash/markdown): paragraphs,
 * headings, lists (numbered ones from their first number, nested ones indented), tables, code and quotes, every
 * reference by what it shows.
 */
export function textBlocks(
  segments: Segment[],
): Extract<Block, { kind: "paragraph" | "heading" | "list" | "table" | "code" }>[] {
  const { source, displays } = withPlaceholders(segments);
  const blocks = (
    md: MdBlock[],
    quote = false,
  ): Extract<Block, { kind: "paragraph" | "heading" | "list" | "table" | "code" }>[] =>
    md.flatMap((b): Extract<Block, { kind: "paragraph" | "heading" | "list" | "table" | "code" }>[] => {
      switch (b.kind) {
        case "paragraph":
          return [{ kind: "paragraph", runs: runsOf(b.content, displays), ...(quote ? { quote: true } : {}) }];
        case "heading":
          return [{ kind: "heading", runs: runsOf(b.content, displays) }];
        case "list":
          return [{ kind: "list", items: listItems(b, displays) }];
        case "table": {
          // Aligned as the page aligns it: a column of numbers (references among them) to the right.
          const numeric = numericColumns({ align: b.align, head: b.head, rows: b.rows.map((r) => r.map(plainText)) });
          return [
            {
              kind: "table",
              header: b.head.map((c) => runsOf(c, displays)),
              rows: b.rows.map((r) => r.map((c) => runsOf(c, displays))),
              align: b.head.map((_, c) => (numeric[c] ? "right" : b.align[c] === "center" ? "center" : "left")),
            },
          ];
        }
        case "code":
          return [{ kind: "code", text: b.text }];
        case "quote":
          return blocks(b.children, true);
        default:
          // A rule draws nothing.
          return [];
      }
    });
  return blocks(parseMarkdown(source)).filter((b) => b.kind !== "paragraph" || b.runs.some((r) => r.text.trim()));
}

/** What a chart's values are cells of, as its card on the page says: its query's alias, and the query's title. */
function chartSource(chart: Chart, names: Map<string, QueryName>): string | null {
  const cell = chart.series.flatMap((s) => s.points).find((p) => p)?.cell;
  if (!cell) return null;
  const name = names.get(cell.queryRunId);
  return `Every value is a cell of ${name?.alias ?? cell.alias}${name?.title ? ` · ${name.title}` : ""}.`;
}

/** The appendix: each traced number once, with the query and cell it came from. */
function traceRows(answer: Answer, names: Map<string, QueryName>): Extract<Block, { kind: "trace" }>["rows"] {
  const segs = answer.segments;
  const figures = answer.figures ?? [];
  const refs = [
    ...figures.flatMap((f) => [...f.value, ...(f.change?.segments ?? []), ...(f.detail ?? [])]),
    ...(segs?.markdown ?? []),
    ...(segs?.caveats.flat() ?? []),
    ...(segs?.interpretation.flat() ?? []),
  ];
  const seen = new Set<string>();
  const rows: Extract<Block, { kind: "trace" }>["rows"] = [];
  for (const s of refs) {
    if (!("ref" in s) || s.kind !== "number" || seen.has(s.ref)) continue;
    seen.add(s.ref);
    const cells = s.citations;
    const first = cells[0];
    if (!first) continue;
    const name = names.get(first.queryRunId);
    const alias = name?.alias ?? first.alias;
    const rowsOf = [...new Set(cells.map((c) => c.row + 1))];
    rows.push({
      figure: s.display,
      query: name?.title ? `${alias} · ${name.title}` : alias,
      cell: `${rowsOf.length > 1 ? `rows ${rowsOf.join(", ")}` : `row ${rowsOf[0]}`} · ${[...new Set(cells.map((c) => c.column))].join(", ")}`,
    });
  }
  // A figure's trend: its values, each a cell of one column.
  for (const f of figures) {
    const points = f.trend?.points ?? [];
    const first = points[0]?.cell;
    if (!first) continue;
    const name = names.get(first.queryRunId);
    const alias = name?.alias ?? first.alias;
    rows.push({
      figure: points.map((p) => p.display).join(" · "),
      query: name?.title ? `${alias} · ${name.title}` : alias,
      cell: `rows ${points.map((p) => p.cell.row + 1).join(", ")} · ${first.column}`,
    });
  }
  return rows;
}

const ARROW = { up: "▲", down: "▼", flat: "→" } as const;

/**
 * An answer's title and headline figures, as the page draws them above its text: the title a heading, each group of
 * figures a table (the figure, its value, its change with what it's against, a line more and its trend) under its
 * group's heading.
 */
function figureBlocks(answer: Answer): Block[] {
  const figures = answer.figures ?? [];
  const blocks: Block[] = answer.title ? [{ kind: "heading", runs: [{ text: answer.title, style: "bold" }] }] : [];
  const groups: { name: string | null; figures: typeof figures }[] = [];
  for (const f of figures) {
    const name = f.group ?? null;
    const at = groups.find((g) => g.name === name);
    if (at) at.figures.push(f);
    else groups.push({ name, figures: [f] });
  }
  const text = (t: string): Run[] => (t ? [{ text: t, style: "regular" }] : []);
  for (const g of groups) {
    if (g.name) blocks.push({ kind: "paragraph", runs: [{ text: g.name, style: "bold" }] });
    blocks.push({
      kind: "table",
      header: [text("Figure"), text("Value"), text("Change"), text("More")],
      align: ["left", "right", "left", "left"],
      rows: g.figures.map((f) => [
        text(f.label),
        lineOf(f.value),
        [
          ...(f.change
            ? [{ text: `${ARROW[f.change.direction]} `, style: "regular" as const }, ...lineOf(f.change.segments)]
            : []),
          ...text(f.vs ? ` ${f.vs}` : ""),
        ],
        [
          ...(f.detail ? lineOf(f.detail) : []),
          ...text(
            f.trend
              ? `${f.detail ? " · " : ""}${f.trend.label ?? "Trend"}: ${f.trend.points.map((p) => p.display).join(" · ")}`
              : "",
          ),
        ],
      ]),
    });
  }
  return blocks;
}

/**
 * An answer's blocks, in reading order: its head, the question, a note saying where it's from (the caller's words),
 * the interpretation, the text, charts and caveats, then where each number comes from. Pure, for tests.
 */
export function answerBlocks(
  answer: Answer,
  context: {
    organization: string;
    /** When it was answered (ISO). */
    answeredAt: string;
    question: string;
    note: string;
    names: Map<string, QueryName>;
  },
): Block[] {
  const segs = answer.segments;
  const chips = (segs?.interpretation ?? []).map(lineOf).filter((c) => c.some((r) => r.text.trim()));
  const trace = traceRows(answer, context.names);
  return [
    { kind: "head", organization: context.organization, answeredAt: DAY.format(new Date(context.answeredAt)) },
    { kind: "title", text: context.question },
    { kind: "note", text: `${context.note}${answer.verified ? "" : " Some of it couldn't be verified."}` },
    ...(chips.length ? [{ kind: "chips" as const, items: chips }] : []),
    ...figureBlocks(answer),
    ...(segs ? textBlocks(segs.markdown) : textBlocks([{ text: answer.rendered }] as Segment[])),
    ...(answer.charts ?? []).map((chart) => ({
      kind: "chart" as const,
      chart,
      source: chartSource(chart, context.names),
    })),
    ...(segs?.caveats ?? [])
      .map((c) => ({ kind: "caveat" as const, runs: lineOf(c) }))
      .filter((c) => c.runs.some((r) => r.text.trim())),
    ...(trace.length ? [{ kind: "trace" as const, rows: trace }] : []),
  ];
}

/** A PDF's file name: its title as a slug, never the raw text (a header can't carry it safely). */
export function pdfFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return `${slug || "report"}.pdf`;
}

/** Neighbouring runs of one style, as one. */
function joined(line: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of line) {
    const last = out.at(-1);
    if (last?.style === r.style) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}

/**
 * An answer's blocks drawn as a PDF, laid out by react-pdf: it wraps lines, breaks
 * pages, repeats a table's header on each page the table runs onto, and keeps a row, a chart or a box whole. Ours is
 * only what react-pdf leaves to the caller: the fonts (`fonts.ts`), where long tokens may break and what no font has
 * (`text.ts`), and a table's column widths (`table.ts`). Same look as the hand-drawn pages it replaced. Elements are
 * made with `createElement`: the package has no JSX build.
 */

import { tokens } from "@opendash/tokens";
import { Document, Image, Page, renderToBuffer, type Styles, Text, View } from "@react-pdf/renderer";
import { createElement as h, type ReactNode } from "react";
import { type ChartImage, chartPng } from "./chart";
import { CODE_FONTS, type Fonts, packageFontDir, pdfFonts, TEXT_FONTS } from "./fonts";
import type { Block, CellAlign, Chart, Run, RunStyle } from "./index";
import { columnWidths } from "./table";
import { breakable, codeText, drawable, unbreakable } from "./text";

type Style = Styles[string];

/** The light theme's colours, as the page draws them. */
const INK = tokens.light.foreground;
const SUB = tokens.light.muted;
const FAINT = tokens.light["muted-tertiary"];
const LINE = tokens.light.border;
const WASH = tokens.light["surface-secondary"];

/**
 * A text's size, and its line height as a multiple of it. Always both in one style: react-pdf multiplies a line height
 * by the size given beside it, or by its default 18 pt when there's none (an inherited size comes too late).
 */
const type = (size: number, lead: number): Style => ({ fontSize: size, lineHeight: lead });

/** A4, in points, and its margin; the text column between the margins. */
const MARGIN = 56;
const WIDTH = 595.28 - 2 * MARGIN;

/** The most of a code block a PDF draws: an answer's own code is a query or two, never pages. */
const CODE_LIMIT = 6_000;
/** Code a little smaller than the text around it: Geist Mono is wider. */
const CODE_SCALE = 0.92;
/** Between a table's columns, as the page's 24 px at its 14 px text. */
const COLUMN_GAP = 16;
/** A table row taller than this (a long paragraph in a cell) may break across pages; a shorter one moves whole. */
const WHOLE_ROW = 300;

/** A number as a cell shows it (digits with their currency, sign, percent and units): kept on one line. */
const NUMBER = /^[\s$€£¥₹%+\-−.,()kKMBx×\d]*\d[\s$€£¥₹%+\-−.,()kKMBx×\d]*$/;

/** How a PDF's charts are drawn. */
export interface RenderOptions {
  /** A chart that couldn't be drawn: its values went in as a table instead, and this hears why. */
  onChartError?: (error: unknown) => void;
  /** Draws a chart: the page's own drawing (`chartPng`), unless a test stands in. */
  chartImage?: (chart: Chart, fontDir: string) => Promise<ChartImage>;
}

/** Draws the blocks on A4 pages, with the footer and page numbers on each, in the fonts from `fontDir`. */
export async function renderPdf(
  blocks: Block[],
  title: string,
  fontDir = packageFontDir(),
  options: RenderOptions = {},
): Promise<Uint8Array> {
  const fonts = await pdfFonts(fontDir);
  // The charts first, each the page's own drawing; one that can't be drawn goes in as its values.
  const images = new Map<Block, ChartImage>();
  for (const b of blocks) {
    if (b.kind !== "chart") continue;
    try {
      images.set(b, await (options.chartImage ?? chartPng)(b.chart, fontDir));
    } catch (error) {
      options.onChartError?.(error);
    }
  }
  const draw = drawing(fonts, images);
  const document = h(
    Document,
    { title, creator: "OpenDash", producer: "OpenDash" },
    h(
      Page,
      {
        size: "A4",
        style: {
          fontFamily: TEXT_FONTS,
          fontSize: 11,
          color: INK,
          paddingTop: MARGIN,
          paddingHorizontal: MARGIN,
          paddingBottom: MARGIN + 24,
        },
      },
      ...blocks.map(draw),
      h(
        View,
        {
          fixed: true,
          style: {
            position: "absolute",
            bottom: 24,
            left: MARGIN,
            right: MARGIN,
            flexDirection: "row",
            justifyContent: "space-between",
            fontSize: 8,
            color: FAINT,
          },
        },
        h(Text, null, "OpenDash · every figure read from a query result"),
        h(Text, { render: ({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}` }),
      ),
    ),
  );
  return new Uint8Array(await renderToBuffer(document));
}

/** Each block as its elements, in these fonts, with its chart drawn (or not). */
function drawing(fonts: Fonts, images: Map<Block, ChartImage>) {
  /** A text's pieces as the fonts draw them: a long token cut where it may break; a number cell's all one piece. */
  const pieces = (text: string, number = false) =>
    (number ? [unbreakable(text)] : breakable(text)).map((piece) => drawable(piece, fonts.covers));
  /** Text as its elements: its pieces, with a space too thin to see between them, where a line may break. */
  const prepared = (text: string, number = false): ReactNode[] =>
    pieces(text, number).flatMap((piece, i) => (i ? [h(Text, { style: { fontSize: 0.01 } }, " "), piece] : [piece]));
  const RUN: Record<RunStyle, (size: number) => Style> = {
    regular: () => ({}),
    bold: () => ({ fontWeight: 500 }),
    code: (size) => ({ fontFamily: CODE_FONTS, fontSize: size * CODE_SCALE }),
  };
  /** Runs as nested texts, each in its face, inside a text of `size`. */
  const runs = (line: Run[], size: number, number = false): ReactNode[] =>
    line.map((r) => h(Text, { style: RUN[r.style](size) }, ...prepared(r.text, number)));
  const bolded = (line: Run[]) => line.map((r) => (r.style === "regular" ? { ...r, style: "bold" as const } : r));
  const plain = (line: Run[]) => line.map((r) => r.text).join("");

  /**
   * A table: its columns as wide as `widths`, or as `columnWidths` lays them out from what's in them; numbers right
   * where `align` says so (a column of numbers), each kept on one line; the header on each page the table runs onto.
   */
  const table = (
    header: Run[][],
    rows: Run[][][],
    align: CellAlign[],
    spec: { size: number; widths?: number[]; gap?: number; bottom?: number },
  ): ReactNode => {
    const n = Math.max(header.length, ...rows.map((r) => r.length), 1);
    const head = Array.from({ length: n }, (_, c) => bolded(header[c] ?? []));
    const body = rows.map((r) => Array.from({ length: n }, (_, c) => r[c] ?? []));
    const isNumber = (cell: Run[]) => NUMBER.test(plain(cell));
    /** A cell's widest piece that can't break (all of it, for a number) and its width on one line. */
    const measure = (cell: Run[], number: boolean) => {
      const parts = cell.map((r) => ({ style: r.style, pieces: pieces(r.text, number) }));
      const whole = parts.reduce((s, r) => s + fonts.width(r.pieces.join(""), r.style, spec.size), 0);
      if (number) return { min: whole, max: whole };
      const words = parts.flatMap((r) =>
        r.pieces.flatMap((piece) => piece.split(/\s+/)).map((word) => fonts.width(word, r.style, spec.size)),
      );
      return { min: Math.max(0, ...words), max: whole };
    };
    const laid = spec.widths
      ? { widths: spec.widths, gap: spec.gap ?? COLUMN_GAP, scale: 1 }
      : columnWidths(
          Array.from({ length: n }, (_, c) => {
            const cells = [
              measure(head[c] ?? [], false),
              ...body.map((r) => measure(r[c] ?? [], isNumber(r[c] ?? []))),
            ];
            // A little over what's measured: react-pdf kerns, the measure doesn't.
            return {
              min: Math.max(...cells.map((x) => x.min)) + 1,
              max: Math.max(...cells.map((x) => x.max)) + 1,
            };
          }),
          WIDTH,
          spec.gap ?? COLUMN_GAP,
        );
    const size = spec.size * laid.scale;
    const lead = size * 1.4;
    const row = (cells: Run[][], heading: boolean): ReactNode => {
      const numbers = cells.map((cell) => !heading && isNumber(cell));
      // How tall it gets, roughly: its tallest cell's lines.
      const lines = Math.max(
        1,
        ...cells.map(
          (cell, c) =>
            Math.ceil(
              cell.reduce((s, r) => s + fonts.width(r.text, r.style, size), 0) / Math.max(1, laid.widths[c] ?? 1),
            ) + (plain(cell).match(/\n/g)?.length ?? 0),
        ),
      );
      return h(
        View,
        {
          // The header goes on each page the table runs onto, and never alone at a page's foot.
          ...(heading ? { fixed: true, minPresenceAhead: lead * 2 + 6 } : {}),
          wrap: lines * lead + 6 > WHOLE_ROW,
          style: { flexDirection: "row", borderBottomWidth: 0.5, borderBottomColor: LINE, paddingVertical: 3 },
        },
        ...cells.map((cell, c) =>
          h(
            Text,
            {
              style: {
                width: laid.widths[c] ?? 0,
                marginRight: c < n - 1 ? laid.gap : 0,
                ...type(size, 1.4),
                color: heading ? SUB : INK,
                textAlign: align[c] ?? "left",
              },
            },
            ...runs(cell, size, numbers[c]),
          ),
        ),
      );
    };
    return h(
      View,
      // As wide as its columns, as the page's table: its lines end with them.
      {
        style: { width: laid.widths.reduce((s, w) => s + w, 0) + laid.gap * (n - 1), marginBottom: spec.bottom ?? 12 },
      },
      ...(header.length ? [row(head, true)] : []),
      ...body.map((r) => row(r, false)),
    );
  };

  /** A chart as its card on the page: its title, the drawing (legend, value axis, each value), what it's cells of. */
  const chartCard = (b: Extract<Block, { kind: "chart" }>, image: ChartImage): ReactNode => {
    const pad = 12;
    const inner = WIDTH - 2 * pad;
    return h(
      View,
      { wrap: false, style: { borderWidth: 0.6, borderColor: LINE, padding: pad, marginBottom: 12 } },
      h(Text, { style: { ...type(10.5, 1.35), fontWeight: 500, marginBottom: 8 } }, ...prepared(b.chart.title)),
      h(Image, {
        src: { data: Buffer.from(image.png), format: "png" },
        style: { width: inner, height: (inner * image.height) / image.width },
      }),
      b.source ? h(Text, { style: { fontSize: 8.5, color: SUB, marginTop: 6 } }, ...prepared(b.source)) : null,
    );
  };

  /** A chart that couldn't be drawn: its title, then its values in a table, each as the page shows it. */
  const chartValues = (b: Extract<Block, { kind: "chart" }>): ReactNode => {
    const { chart } = b;
    const cell = (text: string): Run[] => [{ text, style: "regular" }];
    return h(
      View,
      { style: { marginBottom: 12 } },
      h(
        Text,
        { minPresenceAhead: 40, style: { fontSize: 10.5, fontWeight: 500, marginBottom: 4 } },
        ...prepared(chart.title),
      ),
      table(
        ["", ...chart.series.map((s) => s.name)].map(cell),
        chart.categories.map((c, i) => [c, ...chart.series.map((s) => s.points[i]?.display ?? "—")].map(cell)),
        ["left", ...chart.series.map(() => "right" as const)],
        { size: 10, bottom: 6 },
      ),
      b.source ? h(Text, { style: { fontSize: 8.5, color: SUB } }, ...prepared(b.source)) : null,
    );
  };

  return (b: Block): ReactNode => {
    switch (b.kind) {
      case "head":
        return h(
          View,
          {
            style: {
              flexDirection: "row",
              justifyContent: "space-between",
              fontSize: 9.5,
              color: SUB,
              paddingBottom: 8,
              borderBottomWidth: 0.6,
              borderBottomColor: LINE,
              marginBottom: 18,
            },
          },
          h(
            Text,
            null,
            h(Text, { style: { fontWeight: 500, color: INK } }, "OpenDash"),
            ...prepared(` · ${b.organization} · Report`),
          ),
          h(Text, null, `Answered ${b.answeredAt}`),
        );
      case "title":
        return h(Text, { style: { ...type(18, 1.3), fontWeight: 500, marginBottom: 6 } }, ...prepared(b.text));
      case "note":
        return h(Text, { style: { ...type(9.5, 1.45), color: SUB, marginBottom: 12 } }, ...prepared(b.text));
      case "chips": {
        const dot: Run[] = [{ text: "  ·  ", style: "regular" }];
        return h(
          Text,
          { style: { ...type(9.5, 1.45), color: SUB, marginBottom: 10 } },
          ...runs(
            b.items.flatMap((c, i) => (i ? [...dot, ...c] : c)),
            9.5,
          ),
        );
      }
      case "paragraph":
        // A quote's paragraph indented and quieter, a rule beside it.
        return b.quote
          ? h(
              View,
              {
                style: {
                  borderLeftWidth: 1.2,
                  borderLeftColor: LINE,
                  marginLeft: 2,
                  paddingLeft: 10,
                  marginBottom: 10,
                },
              },
              h(Text, { style: { ...type(11, 1.45), color: SUB } }, ...runs(b.runs, 11)),
            )
          : h(Text, { style: { ...type(11, 1.45), marginBottom: 10 } }, ...runs(b.runs, 11));
      case "heading":
        return h(
          Text,
          { minPresenceAhead: 40, style: { ...type(12, 1.4), marginBottom: 8 } },
          ...runs(bolded(b.runs), 12),
        );
      case "list": {
        // Each item's marker (a dot, or its number) in its own column, a nested list a step in.
        const column = Math.max(14, ...b.items.map((it) => fonts.width(it.marker, "regular", 11) + 6));
        return h(
          View,
          { style: { marginBottom: 7 } },
          ...b.items.map((item) =>
            h(
              View,
              { style: { flexDirection: "row", paddingLeft: item.depth * 16, marginBottom: 3 } },
              h(Text, { style: { ...type(11, 1.45), width: column, paddingLeft: 2, color: SUB } }, item.marker),
              h(Text, { style: { ...type(11, 1.45), flex: 1 } }, ...runs(item.runs, 11)),
            ),
          ),
        );
      }
      case "code": {
        // As written, in Geist Mono on a wash: its spaces kept, a line too long broken where it meets the edge, and a
        // block past CODE_LIMIT characters ending there.
        const size = 9;
        const text = b.text.length > CODE_LIMIT ? `${b.text.slice(0, CODE_LIMIT)}…` : b.text;
        return h(
          View,
          { style: { backgroundColor: WASH, paddingVertical: 6, paddingHorizontal: 10, marginBottom: 10 } },
          h(
            Text,
            { style: { ...type(size, 1.5), fontFamily: CODE_FONTS } },
            codeText(drawable(text, fonts.covers), fonts.codeColumns(WIDTH - 20, size) - 1),
          ),
        );
      }
      case "table":
        return table(b.header, b.rows, b.align, { size: 10 });
      case "caveat":
        return h(
          View,
          {
            wrap: plain(b.runs).length > 1_500,
            style: { backgroundColor: WASH, paddingVertical: 6, paddingHorizontal: 10, marginBottom: 10 },
          },
          h(Text, { style: { ...type(9.5, 1.45), color: SUB } }, ...runs(b.runs, 9.5)),
        );
      case "chart": {
        const image = images.get(b);
        return image ? chartCard(b, image) : chartValues(b);
      }
      case "trace": {
        const cell = (text: string, style: RunStyle): Run[] => [{ text, style }];
        return h(
          View,
          { style: { marginTop: 6 } },
          h(
            Text,
            { minPresenceAhead: 40, style: { fontSize: 11, fontWeight: 500, marginBottom: 4 } },
            "Where each number comes from",
          ),
          table(
            [cell("Figure", "bold"), cell("Query", "bold"), cell("Cell", "bold")],
            b.rows.map((r) => [cell(r.figure, "bold"), cell(r.query, "regular"), cell(r.cell, "code")]),
            ["left", "left", "left"],
            { size: 9, widths: [70, 244, WIDTH - 330], gap: 8 },
          ),
        );
      }
    }
  };
}

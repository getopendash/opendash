// A PDF's charts are the page's own drawing: each value written by its bar, the value
// axis in the answer's format and the legend, in Geist; long names kept to their column so nothing leaves the drawing;
// a line's values by its points, or at its end when long; a PNG fine enough to print; in the PDF a card saying what
// its values are cells of; and a chart that can't be drawn goes in as its values, never lost.
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as fontkit from "fontkit";
import { describe, expect, it } from "vitest";
import {
  type Answer,
  answerBlocks,
  CHART_SIZE,
  chartPng,
  chartSize,
  chartSvg,
  packageFontDir,
  renderPdf,
} from "../src";

const fonts = packageFontDir();
const months = ["2026-04-01", "2026-05-01", "2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"];
const at = (row: number, column: string) => ({ alias: "q1", queryRunId: "qr1", row, column });
const points = (column: string, values: number[], show = (v: number) => v.toLocaleString("en-US")) =>
  values.map((value, row) => ({ value, display: show(value), cell: at(row, column) }));
const orders = {
  type: "bar" as const,
  title: "Orders placed and shipped, by month",
  horizontal: false,
  axis: { compact: true },
  categories: months,
  series: [
    { name: "Orders placed", points: points("placed", [512, 488, 703, 655, 741, 820]) },
    { name: "Orders shipped", points: points("shipped", [290, 301, 377, 342, 395, 433]) },
  ],
};
const answer = (charts: unknown[]): Answer =>
  ({
    kind: "answer",
    status: "answered",
    verified: true,
    rendered: "",
    segments: { markdown: [{ text: "Orders grew." }], interpretation: [], caveats: [] },
    charts,
  }) as unknown as Answer;
const context = {
  organization: "Acme",
  answeredAt: "2026-10-16T09:00:00Z",
  question: "How did orders go?",
  note: "Asked in Slack.",
  names: new Map([["qr1", { alias: "q1", title: "Orders by month" }]]),
};
/** The images a PDF draws: each image object, but its transparency (an image too, the PNG's alpha). */
const images = (bytes: Uint8Array) => {
  const pdf = Buffer.from(bytes).toString("latin1");
  return pdf.split("/Subtype /Image").length - pdf.split("/SMask ").length;
};

describe("a chart off the page", () => {
  it("is the page's drawing: each value by its bar, the value axis, the legend, every month, in Geist", async () => {
    const svg = await chartSvg(orders, fonts);
    for (const text of ["512", "820", "290", "433", "1k", "800", "Orders placed", "Orders shipped", ...months]) {
      expect(svg).toContain(`>${text}</text>`);
    }
    expect(svg).toContain("font-family:Geist;");
    // The family it names is the one resvg loads: Geist-Regular.ttf's own name.
    const geist = fontkit.create(await readFile(path.join(fonts, "Geist-Regular.ttf")));
    expect("familyName" in geist && geist.familyName).toBe("Geist");

    const money = await chartSvg(
      {
        ...orders,
        horizontal: true,
        axis: { currency: "USD", compact: true },
        series: [{ name: "Revenue", points: points("revenue", [1200, 2500], (v) => `$${v / 1000}k`) }],
        categories: ["Starter", "Growth"],
      },
      fonts,
    );
    expect(money).toContain(">$2.5k</text>");
    expect(money).toContain(">$1k</text>");
  });

  it("keeps long names to their column, so the bars and their values stay inside the drawing", async () => {
    // Made-up names as long as real ones get: one past two lines' width.
    const names = [
      "Gift wrapping | questions by email",
      "Guide: shop process: packing large furniture orders for the next delivery van and its route",
      "SPRING_SALE_2026 + BUNDLE_OFFER_V2 (catalog LIVE) v1",
      "Garden furniture price list valid from May (draft copy)",
      ...Array.from({ length: 6 }, (_, i) => `Gift card process ${i}`),
    ];
    const longNames = {
      ...orders,
      horizontal: true,
      categories: names,
      series: [{ name: "Orders", points: points("runs", [3640, 3210, 2890, 2650, 2480, 1700, 1520, 1180, 790, 720]) }],
    };
    const size = chartSize(longNames);
    expect(size).toEqual({ width: CHART_SIZE.width, height: 64 + 36 * 10 });
    const svg = await chartSvg(longNames, fonts);
    // Every value written by its bar, and every one of them and the axis's last tick inside the drawing.
    const at = (text: string) =>
      Number(new RegExp(`translate\\(([\\d.]+) [\\d.]+\\)"[^>]*>${text}</text>`).exec(svg)?.[1]);
    for (const value of ["3,640", "720"]) expect(at(value)).toBeLessThan(size.width - 30);
    expect(at("4k")).toBeLessThan(size.width);
    // The longest name wraps onto a second line and ends in "…" rather than taking the plot's width.
    expect(svg).toContain("…</text>");
  });

  it("writes a two-line chart's values, and each line's latest at its end when they're long", async () => {
    const months = { ...orders, type: "line" as const };
    const svg = await chartSvg(months, fonts);
    for (const value of ["512", "820", "290", "433"]) expect(svg).toContain(`>${value}</text>`);
    const days = Array.from({ length: 31 }, (_, i) => `Sep ${i + 1}`);
    const month = {
      ...months,
      categories: days,
      series: [
        {
          name: "Users",
          points: points(
            "users",
            days.map((_, i) => 1180 + i * 9),
          ),
        },
      ],
    };
    const ended = await chartSvg(month, fonts);
    expect(ended).toContain(">1,450</text>");
    expect(ended).not.toContain(">1,189</text>");
  });

  it("is a PNG three times its CSS size, to print", async () => {
    const image = await chartPng(orders, fonts);
    expect(Buffer.from(image.png.slice(1, 4)).toString()).toBe("PNG");
    expect(image).toMatchObject({ width: CHART_SIZE.width * 3, height: CHART_SIZE.height * 3 });
  });

  it("goes in a PDF as a card that says what its values are cells of", async () => {
    const blocks = answerBlocks(answer([orders]), context);
    expect(blocks.find((b) => b.kind === "chart")).toMatchObject({
      source: "Every value is a cell of q1 · Orders by month.",
    });
    expect(images(await renderPdf(blocks, "Orders"))).toBe(1);
  });

  it("goes in as its values when it can't be drawn, and the caller hears why", async () => {
    const blocks = answerBlocks(answer([orders]), context);
    const errors: unknown[] = [];
    const bytes = await renderPdf(blocks, "Orders", fonts, {
      chartImage: async () => {
        throw new Error("no renderer here");
      },
      onChartError: (error) => errors.push(error),
    });
    expect(images(bytes)).toBe(0);
    expect(errors).toEqual([new Error("no renderer here")]);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});

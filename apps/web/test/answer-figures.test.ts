// An answer's headline figures on the page: a card each, in a group under its heading, its value a traced number, its
// change with an arrow and its number as Sources shows it (signed), a line more, and its trend as bars (its values said to a
// screen reader).
import type { ResolvedFigure } from "@opendash/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { AnswerFigures, figureLines } = await import("../components/ask/answer-figures");

const ref = (display: string) => ({
  ref: "q1:0:x",
  display,
  kind: "number" as const,
  citations: [{ alias: "q1", queryRunId: "run-1", row: 0, column: "x" }],
});
const point = (display: string, value: number, row: number) => ({
  value,
  display,
  cell: { alias: "q1", queryRunId: "run-1", row, column: "x" },
});

const draw = (figures: ResolvedFigure[]) =>
  renderToStaticMarkup(createElement(AnswerFigures, { figures, inspected: null, onTrace: () => {} }));

describe("an answer's headline figures on the page", () => {
  it("draws a card each: its label, its value traced, its change with an arrow, a line more, its trend", () => {
    const html = draw([
      {
        label: "Activated riders",
        value: [ref("6,727")],
        change: { segments: [ref("+6.1%")], direction: "up" },
        vs: "vs last week",
        detail: [ref("43%"), { text: " of trials" }],
        trend: { label: "Last weeks", points: [point("6.0k", 6000, 0), point("6.7k", 6700, 1)] },
      },
    ]);
    for (const part of ["Activated riders", "6,727", "▲", "+6.1%", "vs last week", "43%", " of trials", "sparkline"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain("Last weeks: 6.0k, 6.7k");
    expect(html).toContain("traced-number");
  });

  it("colours a change green for good news and red for bad, down being good where lower is better", () => {
    const rose = { segments: [ref("+6.1%")], direction: "up" as const };
    expect(draw([{ label: "Orders", value: [ref("40")], change: rose }])).toContain("answer-figures__change--good");
    expect(draw([{ label: "Churn", value: [ref("4")], change: rose, lowerIsBetter: true }])).toContain(
      "answer-figures__change--bad",
    );
    const flat = { segments: [ref("0%")], direction: "flat" as const };
    expect(draw([{ label: "Orders", value: [ref("40")], change: flat }])).toContain("answer-figures__change--flat");
  });

  it("puts figures that go together under their heading, in the order given", () => {
    const html = draw([
      { label: "Acquisition", value: [ref("15,580")] },
      { label: "Google Ads", value: [ref("$55")], group: "Paid channels" },
      { label: "Meta", value: [ref("$70")], group: "Paid channels" },
    ]);
    expect(html.match(/<section/g)).toHaveLength(2);
    expect(html.indexOf("Paid channels")).toBeLessThan(html.indexOf("Google Ads"));
    expect(html.indexOf("Acquisition")).toBeLessThan(html.indexOf("Paid channels"));
  });
});

describe("an answer's headline figures, said in full", () => {
  it("say a trend that goes below zero in numbers, since bars start at zero", () => {
    const html = draw([
      {
        label: "Net profit",
        value: [ref("-$10")],
        trend: { label: "By month", points: [point("-$100", -100, 0), point("-$50", -50, 1), point("-$10", -10, 2)] },
      },
    ]);
    for (const part of ["By month:", "-$100", "-$50", "-$10"]) expect(html).toContain(part);
    // Each point a traced number, as the card's value is.
    expect(html.match(/traced-number/g)?.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain("sparkline");
  });

  it("copy as lines, the change as its number shows it", () => {
    expect(
      figureLines([
        {
          label: "Orders",
          value: [ref("40")],
          change: { segments: [ref("-20%")], direction: "down" },
          vs: "vs last month",
        },
        { label: "Revenue", value: [ref("$1.2k")] },
      ]),
    ).toEqual(["Orders: 40 (▼ -20% vs last month)", "Revenue: $1.2k"]);
  });
});

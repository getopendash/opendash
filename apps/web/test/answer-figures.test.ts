// An answer's headline figures on the page: a card each, in a group under its heading, its value a traced number, its
// change with an arrow from its sign (the number without it), a line more, and its trend as bars (its values said to a
// screen reader).
import type { ResolvedFigure } from "@opendash/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const { AnswerFigures } = await import("../components/ask/answer-figures");

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
    for (const part of ["Activated riders", "6,727", "▲", "6.1%", "vs last week", "43%", " of trials", "sparkline"]) {
      expect(html).toContain(part);
    }
    // The arrow says the direction; the number shows without its sign.
    expect(html).not.toContain("+6.1%");
    expect(html).toContain("Last weeks: 6.0k, 6.7k");
    expect(html).toContain("traced-number");
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

// An answer's PDF: laid out as blocks with where it was answered from, the appendix of where each number comes from,
// and a real PDF from the fonts where the server build traces them (@opendash/pdf tests the drawing itself).
import type { RunOutcome } from "@opendash/core";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { answerPdfBlocks, citedQueryRuns, renderAnswerPdf } = await import("../lib/answer-pdf");

const cell = (queryRunId: string, row: number, column = "churned_mrr") => ({ alias: "q1", queryRunId, row, column });
type Answer = Extract<RunOutcome, { kind: "answer" }>;
const answer = (markdown: unknown[], caveats: unknown[][] = []): Answer =>
  ({
    kind: "answer",
    status: "answered",
    verified: true,
    markdown: "",
    rendered: "",
    interpretation: [],
    caveats: [],
    citations: [],
    values: [],
    problems: [],
    path: "unmodelled",
    segments: { markdown, caveats, interpretation: [[{ text: "September vs August 2026" }]] },
    charts: [
      {
        type: "bar",
        title: "Churned MRR by plan",
        horizontal: false,
        axis: { compact: true },
        categories: ["Starter", "Growth", "Scale"],
        series: [
          {
            name: "September",
            points: [4100, 3600, 2100].map((value, row) => ({
              value,
              display: `$${value}`,
              cell: cell("qr1", row),
            })),
          },
        ],
      },
    ],
  }) as unknown as Answer;

const names = new Map([["qr1", { alias: "q1", title: "Churned MRR by month" }]]);

describe("an answer's PDF", () => {
  it("lays the answer out: its question, its paragraphs, chips, chart and caveats, then the trace", () => {
    const a = answer(
      [
        { text: "Churned MRR fell to " },
        { ref: "q1:1:churned_mrr", display: "$9.8k", kind: "number", citations: [cell("qr1", 1)] },
        { text: ".\n\nMost of it was Starter, at " },
        { ref: "q1:0:churned_mrr", display: "$4.1k", kind: "number", citations: [cell("qr1", 0)] },
        { text: "." },
      ],
      [[{ text: "No verified definition was used." }]],
    );
    const about = {
      question: "Why did churn drop in September?",
      answeredAt: "2026-10-11T09:00:00.000Z",
      organization: "Acme",
      sourceName: "opendash_demo",
    };
    const blocks = answerPdfBlocks(a, about, names);
    expect(citedQueryRuns(a)).toEqual(["qr1"]);
    expect(blocks.map((b) => b.kind)).toEqual([
      "head",
      "title",
      "note",
      "chips",
      "paragraph",
      "paragraph",
      "chart",
      "caveat",
      "trace",
    ]);
    // Each paragraph's text, its numbers in bold as the page shows them.
    const text = (b: unknown) => (b as { runs: { text: string }[] }).runs.map((r) => r.text).join("");
    expect(blocks.filter((b) => b.kind === "paragraph").map(text)).toEqual([
      "Churned MRR fell to $9.8k.",
      "Most of it was Starter, at $4.1k.",
    ]);
    expect(blocks.at(-1)).toEqual({
      kind: "trace",
      rows: [
        { figure: "$9.8k", query: "q1 · Churned MRR by month", cell: "row 2 · churned_mrr" },
        { figure: "$4.1k", query: "q1 · Churned MRR by month", cell: "row 1 · churned_mrr" },
      ],
    });
  });

  it("draws a PDF from the fonts where the server build puts them, beyond Latin-1", async () => {
    const about = { question: "Short", answeredAt: "2026-10-11T09:00:00.000Z", organization: "Acme", sourceName: "W" };
    const bytes = await renderAnswerPdf(
      answerPdfBlocks(answer([{ text: "Growth slowed to −$10 a month → still ≥ the floor." }]), about, names),
      "Short",
    );
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe("%PDF-");
  });
});

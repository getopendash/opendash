import "server-only";
import path from "node:path";
import type { RunOutcome } from "@opendash/core";
import { answerBlocks, type Block, pdfFileName, type QueryName, renderPdf, textBlocks } from "@opendash/pdf";

export { type Block, pdfFileName, type QueryName, textBlocks };

type Answer = Extract<RunOutcome, { kind: "answer" }>;

/**
 * An answer as a PDF: @opendash/pdf draws it as it was answered, with where it came from. The fonts are the package's,
 * which the server build traces next to the app (next.config's outputFileTracingIncludes); standalone's server.js runs
 * from the app's folder, as dev does.
 */
const FONTS = path.join(process.cwd(), "../../packages/pdf/fonts");

/** The query runs an answer's numbers cite (its headline figures' and their trends' too), at most 50: their cards name them in the PDF's appendix. */
export function citedQueryRuns(answer: Answer): string[] {
  const figures = answer.figures ?? [];
  return [
    ...new Set([
      ...[
        ...(answer.segments?.markdown ?? []),
        ...(answer.segments?.caveats.flat() ?? []),
        ...(answer.segments?.interpretation.flat() ?? []),
        ...figures.flatMap((f) => [...f.value, ...(f.change?.segments ?? []), ...(f.detail ?? [])]),
      ].flatMap((s) => ("ref" in s ? s.citations.map((c) => c.queryRunId) : [])),
      ...figures.flatMap((f) => (f.trend?.points ?? []).map((p) => p.cell.queryRunId)),
    ]),
  ].slice(0, 50);
}

/** An answer's blocks, in reading order. Pure, for tests. */
export function answerPdfBlocks(
  answer: Answer,
  about: { question: string; answeredAt: string; organization: string; sourceName: string },
  names: Map<string, QueryName>,
): Block[] {
  return answerBlocks(answer, {
    organization: about.organization,
    answeredAt: about.answeredAt,
    question: about.question,
    note: `Answered from ${about.sourceName}. As it was answered: its figures don't change, and each one is listed at the end with the query cell it was read from.`,
    names,
  });
}

export const renderAnswerPdf = (blocks: Block[], title: string) =>
  renderPdf(blocks, title, FONTS, {
    // Its values went in as a table instead (a missing image renderer, say): logged, the PDF still served.
    onChartError: (error) =>
      console.error(JSON.stringify({ msg: "answer pdf: a chart drawn as a table", error: String(error) })),
  });

"use client";

import { Button } from "@heroui/react";
import type { RunOutcome } from "@opendash/core";
import { CornerDownRight, Info } from "lucide-react";
import type { ReactNode } from "react";
import { chipText } from "@/lib/readings";
import { AnswerChart } from "./answer-chart";
import { AnswerText, type TracedRef } from "./answer-text";
import { ReadingPopover } from "./reading-popover";

/** What it draws of an answer: what a public share link sends too (`PublicReport.answer`). */
type Answer = Pick<
  Extract<RunOutcome, { kind: "answer" }>,
  "status" | "verified" | "path" | "rendered" | "segments" | "charts" | "next"
> & { caveats?: string[] };

/**
 * An answer as it reads: its interpretation chips, its text, its charts and its caveats, every number traced. The
 * same in a conversation and in a report; a report passes no `onAsk`, so its chips can't be changed.
 */
export function AnswerBody({
  answer,
  question,
  inspected,
  onTrace,
  onAsk,
  chartAction,
  children,
}: {
  answer: Answer;
  question: string;
  /** The trace key shown in the Sources panel, if it's this answer's. */
  inspected: string | null;
  onTrace: (ref: TracedRef, key: string) => void;
  /** Asks again with a chip's reading changed. Absent when the reader can't add to the conversation. */
  onAsk?: (text: string) => void;
  /** What a chart offers by its label (Add to dashboard), by its index. Absent in a report. */
  chartAction?: (index: number) => ReactNode;
  /** What the run made besides (dashboards, a remembered note): between the charts and the caveats. */
  children?: ReactNode;
}) {
  const segments = answer.segments;
  const couldNot = answer.status === "cannot_answer";
  return (
    <>
      {/* The chips and the text are named for an answer landing where its draft was (`.answer-landing`). */}
      {segments?.interpretation.length ? (
        <div className="answer-body__chips">
          <div className="flex flex-wrap gap-1.5">
            {segments.interpretation.map((chip, i) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: chips are positional and never reordered
                key={i}
                className="flex items-center gap-1 rounded-lg border border-border px-2 py-0.5 text-small text-muted"
              >
                <AnswerText
                  segments={chip}
                  scope={`chip-${i}`}
                  className="text-small"
                  selected={inspected}
                  onTrace={onTrace}
                />
                {onAsk ? <ReadingPopover reading={chipText(chip)} question={question} onAsk={onAsk} /> : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="answer-body__text">
        {segments ? (
          <AnswerText
            segments={segments.markdown}
            scope="answer"
            selected={inspected}
            unverified={!answer.verified}
            onTrace={onTrace}
          />
        ) : (
          <p className="text-lead whitespace-pre-wrap">{answer.rendered}</p>
        )}
      </div>
      {answer.charts?.map((chart, i) => (
        <AnswerChart
          // biome-ignore lint/suspicious/noArrayIndexKey: an answer's charts are positional
          key={i}
          chart={chart}
          metric={answer.path === "metric"}
          onTrace={(ref) => onTrace(ref, `chart-${i}:${ref.ref}`)}
          action={chartAction?.(i)}
        />
      ))}
      {/* What it can do instead, as questions to ask (a follow-up in this conversation). */}
      {couldNot && onAsk && answer.next?.length ? (
        <div className="flex flex-col gap-1.5">
          <span className="text-small text-muted-tertiary">You could ask</span>
          <span className="flex flex-wrap gap-1.5">
            {answer.next.map((q) => (
              <Button key={q} size="sm" variant="outline" onPress={() => onAsk(q)}>
                <CornerDownRight className="size-3.5" aria-hidden />
                {q}
              </Button>
            ))}
          </span>
        </div>
      ) : null}
      {children}
      {(segments?.caveats ?? (answer.caveats ?? []).map((c) => [{ text: c }])).map((caveat, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: caveats are positional and never reordered
          key={i}
          className="flex gap-2.5 rounded-xl bg-surface-secondary px-3 py-2"
        >
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <AnswerText
            segments={caveat}
            scope={`caveat-${i}`}
            className="text-small text-muted"
            selected={inspected}
            onTrace={onTrace}
          />
        </div>
      ))}
    </>
  );
}

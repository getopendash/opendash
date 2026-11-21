"use client";

import type { AnswerSegment, ResolvedFigure } from "@opendash/core";
import { Sparkline } from "@opendash/ui";
import { AnswerText, type TracedRef } from "./answer-text";

const ARROW = { up: "▲", down: "▼", flat: "→" } as const;

/** A change's segments without its sign: the arrow says the direction, the number its size. */
const unsigned = (segments: AnswerSegment[]): AnswerSegment[] =>
  segments.map((s) => ("ref" in s ? { ...s, display: s.display.replace(/^[+\-−]\s*/, "") } : s));

/** The figures in their groups, in the order they were given (the ungrouped ones as their own group). */
function grouped(figures: ResolvedFigure[]): { name: string | null; figures: { f: ResolvedFigure; at: number }[] }[] {
  const out: { name: string | null; figures: { f: ResolvedFigure; at: number }[] }[] = [];
  figures.forEach((f, at) => {
    const name = f.group ?? null;
    const group = out.find((g) => g.name === name);
    if (group) group.figures.push({ f, at });
    else out.push({ name, figures: [{ f, at }] });
  });
  return out;
}

/**
 * An answer's headline figures, as cards above its text: each its label, its value (a traced number, pressed for its
 * cell), its change with an arrow from its sign and what it's against, a line more, and its trend as bars. A group
 * under its heading. Every number is the gate's display of a cell.
 */
export function AnswerFigures({
  figures,
  inspected,
  onTrace,
}: {
  figures: ResolvedFigure[];
  inspected: string | null;
  onTrace: (ref: TracedRef, key: string) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      {grouped(figures).map((g) => (
        <section key={g.name ?? ""} className="flex flex-col gap-1.5" aria-label={g.name ?? "Headline figures"}>
          {g.name ? <h3 className="text-small font-medium text-muted">{g.name}</h3> : null}
          <div className="answer-figures__grid">
            {g.figures.map(({ f, at }) => (
              <div key={at} className="flex flex-col gap-0.5 rounded-xl border border-border px-3 py-2.5">
                <span className="text-small text-muted">{f.label}</span>
                <span className="text-number-lg">
                  <AnswerText
                    segments={f.value}
                    scope={`figure-${at}`}
                    className="text-number-lg"
                    selected={inspected}
                    onTrace={onTrace}
                  />
                </span>
                {f.change || f.vs ? (
                  <span className="flex flex-wrap items-baseline gap-1 text-small text-muted">
                    {f.change ? (
                      <>
                        <span aria-hidden>{ARROW[f.change.direction]}</span>
                        <span className="sr-only">{f.change.direction}</span>
                        <AnswerText
                          segments={unsigned(f.change.segments)}
                          scope={`figure-${at}-change`}
                          className="text-small"
                          selected={inspected}
                          onTrace={onTrace}
                        />
                      </>
                    ) : null}
                    {f.vs ? <span className="text-muted-tertiary">{f.vs}</span> : null}
                  </span>
                ) : null}
                {f.detail?.length ? (
                  <AnswerText
                    segments={f.detail}
                    scope={`figure-${at}-detail`}
                    className="text-small text-muted"
                    selected={inspected}
                    onTrace={onTrace}
                  />
                ) : null}
                {f.trend && f.trend.points.length > 1 ? (
                  <div className="mt-1 flex items-end justify-between gap-2">
                    {f.trend.label ? <span className="text-small text-muted-tertiary">{f.trend.label}</span> : null}
                    <Sparkline values={f.trend.points.map((p) => p.value)} className="ms-auto h-6 w-20" />
                    {/* The bars are drawn for the eye; a screen reader is told their values. */}
                    <span className="sr-only">{`${f.trend.label ?? "Trend"}: ${f.trend.points.map((p) => p.display).join(", ")}`}</span>
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

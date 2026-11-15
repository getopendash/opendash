"use client";

import { ChevronDown, CircleHelp } from "lucide-react";
import { Fragment } from "react";

/** One part of a routine's sentence: plain words, or a part people choose (when, what, where). */
export interface RoutineSentencePart {
  text: string;
  role?: "when" | "what" | "where";
  /** A part still to be answered (the composer's question back): amber, with a question mark. */
  open?: boolean;
}

/**
 * A routine as one sentence: "Every Monday at 08:00, send Business review to Priya and #leadership."
 * Its chosen parts are highlighted; with `onPart` each is a button that opens its part of the composer, with a
 * chevron. `size` lg is the composer's and a routine's page; md a list row's.
 */
export function RoutineSentence({
  parts,
  size = "md",
  onPart,
}: {
  parts: RoutineSentencePart[];
  size?: "md" | "lg";
  onPart?: (index: number, part: RoutineSentencePart) => void;
}) {
  const render = (p: RoutineSentencePart, i: number) => {
    if (!p.role) return p.text;
    const tone = p.open ? "routine-sentence__part routine-sentence__part--open" : "routine-sentence__part";
    const text = p.text.trimStart();
    // Amber says it's still to pick; a screen reader hears it said.
    const toPick = p.open ? <span className="sr-only"> (to pick)</span> : null;
    if (!onPart) {
      return (
        <span className={tone}>
          {text}
          {toPick}
          {p.open ? <CircleHelp className="routine-sentence__icon size-3.5" aria-hidden /> : null}
        </span>
      );
    }
    return (
      <button type="button" className={tone} onClick={() => onPart(i, p)}>
        {text}
        {toPick}
        {p.open ? (
          <CircleHelp className="routine-sentence__icon size-3.5" aria-hidden />
        ) : (
          <ChevronDown className="routine-sentence__icon size-3.5" aria-hidden />
        )}
      </button>
    );
  };
  // A space before a part (" at once") is the sentence's: outside its highlight, and where the line may break.
  const lead = (p: RoutineSentencePart) => (p.role && p.text.startsWith(" ") ? " " : null);
  // Parts are inline text, so a long one wraps like words do and punctuation never starts a line. A part that's a
  // button is one box, so it keeps the punctuation after it beside it.
  const sticks = (p: RoutineSentencePart | undefined) => Boolean(p && !p.role && /^[.,;:]/.test(p.text));
  return (
    <p className="routine-sentence" data-size={size}>
      {parts.map((p, i) => {
        if (onPart && sticks(p) && parts[i - 1]?.role) return null;
        const tail = onPart && p.role && sticks(parts[i + 1]) ? (parts[i + 1] as RoutineSentencePart).text : null;
        // The space after it stays outside, where the line may break.
        return tail ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a part is its place in the sentence
          <Fragment key={i}>
            {lead(p)}
            <span className="routine-sentence__keep">
              {render(p, i)}
              {tail.trimEnd()}
            </span>
            {tail.endsWith(" ") ? " " : null}
          </Fragment>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: a part is its place in the sentence
          <Fragment key={i}>
            {lead(p)}
            <span>{render(p, i)}</span>
          </Fragment>
        );
      })}
    </p>
  );
}

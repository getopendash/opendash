"use client";

import { type ReactNode, useMemo } from "react";
import { draftBlocks, draftPieces } from "@/lib/answer-draft";
import { AnswerBlocks, type Leaf } from "./answer-text";

/** One text of the draft: its words, a grey pill for every number until the gate checks it, and the caret. */
const leaf: Leaf = (value, key) => {
  const out: ReactNode[] = [];
  let i = 0;
  for (const piece of draftPieces(value)) {
    const k = `${key}-${i++}`;
    if (piece.kind === "pill") {
      out.push(
        <span key={k} className="draft-pill mx-0.5 inline-block h-3.5 w-10 rounded-md bg-default align-middle" />,
      );
    } else if (piece.kind === "caret") {
      out.push(<span key={k} className="draft-caret ms-0.5" aria-hidden />);
    } else {
      piece.text.split("\n").forEach((line, n) => {
        if (n > 0) out.push(<br key={`${k}-br${i++}`} />);
        if (line) out.push(line);
      });
    }
  }
  return out;
};

/**
 * The answer while it's being written, drawn as the checked answer is (`AnswerBlocks`), every number a grey pill until
 * the gate checks it (`draftBlocks`, `draftPieces`); the checked answer then lands in its place. A draft the gate sent
 * back stays, still, until the answer lands: it isn't taken away and written again from nothing.
 */
export function AnswerDraft({ draft, held = false }: { draft: string; held?: boolean }) {
  const blocks = useMemo(() => draftBlocks(draft, !held), [draft, held]);
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      <AnswerBlocks blocks={blocks} leaf={leaf} draft />
      <p className="text-small text-muted-tertiary">
        {held
          ? "Fixing what the check found before any number is shown."
          : "Numbers appear once each one is checked against its query."}
      </p>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import { draftSegments } from "@/lib/answer-draft";

/**
 * The answer while it's being written. Plain text from `draftSegments`, every number a grey pill
 * until the gate checks it; the checked answer then replaces the whole draft.
 */
export function AnswerDraft({ draft }: { draft: string }) {
  const paragraphs = useMemo(() => draftSegments(draft), [draft]);
  return (
    <div className="flex flex-col gap-2" aria-busy="true">
      {paragraphs.map((segments, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a draft's paragraphs only grow at the end
        <p key={i} className="whitespace-pre-wrap text-lead text-foreground">
          {segments.map((s, j) =>
            s.kind === "pill" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: a paragraph's pieces only grow at the end
              <span key={j} className="draft-pill mx-0.5 inline-block h-3.5 w-10 rounded-md bg-default align-middle" />
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: as above
              <span key={j}>{s.text}</span>
            ),
          )}
          {i === paragraphs.length - 1 ? <span className="draft-caret ms-0.5" aria-hidden /> : null}
        </p>
      ))}
      <p className="text-small text-muted-tertiary">Numbers appear once each one is checked against its query.</p>
    </div>
  );
}

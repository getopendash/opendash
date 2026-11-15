/**
 * The answer's draft as it streams, made safe to show: the only path from a draft to the screen.
 * Every reference (⟦q1:0:mrr⟧), a reference still being written (an unclosed ⟦ and whatever follows), and any number
 * written outside one becomes a grey pill, so no figure shows before the gate checked it. Markdown's marks are
 * dropped: the draft is plain text, and the checked answer replaces it whole. Pure, so it's tested on its own.
 */

export type DraftSegment = { kind: "text"; text: string } | { kind: "pill" };

/**
 * A number as it could be written: a sign, a currency, digits with separators, a percent or a scale. Every run of
 * digits is one, even in a word ("3x", "Q3"): the gate checks every digit it isn't told is a date or a code, so the
 * draft hides at least as much as the gate would refuse.
 */
const NUMBER = /[-+−]?[$€£¥]?\d(?:[\d.,]*\d)?%?(?:[kKmMbB]n?(?!\p{L}))?/gu;

/** The draft's paragraphs, each as text and pills. */
export function draftSegments(draft: string): DraftSegment[][] {
  // A reference still being written: the pill stands for it, and nothing after it has arrived as text yet.
  const open = draft.lastIndexOf("⟦");
  const closed = open < 0 || draft.indexOf("⟧", open) >= 0;
  const text = closed ? draft : draft.slice(0, open);
  const paragraphs = text
    .replace(/\r/g, "")
    .split(/\n{2,}/)
    .map((p) =>
      p
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*|__|`/g, "")
        .replace(/^\s*[-*]\s+/gm, "• "),
    );
  const out = paragraphs.map((p) => {
    const segments: DraftSegment[] = [];
    const push = (s: DraftSegment) => {
      const last = segments.at(-1);
      if (s.kind === "text" && last?.kind === "text") last.text += s.text;
      else if (s.kind === "text" && !s.text) return;
      else segments.push(s);
    };
    for (const [i, piece] of p.split(/⟦[^⟦⟧]*⟧/).entries()) {
      if (i > 0) push({ kind: "pill" });
      let at = 0;
      for (const m of piece.matchAll(NUMBER)) {
        push({ kind: "text", text: piece.slice(at, m.index) });
        push({ kind: "pill" });
        at = (m.index ?? 0) + m[0].length;
      }
      push({ kind: "text", text: piece.slice(at) });
    }
    return segments;
  });
  if (!closed) {
    const last = out.at(-1);
    if (last) last.push({ kind: "pill" });
    else out.push([{ kind: "pill" }]);
  }
  return out.filter((p) => p.length);
}

import type { AnswerSegment } from "@opendash/core";

/** A reading's length at most: a phrase like "Q3 vs Q2 2026", not a new question. */
export const READING_MAX = 200;
/** What ask.submit takes. */
const QUESTION_MAX = 4000;

/** An interpretation chip as words: its text, with each figure as the answer shows it. */
export const chipText = (chip: AnswerSegment[]) => chip.map((s) => ("text" in s ? s.text : s.display)).join("");

/**
 * The question asked again with one reading changed (editing a chip re-runs the question). The change is
 * an instruction in the new turn, which outranks every default the analyst applied. Null when nothing changed.
 */
export function rereadQuestion(question: string, from: string, to: string): string | null {
  const reading = to.trim().replace(/\s+/g, " ").slice(0, READING_MAX);
  if (!reading || reading.toLowerCase() === from.trim().toLowerCase()) return null;
  const instruction = `Read “${from.trim()}” as “${reading}”.`;
  const full = `${question.trim()}\n\n${instruction}`;
  // A question near the limit isn't repeated: the conversation already holds it.
  return full.length <= QUESTION_MAX ? full : `Ask that again. ${instruction}`;
}

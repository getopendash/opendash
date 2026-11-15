/**
 * The agent's questions back to the person: 1–4 at once, each with 2–4 options, one pick or several. The
 * run ends with them, and the person's answer is their next message in the conversation. Pure, with no imports, so the
 * web's client components read it too (`@opendash/core/clarify`).
 */

export interface ClarifyQuestion {
  question: string;
  options: string[];
  /** More than one option may be picked. */
  multiple?: boolean;
}

/** How a run asked: several questions, or one, as older runs stored it. */
export type ClarifyOutcome =
  | { kind: "clarify"; questions: ClarifyQuestion[] }
  | { kind: "clarify"; question: string; options: string[] };

const texts = (v: unknown) => (Array.isArray(v) ? v.filter((o): o is string => typeof o === "string" && o !== "") : []);

/**
 * The questions of a clarify, whichever way it was written: the outcome or the tool's input, several questions or the
 * one of older runs. A question without a text or two options is left out.
 */
export function clarifyQuestions(value: unknown): ClarifyQuestion[] {
  const v = (value ?? {}) as { questions?: unknown; question?: unknown; options?: unknown };
  const raw = Array.isArray(v.questions) ? v.questions : [{ question: v.question, options: v.options }];
  return raw.flatMap((q) => {
    const r = (q ?? {}) as { question?: unknown; options?: unknown; multiple?: unknown };
    const options = texts(r.options);
    if (typeof r.question !== "string" || !r.question.trim() || options.length < 2) return [];
    return [{ question: r.question.trim(), options, ...(r.multiple === true ? { multiple: true } : {}) }];
  });
}

/** Answered by one press: a single question with one pick. */
export const onePress = (questions: ClarifyQuestion[]) => questions.length === 1 && !questions[0]?.multiple;

/** Whether every question has a pick, so the answer can be sent. */
export const answeredAll = (questions: ClarifyQuestion[], picks: number[][]) =>
  questions.every((_, i) => (picks[i] ?? []).length > 0);

/**
 * The person's answer, as their next message: what they picked, as the options say them, a line a question in the
 * questions' order. Never the questions themselves: those are the analyst's words, and the person's message is read as
 * theirs (what memory keeps, the numbers they typed). The analyst reads its own questions in its clarify call, just
 * before this message.
 */
export function clarifyAnswer(questions: ClarifyQuestion[], picks: number[][]): string {
  const chosen = (q: ClarifyQuestion, i: number) =>
    (picks[i] ?? []).flatMap((p) => (q.options[p] === undefined ? [] : [q.options[p] as string])).join(", ");
  return questions.map((q, i) => chosen(q, i)).join("\n");
}

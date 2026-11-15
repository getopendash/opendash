// The agent's questions back: several at once or the one of older runs, read the same way; answered by
// one press only for a single question with one pick; the answer as the person's next message, a line a question.
import { describe, expect, it } from "vitest";
import { answeredAll, clarifyAnswer, clarifyQuestions, onePress } from "../src/runs/clarify";

const questions = [
  { question: "Which measure?", options: ["Signups", "Accounts", "Plans"], multiple: true },
  { question: "Which window?", options: ["Last year", "Last 3 months"] },
];

describe("a clarify's questions", () => {
  it("are read the same from several questions, or the one of a run before them", () => {
    expect(clarifyQuestions({ kind: "clarify", questions })).toEqual(questions);
    expect(clarifyQuestions({ kind: "clarify", question: "Which plan?", options: ["Starter", "Growth"] })).toEqual([
      { question: "Which plan?", options: ["Starter", "Growth"] },
    ]);
    // A question without a text or two options isn't one.
    expect(
      clarifyQuestions({
        questions: [
          { question: " ", options: ["A", "B"] },
          { question: "Q", options: ["A"] },
        ],
      }),
    ).toEqual([]);
    expect(clarifyQuestions(null)).toEqual([]);
  });

  it("take one press only for a single question with one pick, and Send once each has a pick", () => {
    expect(onePress([{ question: "Which plan?", options: ["Starter", "Growth"] }])).toBe(true);
    expect(onePress([{ question: "Which?", options: ["A", "B"], multiple: true }])).toBe(false);
    expect(onePress(questions)).toBe(false);
    expect(answeredAll(questions, [[0], []])).toBe(false);
    expect(answeredAll(questions, [[0, 1], [1]])).toBe(true);
  });

  it("are answered as the person's next message: the pick itself, or a line a question", () => {
    expect(clarifyAnswer([{ question: "Which plan?", options: ["Starter", "Growth"] }], [[1]])).toBe("Growth");
    // The picks only, a line a question: the questions are the analyst's words, not the person's.
    expect(clarifyAnswer(questions, [[0, 1], [0]])).toBe("Signups, Accounts\nLast year");
  });
});

/**
 * The Investigator's ending: its write-up of an insight. It goes through the answer gate like an
 * answer, in one call: what moved is the body (its headline cross-checked when it comes from the Investigator's own
 * SQL), each reason a line of its own, each thing it couldn't check a caveat. Every figure is a reference to a cell of
 * its own queries; the gate sends problems back for repair, and the last round ships with unverified marks.
 */
import { type AnswerInput, BUDGETS, checkAnswer, finishedToolCalls } from "@opendash/core";
import { z } from "zod";
import { citable } from "./endings";
import { defineTool } from "./types";

export const investigationSchema = z.object({
  confirmed: z
    .boolean()
    .describe(
      "Counted again another way, is the change there? false when your recheck doesn't find it: the month is in line with the months before, or its data isn't complete.",
    ),
  moved: z
    .string()
    .describe(
      "What moved, in one or two sentences: the month, against the month before and what its history expected, every number a reference.",
    ),
  reasons: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "Which segment moved, by how much, and how much of the whole change that is, every number a reference.",
          ),
        weight: z.enum(["explains", "part"]).describe("explains: most of the change; part: some of it."),
      }),
    )
    .max(3)
    .describe("Most likely first, at most three. Empty when the change isn't confirmed or no segment stands out."),
  unchecked: z
    .array(z.string())
    .max(3)
    .describe("What couldn't be checked: data the source doesn't have that could explain it. Words, no numbers."),
  cross_checks: z
    .array(
      z.object({
        headline: z.string().describe("The headline cell: q1:0:new_accounts"),
        check: z.string().describe("The same number from an independent query: q2:0:accounts"),
        differs_because: z.string().optional().describe("Only when the two differ on purpose (two definitions)"),
      }),
    )
    .optional(),
});

export type InvestigationInput = z.infer<typeof investigationSchema>;

/** The write-up as the gate reads an answer: the body, the reasons as its lines, the unchecked as its caveats. */
export const asAnswer = (i: InvestigationInput): AnswerInput => ({
  status: "answered",
  markdown: i.moved,
  interpretation: i.reasons.map((r) => r.text),
  caveats: i.unchecked,
  ...(i.cross_checks?.length ? { cross_checks: i.cross_checks } : {}),
});

export const investigation = defineTool({
  name: "investigation",
  effect: "internal",
  emptyWhenMissing: ["unchecked"],
  description:
    "Your write-up of the insight, which ends the investigation. The gate checks every reference and returns problems to fix; when it passes (or after the last repair) the investigation is done.",
  schema: investigationSchema,
  async execute(input, { deps, run, definitions }) {
    const previous = (await finishedToolCalls(deps, run, "investigation")).length;
    const gate = checkAnswer(asAnswer(input), {
      results: await citable(deps, run),
      question: run.question,
      definitions,
      rowsShown: BUDGETS.agent.rowsToModel,
    });
    if (gate.passed || previous >= BUDGETS.agent.answerRepairs) {
      return {
        value: { accepted: true, verified: gate.verified, problems: gate.problems },
        summary: {
          accepted: true,
          confirmed: input.confirmed,
          verified: gate.verified,
          reasons: input.reasons.length,
          ...gate.checked,
        },
      };
    }
    return {
      value: { accepted: false, problems: gate.problems, repairsLeft: BUDGETS.agent.answerRepairs - previous },
      summary: { accepted: false, problems: gate.problems },
    };
  },
});

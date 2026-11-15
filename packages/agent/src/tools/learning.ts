/**
 * The Curator's ending: the one term it learned from people's corrections, or why there's nothing to
 * learn. It writes nothing: what it said is read from the ledger, then code validates it, keeps it as a proposed
 * version, checks it on the data, tests it, and decides whether an approver taps or the rule releases it.
 */
import { z } from "zod";
import { defineTool } from "./types";

const Table = z.string().regex(/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/, "schema.table");
const Column = z.string().regex(/^[A-Za-z_][\w]*\.[A-Za-z_][\w]*\.[A-Za-z_][\w]*$/, "schema.table.column");

export const proposeLearning = defineTool({
  name: "propose_learning",
  effect: "internal",
  description:
    "Ends your run: the one term you learned from the corrections (what the word means in the data, and what it is not), or learned: false with why there's nothing to learn. You only propose: code checks it on the data and tests it, and an approver may approve it.",
  schema: z.object({
    learned: z.boolean().describe("true: a term; false: nothing here to learn for the team"),
    term: z.string().max(80).optional().describe("The word as people use it: 'Paying accounts'"),
    means: z
      .string()
      .max(300)
      .optional()
      .describe("What it means, in one plain sentence, no figures: 'The accounts with an active subscription.'"),
    synonyms: z
      .array(z.string().max(80))
      .max(6)
      .optional()
      .describe("Other words people use for exactly this; never a wider word or a table's name"),
    column: Column.optional().describe("Where it lives in the data, schema.table.column"),
    values: z.array(z.string().max(120)).max(10).optional().describe("The values of that column it means: ['active']"),
    not: z
      .array(Table)
      .max(10)
      .optional()
      .describe("Tables it must never be read as, schema.table: the ones the corrections rule out"),
    quote: z
      .string()
      .max(400)
      .optional()
      .describe("The words of the correction you built it from, copied exactly, not reworded"),
    question: z
      .string()
      .max(200)
      .optional()
      .describe("A question a person would ask with the term, for its test: 'How many paying accounts do we have?'"),
    reason: z.string().max(300).optional().describe("With learned: false, why there's nothing to learn"),
  }),
  async execute(input) {
    if (input.learned && (!input.term || !input.means || !input.quote || !input.question)) {
      return {
        value: { error: "A term needs term, means, quote (copied from a correction) and question." },
        summary: { ended: false },
      };
    }
    return { value: { ended: true }, summary: { ended: true, learned: input.learned } };
  },
});

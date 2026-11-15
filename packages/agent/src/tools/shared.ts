import { BUDGETS, type GatewayErrorKind } from "@opendash/core";
import { z } from "zod";

const paramValue = z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(z.union([z.string(), z.number()]))]);

/** Query parameters: filter values bound by the database, never pasted into SQL. */
export const params = z
  .array(
    z.object({
      name: z.string().describe("What the value is, lowercase: country, from, to"),
      value: paramValue,
    }),
  )
  .optional()
  .describe(
    "Filter values, each with a name. How the SQL refers to them depends on the database (see its notes). Dates as 'YYYY-MM-DD'.",
  );

/** Which source a reading tool reads: another, by its name under Other sources; left out, the main one. */
export const sourceParam = z
  .string()
  .optional()
  .describe("Another source, by its name under Other sources. Leave it out for the one this conversation starts from");

/** Rows as the model sees them: objects with their index, so a reference names row and column exactly. */
export function rowsForModel(columns: { name: string }[], rows: unknown[][]) {
  return rows.slice(0, BUDGETS.agent.rowsToModel).map((row, i) => {
    const o: Record<string, unknown> = { "#": i };
    columns.forEach((c, j) => {
      if (!(c.name in o)) o[c.name] = row[j];
    });
    return o;
  });
}

/**
 * What to do after a query's error, by its kind (every tool error says the next step). The gateway's
 * message says what went wrong; this says where to go from there. Refusals already say why and what to do instead.
 */
const NEXT: Partial<Record<GatewayErrorKind, string>> = {
  unknown_table:
    "Find the table in the source's list (ls /sources/<source>/tables), and read its file before you query it.",
  undefined_table:
    "Find the table in the source's list (ls /sources/<source>/tables), and read its file before you query it.",
  undefined_column:
    "The table's file (read /sources/<source>/tables/<schema.table>.md) lists its columns: use one of those.",
  undefined_function: "That function isn't in this database: the notes on its dialect say what to use instead.",
  syntax: "Fix the SQL where the error points, and check it with sql_check before you run it.",
  type: "Compare like with like: cast the value or the column to the same type.",
  division_by_zero: "Guard the divisor: nullif(divisor, 0).",
  timeout: "Make it lighter: a shorter period, fewer columns, or aggregate before you join.",
  personal_data: "Count or filter on personal columns, never return them.",
  permission: "OpenDash can't read that here: answer with what you have, and say what you couldn't read.",
  connection: "The source isn't answering right now: answer with what you have, and say so.",
};

export const nextStep = (kind: GatewayErrorKind | undefined): string | undefined => (kind ? NEXT[kind] : undefined);

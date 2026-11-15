/**
 * The pieces of SQL the semantic compiler writes differently per database (the dialect layer): quoting, time
 * truncation and shifting, the previous row in a window, parameters and list membership. Pure: no connection, no I/O.
 *
 * Times are UTC (the org timezone comes later). A truncated time is a date: the first day of its period.
 */
export type TimeGrain = "day" | "week" | "month" | "quarter" | "year";

export const TIME_GRAINS: readonly TimeGrain[] = ["day", "week", "month", "quarter", "year"];

/** What a parameter holds, so a dialect that types its placeholders can say so. */
export type ParamKind = "string" | "number" | "boolean" | "time" | "strings" | "numbers";

export interface SqlBuilder {
  /** A quoted identifier. The compiler only passes plain names (letters, digits, underscores, dots). */
  ident(name: string): string;
  /** The first day (a date) of the period of `grain` that contains `expr`, in UTC. Weeks start on Monday. */
  truncTime(expr: string, grain: TimeGrain): string;
  /** A date `n` periods of `grain` later (earlier when negative). */
  shiftDate(expr: string, n: number, grain: TimeGrain): string;
  /** The value of `expr` in the previous row of a window, or NULL for the first row. */
  previous(expr: string, partitionBy: string[], orderBy: string): string;
  /** Where the parameter goes in the SQL, given its 1-based position and its name. */
  param(position: number, name: string, kind: ParamKind): string;
  /** `expr` is one of the values in a list parameter. */
  inList(expr: string, placeholder: string): string;
  /** A time as this dialect's parameters read it (ClickHouse's parser doesn't take ISO's T and Z). */
  timeValue(t: Date): string;
}

/** Names the compiler may quote: plain identifiers, optionally dotted (`plans.name`). */
export const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

export function plainName(name: string): string {
  if (!PLAIN_NAME.test(name)) throw new Error(`Not a plain name: ${JSON.stringify(name)}`);
  return name;
}

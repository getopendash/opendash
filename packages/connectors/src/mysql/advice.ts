/**
 * MySQL's advice: what it doesn't have that other databases do, said when a statement fails to parse
 * for it. Its parser already refuses functions it doesn't know, and the validator a FULL JOIN and a :: cast (which
 * the parser accepts and MySQL doesn't), so there's nothing to check before a run.
 */
import type { DialectAdvice } from "../dialect";

/** The forms MySQL lacks that its parser refuses, as the model's SQL writes them, and what to write instead. */
const MISSING: [RegExp, string][] = [
  [
    /\bfilter\s*\(\s*where\b/i,
    "MySQL has no FILTER (WHERE …): write sum(case when … then x else 0 end), or count(distinct case when … then x end).",
  ],
  [/\bilike\b/i, "MySQL has no ILIKE: compare lower(x) like lower(…)."],
];

/** The SQL without its quoted strings, so a value that reads like a form ('ilike me') isn't taken for one. */
const unquoted = (sql: string) => sql.replace(/'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"/g, "''");

export const mySqlAdvice: DialectAdvice = {
  check: () => ({ warnings: [] }),
  hint(error, sql) {
    if (error.kind !== "syntax") return null;
    const text = unquoted(sql);
    return MISSING.find(([form]) => form.test(text))?.[1] ?? null;
  },
  countDistinctWhere: (column, condition) => `count(distinct case when ${condition} then ${column} end)`,
};

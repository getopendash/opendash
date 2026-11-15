/**
 * ClickHouse's advice. Its merge engines keep rows that are right only once parts merge, in the
 * background, so a read that ignores that counts wrong without an error. A learned table's engine says which:
 *   - a ReplacingMergeTree read without FINAL can count a key more than once: refused, with the fix;
 *   - a Collapsing one read without summing its sign counts rows that cancel out: refused, with the fix;
 *   - a SummingMergeTree read without aggregating returns unsummed parts: a warning.
 * FINAL merges every one of them as it reads, so a table read with it is fine.
 * And a hint for the errors it's known for that other databases don't raise.
 */
import type { DialectAdvice } from "../dialect";

/** Replicated and cloud (Shared) engines behave as their base engine: SharedReplacingMergeTree → ReplacingMergeTree. */
export const baseEngine = (engine: string) => engine.replace(/^(Replicated|Shared)(?=[A-Z])/, "");

export const clickHouseAdvice: DialectAdvice = {
  check(info, tables) {
    const refuse: string[] = [];
    const warnings: string[] = [];
    for (const [i, t] of info.tables.entries()) {
      const table = tables[i];
      const engine = table?.build?.engine ? baseEngine(table.build.engine) : null;
      if (!table || !engine) continue;
      const name = `${t.schema}.${t.name}`;
      // On ClickHouse a column's qualifier is its database.table, as is each table's alias.
      const own = (qualifier: string | null) => qualifier === (t.alias ?? name);
      const aggregated = (column?: string) =>
        (info.aggregated ?? []).some((r) => own(r.qualifier) && (column === undefined || r.column === column));
      if (engine === "ReplacingMergeTree" && !t.final) {
        refuse.push(
          `${name} is a ReplacingMergeTree: a row is replaced by its newest version only when parts merge, so until then a key can repeat. Read it with FINAL to count each key once: from ${name} FINAL, or from ${name} AS t FINAL with an alias.`,
        );
      }
      // Filtering on the sign (where sign = 1) still counts rows a later -1 cancels: it has to be summed.
      const collapsing = engine === "CollapsingMergeTree" || engine === "VersionedCollapsingMergeTree";
      const sign = table.build?.engineColumns?.[0] ?? "sign";
      if (collapsing && !t.final && !aggregated(sign)) {
        refuse.push(
          `${name} is a ${engine} by ${sign}: rows cancel out in pairs (1 and -1) only when parts merge. Count it with sum(${sign}), add a measure up as sum(x * ${sign}), and keep keys with having sum(${sign}) > 0; or read it with FINAL.`,
        );
      }
      if (engine === "SummingMergeTree" && !t.final && !aggregated()) {
        warnings.push(
          `${name} is a SummingMergeTree: rows with the same key are added together only when parts merge, so read it with sum() by its key.`,
        );
      }
    }
    return refuse.length ? { refuse: refuse.join(" "), warnings } : { warnings };
  },

  hint(error, sql) {
    // FINAL goes after a table's alias; written before it, the statement doesn't parse.
    if (error.kind === "syntax" && /\bfinal\s+as\b/i.test(sql)) {
      return "FINAL comes after the table's alias in ClickHouse: from t AS x FINAL, not from t FINAL AS x.";
    }
    switch (error.code) {
      case "ILLEGAL_AGGREGATION":
        return "An aggregate can't be inside another aggregate or in WHERE: aggregate in a subquery first, then aggregate or filter its result (HAVING filters on an aggregate).";
      case "NOT_IMPLEMENTED":
        return "ClickHouse doesn't run every form other databases do, a correlated subquery most often: join a grouped subquery instead.";
      default:
        return null;
    }
  },

  countDistinctWhere: (column, condition) => `uniqExactIf(${column}, ${condition})`,
};

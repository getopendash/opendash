/**
 * Postgres's advice: dividing one integer by another rounds down (count(paid) / count(*) is 0), and
 * nothing says so. A division whose sides are both a count() or a column the catalog types as an integer gets a
 * warning with the cast. sum() is left out: it returns bigint over integers but numeric over bigints, and a warning
 * that's sometimes wrong is worse than none.
 */
import type { AdvisedTable, DialectAdvice, DivisionSide, StatementInfo } from "../dialect";

const INTEGER = /^(smallint|integer|bigint|int[248]?)$/i;

/** The table a column belongs to: by its qualifier (an alias or the table's name), or the one table that has it. */
function typeOf(
  side: { qualifier: string | null; column: string },
  info: StatementInfo,
  tables: (AdvisedTable | null)[],
) {
  const column = side.column.toLowerCase();
  const candidates = info.tables.flatMap((t, i) => {
    const table = tables[i];
    if (!table) return [];
    const named =
      side.qualifier === null || [t.alias, t.name].some((n) => n?.toLowerCase() === side.qualifier?.toLowerCase());
    return named && table.columns.has(column) ? [table.columns.get(column)?.type ?? null] : [];
  });
  return candidates.length === 1 ? candidates[0] : null;
}

const shown = (side: DivisionSide) =>
  "count" in side ? "count(…)" : side.qualifier ? `${side.qualifier}.${side.column}` : side.column;

export const postgresAdvice: DialectAdvice = {
  check(info, tables) {
    const integer = (side: DivisionSide) => "count" in side || INTEGER.test(typeOf(side, info, tables) ?? "");
    const warnings = (info.divisions ?? [])
      .filter((d) => integer(d.left) && integer(d.right))
      .map(
        (d) =>
          `${shown(d.left)} / ${shown(d.right)} divides integers, so Postgres rounds it down: cast one side first (${shown(d.left)}::numeric / ${shown(d.right)}).`,
      );
    return { warnings: [...new Set(warnings)] };
  },
  hint: () => null,
  countDistinctWhere: (column, condition) => `count(distinct ${column}) filter (where ${condition})`,
};

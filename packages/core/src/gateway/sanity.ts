/**
 * Sanity checks v0 on a query's result: zero rows, empty measures, join fan-out, a partial last period, and a
 * truncated result. They don't block anything; they go back to the agent as warnings to act on, and into the trace.
 * The gateway keeps them with the query, with one more: a value compared with a column that isn't one of its own.
 */
import type { ExecuteResult, StatementInfo } from "@opendash/connectors";
import { type CatalogIndex, type IndexedTable, resolveTable } from "./catalog-index";

export interface SanityCheck {
  /** `advice`: the database's own warning on how the SQL reads its tables. */
  check: "zero_rows" | "null_measures" | "fan_out" | "partial_period" | "truncated" | "value" | "advice";
  status: "pass" | "warn";
  message?: string;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Maps the aliases and names a statement uses to the catalog tables they mean. */
function tablesByName(info: StatementInfo, index: CatalogIndex) {
  const map = new Map<string, IndexedTable>();
  for (const t of info.tables) {
    const table = resolveTable(index, t.schema, t.name);
    if (!table) continue;
    map.set(t.name.toLowerCase(), table);
    if (t.alias) map.set(t.alias.toLowerCase(), table);
  }
  return map;
}

/** The table a column reference means: its qualifier, or the one referenced table that has the column. */
export function tableOf(
  ref: { qualifier: string | null; column: string },
  info: StatementInfo,
  index: CatalogIndex,
): IndexedTable | null {
  const byName = tablesByName(info, index);
  if (ref.qualifier) return byName.get(ref.qualifier.toLowerCase()) ?? null;
  const candidates = [...new Set(byName.values())].filter((t) => t.columns.has(ref.column.toLowerCase()));
  return candidates.length === 1 ? (candidates[0] as IndexedTable) : null;
}

export function sanityChecks(
  result: ExecuteResult,
  info: StatementInfo,
  index: CatalogIndex,
  now = new Date(),
): SanityCheck[] {
  const checks: SanityCheck[] = [];

  checks.push(
    result.rows.length === 0
      ? { check: "zero_rows", status: "warn", message: "No rows came back. Check the filters and the date range." }
      : { check: "zero_rows", status: "pass" },
  );

  const nullMeasures = result.columns
    .map((c, i) => ({ c, nulls: c.type === "number" ? result.rows.filter((r) => r[i] === null).length : 0 }))
    .filter((x) => x.nulls > 0);
  checks.push(
    nullMeasures.length
      ? {
          check: "null_measures",
          status: "warn",
          message: nullMeasures
            .map((x) => `${x.c.name} is empty (NULL) in ${x.nulls} of ${result.rows.length} rows`)
            .join("; "),
        }
      : { check: "null_measures", status: "pass" },
  );

  // Fan-out: summing or counting a table's column after joining a table that has many rows per row of it.
  const byName = tablesByName(info, index);
  const joined = [...new Set(byName.values())];
  const fanOut: string[] = [];
  for (const agg of info.aggregates) {
    if (agg.fn === "min" || agg.fn === "max") continue;
    const owner = tableOf(agg, info, index);
    if (!owner) continue;
    for (const other of joined) {
      if (other === owner) continue;
      const many = [...other.columns.values()].some(
        (c) =>
          c.references &&
          `${c.references.schema}.${c.references.table}`.toLowerCase() ===
            `${owner.schema}.${owner.name}`.toLowerCase(),
      );
      if (many) {
        fanOut.push(
          `${agg.fn}(${agg.qualifier ? `${agg.qualifier}.` : ""}${agg.column}) runs after joining ${other.schema}.${other.name}, which can have several rows per ${owner.schema}.${owner.name} row, so it may count rows more than once. Aggregate ${other.schema}.${other.name} first, or count distinct keys.`,
        );
      }
    }
  }
  checks.push(
    fanOut.length
      ? { check: "fan_out", status: "warn", message: fanOut.join(" ") }
      : { check: "fan_out", status: "pass" },
  );

  // A partial last period: a time column whose latest value falls in the current month, among several periods.
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const partial = result.columns
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c.type === "date" || c.type === "timestamp")
    .find(({ i }) => {
      const times = result.rows
        .map((r) => r[i])
        .filter((v): v is string => typeof v === "string")
        .map((v) => Date.parse(v));
      return new Set(times).size >= 2 && Math.max(...times) >= monthStart;
    });
  checks.push(
    partial
      ? {
          check: "partial_period",
          status: "warn",
          message: `The last period in ${partial.c.name} (${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}) isn't over yet, so it isn't comparable with full periods.`,
        }
      : { check: "partial_period", status: "pass" },
  );

  checks.push(
    result.truncated
      ? {
          check: "truncated",
          status: "warn",
          message: `Only the first ${result.rows.length} rows were read. Aggregate in SQL rather than reading rows.`,
        }
      : { check: "truncated", status: "pass" },
  );
  return checks;
}

// A column's values, read live from the source with a query OpenDash writes: a dashboard's column filter,
// and the lookups that replaced the value index. Nothing here is stored.
import { type DialectId, dialectFor, type QueryParam } from "@opendash/connectors";

/** At most this many values listed for a column filter (the 51st says there are more). */
export const COLUMN_VALUES_MAX = 50;
/** The longest search a column filter takes. */
export const COLUMN_SEARCH_CHARS = 100;

/**
 * The query a column's values are read with: its most common values, or those that contain a search, written by
 * OpenDash for the column's dialect. It reads `limit` rows (by default 51, so the 51st says there are more). Used by a
 * dashboard's column filter and by the live lookups that replaced the value index. Throws for a
 * column whose name isn't plain (the catalog's other names can't be quoted safely here).
 */
export function columnValuesSql(
  dialect: DialectId,
  column: string,
  search?: string,
  limit = COLUMN_VALUES_MAX + 1,
): { sql: string; params: QueryParam[] } {
  const b = dialectFor(dialect).sql;
  const parts = column.split(".");
  if (parts.length < 2) throw new Error(`Not a column: ${column}`);
  const name = b.ident(parts.at(-1) as string);
  const table = parts
    .slice(0, -1)
    .map((p) => b.ident(p))
    .join(".");
  const q = search?.trim().slice(0, COLUMN_SEARCH_CHARS);
  const like = (v: string) => `%${v.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const where = !q
    ? ""
    : dialect === "clickhouse"
      ? ` and positionCaseInsensitiveUTF8(toString(${name}), ${b.param(1, "search", "string")}) > 0`
      : dialect === "postgres"
        ? ` and ${name}::text ilike ${b.param(1, "search", "string")}`
        : ` and ${name} like ${b.param(1, "search", "string")}`;
  const params: QueryParam[] = q ? [{ name: "search", value: dialect === "clickhouse" ? q : like(q) }] : [];
  return {
    sql: `select ${name} as value, count(*) as n from ${table} where ${name} is not null${where} group by ${name} order by n desc, value limit ${Math.max(1, Math.floor(limit))}`,
    params,
  };
}

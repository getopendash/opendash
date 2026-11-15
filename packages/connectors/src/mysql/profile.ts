/**
 * Profiles one MySQL table with the shared rules (../profiling.ts), from a sample: MySQL keeps no column statistics
 * unless histograms were built, so a bounded read (the first `sampleRows` rows) backs the detectors. Row counts come
 * from the catalog's estimate, or a count when it has none.
 */
import type { Connection } from "mysql2/promise";
import type { CatalogSnapshot, RelationInfo } from "../catalog-types";
import {
  buildColumnProfile,
  type ColumnProfile,
  findJoins,
  freshnessColumns,
  isFreshnessValue,
  JOIN_CHECKS_PER_TABLE,
  newJoinChecks,
  type ProfileOptions,
  type TableProfile,
} from "../profiling";
import { qualified, quoteIdent } from "./catalog";

const rows = async <T>(conn: Connection, sql: string) => (await conn.query(sql))[0] as T[];

export async function profileRelation(
  conn: Connection,
  relation: RelationInfo,
  catalog: CatalogSnapshot,
  options: ProfileOptions,
): Promise<TableProfile> {
  const table = qualified(relation);
  const limit = Math.floor(options.sampleRows);
  // Each column as text (cut to 256 characters), aliased c0, c1, … so names can't collide.
  const select =
    relation.columns.map((c, i) => `left(cast(${quoteIdent(c.name)} as char), 256) as c${i}`).join(", ") || "1";
  const sample = await rows<Record<string, string | null>>(conn, `select ${select} from ${table} limit ${limit}`);
  const values = (i: number) => sample.map((row) => row[`c${i}`]).filter((v): v is string => typeof v === "string");

  let count = relation.analyzed ? relation.rowsEstimate : null;
  if (count === null && relation.kind === "table" && sample.length < limit) count = sample.length;
  if (count === null && relation.kind === "table") {
    const [r] = await rows<{ n: number | string }>(conn, `select count(*) as n from ${table}`).catch(() => [null]);
    count = r ? Number(r.n) : null;
  }

  const unique = new Set([
    ...(relation.primaryKey.length === 1 ? relation.primaryKey : []),
    ...relation.uniques.filter((u) => u.length === 1).map((u) => u[0] as string),
  ]);
  const declared = new Map<string, RelationInfo["foreignKeys"][number]>();
  for (const fk of relation.foreignKeys) if (fk.columns.length === 1) declared.set(fk.columns[0] as string, fk);

  const columns: Record<string, ColumnProfile> = {};
  relation.columns.forEach((column, i) => {
    columns[column.name] = buildColumnProfile({
      column,
      table: relation.name,
      raw: values(i),
      sampled: sample.length,
      rows: count,
      unique: unique.has(column.name),
      ...(declared.get(column.name) ? { foreignKey: declared.get(column.name) } : {}),
      options,
    });
  });

  // Joins nobody declared: a column named for another table, whose sampled values match that table's key.
  await findJoins({
    relation,
    catalog,
    columns,
    checks: options.joins ?? newJoinChecks(JOIN_CHECKS_PER_TABLE),
    declaredKeysUnique: true,
    unique: async (target, key) => {
      const [u] = await rows<{ d: number | string; n: number | string }>(
        conn,
        `select count(distinct ${quoteIdent(key)}) as d, count(${quoteIdent(key)}) as n from ${qualified(target)}`,
      );
      return !!u && Number(u.n) > 0 && Number(u.d) === Number(u.n);
    },
    overlap: async (column, target, key) => {
      const [o] = await rows<{ n: number | string; matched: number | string }>(
        conn,
        `select count(*) as n, count(t.k) as matched
         from (select ${quoteIdent(column.name)} as v from ${table} limit ${limit}) s
         left join (select distinct ${quoteIdent(key)} as k from ${qualified(target)}) t on t.k = s.v
         where s.v is not null`,
      );
      return { n: Number(o?.n ?? 0), matched: Number(o?.matched ?? 0) };
    },
  });

  // Freshness: the latest value of the most telling time column, never of personal data.
  let freshness: TableProfile["freshness"];
  for (const c of freshnessColumns(relation, columns)) {
    try {
      const [r] = await rows<{ max: string | null }>(
        conn,
        `select cast(max(${quoteIdent(c.name)}) as char) as max from ${table}`,
      );
      const profile = columns[c.name];
      // MySQL writes times as 'YYYY-MM-DD HH:MM:SS'; the profile keeps them as ISO, as the other dialects do.
      const max = r?.max ? (r.max.includes(" ") ? `${r.max.replace(" ", "T")}Z` : r.max) : null;
      if (max && profile) {
        profile.maxValue = max;
        if (isFreshnessValue(max) && (!freshness || max > freshness.max)) freshness = { column: c.name, max };
      }
    } catch {
      // Too slow without an index: freshness stays unknown.
    }
  }

  return { rows: count, method: "sample", sampled: sample.length, columns, freshness };
}

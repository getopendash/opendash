/**
 * Profiles one ClickHouse table with the shared rules (../profiling.ts). One aggregate pass gives nulls, distinct
 * counts and ranges (ClickHouse reads only the columns it needs, so this is cheap), a sample of `sampleRows` rows
 * backs the detectors, and the key is checked for uniqueness, since ClickHouse primary keys don't promise it.
 * If the aggregate pass is too slow, the sample stands in. The sample is the first rows read, not a random draw.
 */
import type { CatalogSnapshot, RelationInfo } from "../catalog-types";
import {
  buildColumnProfile,
  type ColumnProfile,
  type ColumnStats,
  findJoins,
  freshnessColumns,
  isFreshnessValue,
  JOIN_CHECKS_PER_TABLE,
  newJoinChecks,
  type ProfileOptions,
  type TableProfile,
} from "../profiling";
import { qualified, quoteIdent } from "./catalog";
import { type ClickHouseSession, queryRows } from "./session";

export async function profileRelation(
  session: ClickHouseSession,
  relation: RelationInfo,
  catalog: CatalogSnapshot,
  options: ProfileOptions,
): Promise<TableProfile> {
  const table = qualified(relation);
  const cols = relation.columns;
  // Each column as text (cut to 256 characters), aliased c0, c1, … so names can't collide.
  const select = cols.map((c, i) => `substring(toString(${quoteIdent(c.name)}), 1, 256) as c${i}`).join(", ") || "1";
  const sample = await queryRows<Record<string, string | null>>(
    session,
    `select ${select} from ${table} limit {n:UInt32}`,
    { params: { n: options.sampleRows } },
  );
  const values = (i: number) => sample.map((row) => row[`c${i}`]).filter((v): v is string => typeof v === "string");

  // One pass over the table: row count, nulls and distinct counts per column, ranges of numbers and times.
  let rows = relation.rowsEstimate;
  const stats = new Map<string, ColumnStats>();
  let keyUnique = false;
  const key = relation.primaryKey.length === 1 ? (relation.primaryKey[0] as string) : null;
  if (cols.length) {
    const parts = ["count() as n"];
    cols.forEach((c, i) => {
      const q = quoteIdent(c.name);
      parts.push(`countIf(isNull(${q})) as z${i}`, `uniq(${q}) as u${i}`);
      if (c.numeric || c.temporal) parts.push(`toString(min(${q})) as lo${i}`, `toString(max(${q})) as hi${i}`);
    });
    // A key is unique among its values: rows without one (NULL) join nothing, so they don't make it repeat.
    if (key) parts.push(`uniqExact(${quoteIdent(key)}) as key_distinct`, `count(${quoteIdent(key)}) as key_count`);
    try {
      const [agg] = await queryRows<Record<string, string | number | null>>(
        session,
        `select ${parts.join(", ")} from ${table}`,
      );
      if (agg) {
        const n = Number(agg.n);
        rows = n;
        cols.forEach((c, i) => {
          stats.set(c.name, {
            nullFrac: n ? Number(agg[`z${i}`]) / n : null,
            ndv: Number(agg[`u${i}`]),
            ...(agg[`lo${i}`] !== undefined && agg[`lo${i}`] !== null && n
              ? { min: String(agg[`lo${i}`]), max: String(agg[`hi${i}`]) }
              : {}),
          });
        });
        keyUnique = key !== null && Number(agg.key_count) > 0 && Number(agg.key_distinct) === Number(agg.key_count);
      }
    } catch {
      // Too slow or not allowed: the sample stands in.
      if (rows === null && sample.length < options.sampleRows) rows = sample.length;
      const keys = key === null ? [] : values(cols.findIndex((c) => c.name === key));
      keyUnique = keys.length > 0 && new Set(keys).size === keys.length;
    }
  }

  const columns: Record<string, ColumnProfile> = {};
  cols.forEach((column, i) => {
    const s = stats.get(column.name);
    columns[column.name] = buildColumnProfile({
      column,
      table: relation.name,
      raw: values(i),
      sampled: sample.length,
      rows,
      ...(s ? { stats: s } : {}),
      unique: keyUnique && column.name === key,
      options,
    });
  });

  // Joins nobody declared (ClickHouse declares none): a column named for another table or view, whose sampled values
  // match a key that's unique on the data (a ClickHouse primary key needn't be).
  const typeOf = (r: RelationInfo, name: string) => r.columns.find((c) => c.name === name)?.type ?? "";
  const bare = (type: string) => type.replace(/^LowCardinality\((.*)\)$/, "$1").replace(/^Nullable\((.*)\)$/, "$1");
  await findJoins({
    relation,
    catalog,
    columns,
    checks: options.joins ?? newJoinChecks(JOIN_CHECKS_PER_TABLE),
    declaredKeysUnique: false,
    unique: async (target, key) => {
      const [u] = await queryRows<{ d: string; n: string }>(
        session,
        `select uniqExact(${quoteIdent(key)}) as d, count(${quoteIdent(key)}) as n from ${qualified(target)}`,
      );
      return !!u && Number(u.n) > 0 && Number(u.d) === Number(u.n);
    },
    overlap: async (column, target, key) => {
      // Compared as text when the types differ (String on one side, UInt64 on the other).
      const same = bare(bare(typeOf(relation, column.name))) === bare(bare(typeOf(target, key)));
      const v = same ? quoteIdent(column.name) : `toString(${quoteIdent(column.name)})`;
      const k = same ? quoteIdent(key) : `toString(${quoteIdent(key)})`;
      // IN, not an outer join: a server with join_use_nulls = 0 (a readonly = 1 user's) fills a missing row with ''
      // or 0, which would count as matched.
      const [o] = await queryRows<{ n: string; matched: string }>(
        session,
        `select count() as n, countIf(v in (select ${k} from ${qualified(target)} where ${k} is not null)) as matched
         from (select ${v} as v from ${table} where v is not null limit {n:UInt32})`,
        { params: { n: options.sampleRows } },
      );
      return { n: Number(o?.n ?? 0), matched: Number(o?.matched ?? 0) };
    },
  });

  // Freshness: the latest value of the most telling time column; never on personal data.
  let freshness: TableProfile["freshness"];
  for (const c of freshnessColumns(relation, columns)) {
    const profile = columns[c.name];
    const max = stats.get(c.name)?.max;
    if (max && profile) {
      profile.maxValue = max;
      if (isFreshnessValue(max) && (!freshness || max > freshness.max)) freshness = { column: c.name, max };
    }
  }

  return { rows, method: stats.size ? "statistics" : "sample", sampled: sample.length, columns, freshness };
}

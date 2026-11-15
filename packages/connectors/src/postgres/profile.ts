/**
 * Profiles one Postgres table with the shared rules (../profiling.ts). Planner statistics (pg_stats) come first: they
 * cost nothing and cover analyzed tables. A small sample (at most `sampleRows` rows, by TABLESAMPLE on large tables)
 * backs the detectors and stands in when there are no statistics.
 */
import type postgres from "postgres";
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
import { type CatalogSnapshot, qualified, quoteIdent, type RelationInfo } from "./catalog";

export type { ColumnProfile, ColumnRole, ProfileOptions, Sensitivity, TableProfile } from "../profiling";

interface StatsRow {
  attname: string;
  null_frac: number;
  n_distinct: number;
  most_common_vals: string[] | null;
  most_common_freqs: number[] | null;
  histogram_bounds: string[] | null;
}

function sampleClause(r: RelationInfo, sampleRows: number) {
  if (r.kind === "view" || r.rowsEstimate === null || r.rowsEstimate <= sampleRows * 5) return `limit ${sampleRows}`;
  const pct = Math.min(100, Math.max(0.01, (100 * sampleRows * 5) / r.rowsEstimate));
  return `tablesample system (${pct.toFixed(4)}) limit ${sampleRows}`;
}

export async function profileRelation(
  sql: postgres.Sql,
  relation: RelationInfo,
  catalog: CatalogSnapshot,
  options: ProfileOptions,
): Promise<TableProfile> {
  const table = qualified(relation);
  const stats = await sql.unsafe<StatsRow[]>(
    `select attname::text, null_frac::float8, n_distinct::float8,
       most_common_vals::text::text[] as most_common_vals, most_common_freqs::float8[] as most_common_freqs,
       histogram_bounds::text::text[] as histogram_bounds
     from pg_stats where schemaname = $1 and tablename = $2`,
    [relation.schema, relation.name],
  );
  const byName = new Map(stats.map((s) => [s.attname, s]));

  // Each column as text (cut to 256 characters), aliased c0, c1, … so names can't collide.
  const select = relation.columns.map((c, i) => `left(${quoteIdent(c.name)}::text, 256) as c${i}`).join(", ") || "1";
  const sample = await sql.unsafe<Record<string, string | null>[]>(
    `select ${select} from ${table} ${sampleClause(relation, options.sampleRows)}`,
  );
  const values = (i: number) => sample.map((row) => row[`c${i}`]).filter((v): v is string => typeof v === "string");

  let rows = relation.analyzed ? relation.rowsEstimate : null;
  if (rows === null && relation.kind === "table" && sample.length < options.sampleRows) rows = sample.length;
  if (rows === null && relation.kind === "table") {
    const [count] = await sql.unsafe<{ n: number }[]>(`select count(*)::float8 as n from ${table}`).catch(() => [null]);
    rows = count?.n ?? null;
  }

  const unique = new Set([
    ...(relation.primaryKey.length === 1 ? relation.primaryKey : []),
    ...relation.uniques.filter((u) => u.length === 1).map((u) => u[0] as string),
  ]);
  const declared = new Map<string, RelationInfo["foreignKeys"][number]>();
  for (const fk of relation.foreignKeys) if (fk.columns.length === 1) declared.set(fk.columns[0] as string, fk);

  const columns: Record<string, ColumnProfile> = {};
  relation.columns.forEach((column, i) => {
    const s = byName.get(column.name);
    let stats: ColumnStats | undefined;
    if (s) {
      stats = {
        nullFrac: s.null_frac,
        ndv: s.n_distinct >= 0 ? s.n_distinct : rows !== null ? Math.round(-s.n_distinct * rows) : null,
        ...(s.most_common_vals?.length && rows !== null
          ? {
              top: s.most_common_vals
                .slice(0, 10)
                .map((value, k) => ({ value, freq: Math.round((s.most_common_freqs?.[k] ?? 0) * rows) })),
            }
          : {}),
        ...(s.histogram_bounds?.length
          ? { min: s.histogram_bounds[0] as string, max: s.histogram_bounds.at(-1) as string }
          : {}),
      };
    }
    columns[column.name] = buildColumnProfile({
      column,
      table: relation.name,
      raw: values(i),
      sampled: sample.length,
      rows,
      ...(stats ? { stats } : {}),
      unique: unique.has(column.name) || (relation.primaryKey.length === 1 && relation.primaryKey[0] === column.name),
      ...(declared.get(column.name) ? { foreignKey: declared.get(column.name) } : {}),
      options,
    });
  });

  // Joins nobody declared: a column named for another table, whose sampled values match that table's key.
  const typeOf = (r: RelationInfo, name: string) => r.columns.find((c) => c.name === name)?.type;
  await findJoins({
    relation,
    catalog,
    columns,
    checks: options.joins ?? newJoinChecks(JOIN_CHECKS_PER_TABLE),
    declaredKeysUnique: true,
    unique: async (target, key) => {
      const [u] = await sql.unsafe<{ d: number; n: number }[]>(
        `select count(distinct ${quoteIdent(key)})::float8 as d, count(${quoteIdent(key)})::float8 as n
         from ${qualified(target)}`,
      );
      return !!u && u.n > 0 && u.d === u.n;
    },
    overlap: async (column, target, key) => {
      // Compared as text when the types differ (an id kept as text on one side, a number on the other).
      const cast = typeOf(relation, column.name) === typeOf(target, key) ? "" : "::text";
      const [o] = await sql.unsafe<{ n: number; matched: number }[]>(
        `select count(*)::int as n, count(t.k)::int as matched
         from (select ${quoteIdent(column.name)}${cast} as v from ${table} ${sampleClause(relation, options.sampleRows)}) s
         left join (select distinct ${quoteIdent(key)}${cast} as k from ${qualified(target)}) t on t.k = s.v
         where s.v is not null`,
      );
      return { n: o?.n ?? 0, matched: o?.matched ?? 0 };
    },
  });

  // Freshness: the latest value of the most telling time column.
  // Never on personal data: the latest date of birth isn't freshness, and it's not ours to keep.
  const timeColumns = freshnessColumns(relation, columns);
  let freshness: TableProfile["freshness"];
  for (const c of timeColumns) {
    try {
      const [r] = await sql.unsafe<{ max: string | null }[]>(
        `select max(${quoteIdent(c.name)})::text as max from ${table}`,
      );
      const profile = columns[c.name];
      if (r?.max && profile) {
        profile.maxValue = r.max;
        if (isFreshnessValue(r.max) && (!freshness || r.max > freshness.max))
          freshness = { column: c.name, max: r.max };
      }
    } catch {
      // Too slow on a large table without an index: freshness stays unknown.
    }
  }

  return { rows, method: stats.length ? "statistics" : "sample", sampled: sample.length, columns, freshness };
}

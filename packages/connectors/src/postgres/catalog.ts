/**
 * Reads what a Postgres user can see: schemas, tables, views, columns, comments, keys and row estimates, from the
 * system catalogs only (no table scans). Objects the user can't SELECT are left out, as are partitions (their parent
 * is the table people ask about).
 */
import type postgres from "postgres";

import {
  type BuildInfo,
  type CatalogSnapshot,
  COMMENT_READ_CHARS,
  type ColumnInfo,
  type ForeignKeyInfo,
  type RelationInfo,
} from "../catalog-types";
import { withoutComments } from "./history";

export type { CatalogSnapshot, ColumnInfo, ForeignKeyInfo, RelationInfo };

const USER_SCHEMAS = `n.nspname not in ('pg_catalog', 'information_schema') and n.nspname !~ '^pg_'`;

export async function readCatalog(sql: postgres.Sql, limits: { maxRelations: number }): Promise<CatalogSnapshot> {
  const relations = await sql.unsafe<
    {
      oid: number;
      schema: string;
      name: string;
      relkind: string;
      comment: string | null;
      reltuples: number;
      analyzed: boolean;
    }[]
  >(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind::text as relkind,
       left(obj_description(c.oid, 'pg_class'), ${COMMENT_READ_CHARS}) as comment, c.reltuples::float8 as reltuples,
       (c.reltuples >= 0 and (s.last_analyze is not null or s.last_autoanalyze is not null or c.reltuples > 0)) as analyzed
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
     left join pg_stat_all_tables s on s.relid = c.oid
     where c.relkind in ('r', 'p', 'v', 'm', 'f') and not c.relispartition and ${USER_SCHEMAS}
       and has_table_privilege(c.oid, 'SELECT')
       -- An extension's own objects (pg_stat_statements' views, PostGIS's spatial_ref_sys) aren't the team's data.
       and not exists (select 1 from pg_depend d
         where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e')
     order by n.nspname, c.relname
     limit $1`,
    [limits.maxRelations + 1],
  );
  const truncated = relations.length > limits.maxRelations;
  const kept = relations.slice(0, limits.maxRelations);
  const oids = kept.map((r) => r.oid);

  const columns = oids.length
    ? await sql.unsafe<
        {
          relid: number;
          name: string;
          ordinal: number;
          type: string;
          category: string;
          enum: boolean;
          notnull: boolean;
          comment: string | null;
        }[]
      >(
        `select a.attrelid::int as relid, a.attname as name, a.attnum::int as ordinal,
           format_type(a.atttypid, a.atttypmod) as type, t.typcategory::text as category, t.typtype = 'e' as enum,
           a.attnotnull as notnull, left(col_description(a.attrelid, a.attnum), ${COMMENT_READ_CHARS}) as comment
         from pg_attribute a join pg_type t on t.oid = a.atttypid
         where a.attrelid = any($1::oid[]) and a.attnum > 0 and not a.attisdropped
         order by a.attrelid, a.attnum`,
        [oids],
      )
    : [];
  const constraints = oids.length
    ? await sql.unsafe<
        {
          relid: number;
          kind: string;
          columns: string[];
          ref_schema: string | null;
          ref_table: string | null;
          ref_columns: string[] | null;
        }[]
      >(
        `select con.conrelid::int as relid, con.contype::text as kind,
           array(select a.attname::text from unnest(con.conkey) with ordinality k(attnum, i)
                 join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum order by k.i) as columns,
           rn.nspname as ref_schema, rc.relname as ref_table,
           case when con.contype = 'f' then array(select a.attname::text from unnest(con.confkey) with ordinality k(attnum, i)
                 join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum order by k.i) end as ref_columns
         from pg_constraint con
         left join pg_class rc on rc.oid = con.confrelid
         left join pg_namespace rn on rn.oid = rc.relnamespace
         where con.conrelid = any($1::oid[]) and con.contype in ('p', 'u', 'f')`,
        [oids],
      )
    : [];

  // How each view is built: its definition as Postgres deparses it, cleaned (literals become $1, comments
  // go; one that can't be cleaned isn't kept), and the tables its rewrite rule depends on. Never fatal to the read.
  const viewOids = kept.filter((r) => r.relkind === "v" || r.relkind === "m").map((r) => r.oid);
  const builds = new Map<number, BuildInfo>();
  if (viewOids.length) {
    try {
      const defs = await sql.unsafe<{ relid: number; def: string | null }[]>(
        `select c.oid::int as relid, pg_get_viewdef(c.oid, true) as def from pg_class c where c.oid = any($1::oid[])`,
        [viewOids],
      );
      const reads = await sql.unsafe<{ relid: number; schema: string; name: string }[]>(
        `select distinct r.ev_class::int as relid, n.nspname as schema, t.relname as name
         from pg_rewrite r
         join pg_depend d on d.classid = 'pg_rewrite'::regclass and d.objid = r.oid and d.refclassid = 'pg_class'::regclass
         join pg_class t on t.oid = d.refobjid and t.oid <> r.ev_class and t.relkind in ('r', 'p', 'v', 'm', 'f')
         join pg_namespace n on n.oid = t.relnamespace
         where r.ev_class = any($1::oid[])
         order by 1, 2, 3`,
        [viewOids],
      );
      for (const d of defs) {
        const definition = d.def ? await withoutComments(d.def) : null;
        const own = reads.filter((x) => x.relid === d.relid).map((x) => ({ schema: x.schema, name: x.name }));
        builds.set(d.relid, {
          ...(definition ? { definition: definition.slice(0, 8_000) } : {}),
          ...(own.length ? { reads: own } : {}),
        });
      }
    } catch {
      // A catalog read never fails on how views are built.
    }
  }

  const schemaRows = await sql.unsafe<{ name: string; comment: string | null }[]>(
    `select n.nspname as name, left(obj_description(n.oid, 'pg_namespace'), ${COMMENT_READ_CHARS}) as comment
     from pg_namespace n where ${USER_SCHEMAS} and has_schema_privilege(n.oid, 'USAGE') order by 1`,
  );
  const used = new Set(kept.map((r) => r.schema));

  return {
    schemas: schemaRows.filter((s) => used.has(s.name)),
    truncated,
    relations: kept.map((r) => {
      const cons = constraints.filter((c) => c.relid === r.oid);
      return {
        schema: r.schema,
        name: r.name,
        kind: r.relkind === "v" || r.relkind === "m" ? "view" : "table",
        comment: r.comment,
        rowsEstimate: r.relkind === "v" || r.reltuples < 0 ? null : Math.round(r.reltuples),
        analyzed: r.analyzed,
        columns: columns
          .filter((c) => c.relid === r.oid)
          .map((c) => ({
            name: c.name,
            ordinal: c.ordinal,
            type: c.type,
            textual: c.enum || c.category === "S",
            temporal: c.category === "D",
            numeric: c.category === "N",
            nullable: !c.notnull,
            comment: c.comment,
          })),
        primaryKey: cons.find((c) => c.kind === "p")?.columns ?? [],
        uniques: cons.filter((c) => c.kind === "u").map((c) => c.columns),
        foreignKeys: cons
          .filter((c) => c.kind === "f" && c.ref_table)
          .map((c) => ({
            columns: c.columns,
            refSchema: c.ref_schema ?? "",
            refTable: c.ref_table ?? "",
            refColumns: c.ref_columns ?? [],
          })),
        ...(builds.has(r.oid) ? { build: builds.get(r.oid) as BuildInfo } : {}),
      };
    }),
  };
}

export const qualified = (r: { schema: string; name: string }) =>
  `"${r.schema.replaceAll('"', '""')}"."${r.name.replaceAll('"', '""')}"`;
export const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

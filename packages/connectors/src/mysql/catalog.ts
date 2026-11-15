/**
 * What a MySQL user can see, from information_schema only (no table scans): databases play the part of Postgres
 * schemas. information_schema shows a user only what they have some privilege on, so the catalog is what they can
 * read. MySQL declares primary keys, unique keys and foreign keys (InnoDB), so joins come from the schema itself.
 */
import type { Connection } from "mysql2/promise";
import type { BuildInfo, CatalogSnapshot, ColumnInfo, RelationInfo } from "../catalog-types";
import { SYSTEM_DATABASES } from "./probe";

const NOT_SYSTEM = (col: string) => `${col} not in (${SYSTEM_DATABASES.map((d) => `'${d}'`).join(", ")})`;

export const quoteIdent = (name: string) => `\`${name.replaceAll("`", "``")}\``;
export const qualified = (r: { schema: string; name: string }) => `${quoteIdent(r.schema)}.${quoteIdent(r.name)}`;

/** How a MySQL data type is used: text-like (value-indexed), a time, a number. */
export function classifyType(dataType: string) {
  const t = dataType.toLowerCase();
  return {
    textual: /^(char|varchar|tinytext|text|mediumtext|longtext|enum|set)$/.test(t),
    temporal: /^(date|datetime|timestamp)$/.test(t),
    numeric: /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|numeric|float|double|real|bit|year)$/.test(t),
  };
}

const rows = async <T>(conn: Connection, sql: string, values: unknown[] = []) =>
  (await conn.query(sql, values))[0] as T[];

export async function readCatalog(conn: Connection, limits: { maxRelations: number }): Promise<CatalogSnapshot> {
  const relations = await rows<{
    schema: string;
    name: string;
    type: string;
    comment: string | null;
    estimate: number | string | null;
  }>(
    conn,
    `select table_schema as \`schema\`, table_name as name, table_type as type, table_comment as comment,
       table_rows as estimate
     from information_schema.tables
     where ${NOT_SYSTEM("table_schema")} and table_type in ('BASE TABLE', 'VIEW')
     order by table_schema, table_name
     limit ?`,
    [limits.maxRelations + 1],
  );
  const truncated = relations.length > limits.maxRelations;
  const kept = relations.slice(0, limits.maxRelations);
  const schemas = [...new Set(kept.map((r) => r.schema))];
  const inSchemas = schemas.length ? schemas.map((s) => conn.escape(s)).join(", ") : "''";

  const columns = await rows<{
    schema: string;
    tbl: string;
    name: string;
    ordinal: number;
    type: string;
    dataType: string;
    nullable: string;
    comment: string | null;
  }>(
    conn,
    `select table_schema as \`schema\`, table_name as tbl, column_name as name, ordinal_position as ordinal,
       column_type as type, data_type as dataType, is_nullable as nullable, column_comment as comment
     from information_schema.columns where table_schema in (${inSchemas})
     order by table_schema, table_name, ordinal_position`,
  );
  const keys = await rows<{
    schema: string;
    tbl: string;
    constraintName: string;
    kind: string;
    column: string;
    position: number;
    refSchema: string | null;
    refTable: string | null;
    refColumn: string | null;
  }>(
    conn,
    `select k.table_schema as \`schema\`, k.table_name as tbl, k.constraint_name as constraintName,
       c.constraint_type as kind, k.column_name as \`column\`, k.ordinal_position as position,
       k.referenced_table_schema as refSchema, k.referenced_table_name as refTable, k.referenced_column_name as refColumn
     from information_schema.key_column_usage k
     join information_schema.table_constraints c
       on c.constraint_schema = k.constraint_schema and c.constraint_name = k.constraint_name
      and c.table_schema = k.table_schema and c.table_name = k.table_name
     where k.table_schema in (${inSchemas}) and c.constraint_type in ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY')
     order by k.table_schema, k.table_name, k.constraint_name, k.ordinal_position`,
  );

  const grouped = (schema: string, name: string, kind: string) => {
    const byName = new Map<string, typeof keys>();
    for (const k of keys.filter((k) => k.schema === schema && k.tbl === name && k.kind === kind)) {
      byName.set(k.constraintName, [...(byName.get(k.constraintName) ?? []), k]);
    }
    return [...byName.values()];
  };

  // How each view is built: its definition as the server's statement digest (literals as ?, comments gone;
  // MySQL 8.0.4+, and only for views the user may SHOW) and the tables it reads (8.0.13+). Older servers say nothing.
  const builds = new Map<string, BuildInfo>();
  const viewNames = kept.filter((r) => r.type === "VIEW");
  if (viewNames.length) {
    const key = (schema: string, name: string) => `${schema}\u0000${name}`;
    try {
      const defs = await rows<{ schema: string; name: string; def: string | null }>(
        conn,
        `select table_schema as \`schema\`, table_name as name,
           if(view_definition = '', null, statement_digest_text(view_definition)) as def
         from information_schema.views where ${NOT_SYSTEM("table_schema")}`,
      );
      for (const d of defs) if (d.def) builds.set(key(d.schema, d.name), { definition: d.def.slice(0, 8_000) });
    } catch {
      // No statement digests here.
    }
    try {
      const reads = await rows<{ vs: string; vn: string; schema: string; name: string }>(
        conn,
        `select view_schema as vs, view_name as vn, table_schema as \`schema\`, table_name as name
         from information_schema.view_table_usage where ${NOT_SYSTEM("view_schema")}
         order by view_schema, view_name, table_schema, table_name`,
      );
      for (const r of reads) {
        const b = builds.get(key(r.vs, r.vn)) ?? {};
        builds.set(key(r.vs, r.vn), { ...b, reads: [...(b.reads ?? []), { schema: r.schema, name: r.name }] });
      }
    } catch {
      // No view_table_usage here.
    }
    for (const r of viewNames) {
      const b = builds.get(key(r.schema, r.name));
      if (b) builds.set(`${r.schema}.${r.name}`, b);
    }
  }

  return {
    schemas: schemas.map((name) => ({ name, comment: null })),
    truncated,
    relations: kept.map((r): RelationInfo => {
      const view = r.type === "VIEW";
      const estimate = r.estimate === null ? null : Number(r.estimate);
      return {
        schema: r.schema,
        name: r.name,
        kind: view ? "view" : "table",
        comment: r.comment || null,
        rowsEstimate: view ? null : estimate,
        analyzed: !view && estimate !== null,
        columns: columns
          .filter((c) => c.schema === r.schema && c.tbl === r.name)
          .map((c): ColumnInfo => {
            const t = classifyType(c.dataType);
            return {
              name: c.name,
              ordinal: Number(c.ordinal),
              type: c.type,
              textual: t.textual,
              temporal: t.temporal,
              numeric: t.numeric,
              nullable: c.nullable === "YES",
              comment: c.comment || null,
            };
          }),
        primaryKey: (grouped(r.schema, r.name, "PRIMARY KEY")[0] ?? []).map((k) => k.column),
        uniques: grouped(r.schema, r.name, "UNIQUE").map((g) => g.map((k) => k.column)),
        foreignKeys: grouped(r.schema, r.name, "FOREIGN KEY")
          .filter((g) => g[0]?.refTable)
          .map((g) => ({
            columns: g.map((k) => k.column),
            refSchema: g[0]?.refSchema ?? r.schema,
            refTable: g[0]?.refTable ?? "",
            refColumns: g.map((k) => k.refColumn ?? ""),
          })),
        ...(builds.has(`${r.schema}.${r.name}`) ? { build: builds.get(`${r.schema}.${r.name}`) as BuildInfo } : {}),
      };
    }),
  };
}

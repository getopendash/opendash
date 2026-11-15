/**
 * What the gateway knows about a source for grounding: the tables and columns from its last sync, with each
 * column's roles, joins and value-index state. Loaded from catalog_object; never from the source itself.
 */
import type { BuildInfo } from "@opendash/connectors";
import { sql, type TenantTx } from "@opendash/db";

export interface IndexedColumn {
  id: string;
  name: string;
  type: string | null;
  sensitivity: string;
  /** Text-like (its values can be read and compared as text): from its profile, else from its type's name. */
  textual: boolean;
  roles: string[];
  references?: { schema: string; table: string; column: string };
}

export interface IndexedTable {
  id: string;
  schema: string;
  name: string;
  kind: string;
  rows: number | null;
  /**
   * Every column it has now was profiled (by a sync, or on a first read). A table that isn't, including one with a
   * column added since its profile, is profiled before it's read, so no column's values are read unchecked.
   */
  profiled: boolean;
  /** How it's built (ClickHouse's engine): what the dialect's advice checks a statement against. */
  build: BuildInfo | null;
  columns: Map<string, IndexedColumn>;
}

export interface CatalogIndex {
  tables: Map<string, IndexedTable>;
  /** The last sync hit the table cap, so a table missing here may still exist. */
  truncated: boolean;
}

export async function loadCatalogIndex(tx: TenantTx, orgId: string, connectionId: string): Promise<CatalogIndex> {
  const rows = await tx.execute<{
    table_id: string;
    schema: string;
    table: string;
    kind: string;
    table_profile: { rows?: number | null; method?: string };
    table_build: BuildInfo | null;
    column_id: string | null;
    column: string | null;
    data_type: string | null;
    sensitivity: string | null;
    profile: {
      roles?: string[];
      textual?: boolean;
      references?: { schema: string; table: string; column: string };
    } | null;
  }>(sql`
    select t.id as table_id, s.name as schema, t.name as table, t.kind, t.profile as table_profile,
           -- Its engine only (the advice's): a view's definition is kilobytes, and this row repeats per column.
           jsonb_strip_nulls(jsonb_build_object('engine', t.schema_info->'engine',
             'engineColumns', t.schema_info->'engineColumns')) as table_build,
           c.id as column_id, c.name as column, c.data_type, c.sensitivity, c.profile
    from app.catalog_object t
    join app.catalog_object s on s.org_id = t.org_id and s.id = t.parent_id
    left join app.catalog_object c on c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column' and c.removed_at is null
    where t.org_id = ${orgId} and t.connection_id = ${connectionId} and t.kind in ('table', 'view') and t.removed_at is null`);
  const tables = new Map<string, IndexedTable>();
  for (const r of rows) {
    const key = `${r.schema}.${r.table}`.toLowerCase();
    let table = tables.get(key);
    if (!table) {
      table = {
        id: r.table_id,
        schema: r.schema,
        name: r.table,
        kind: r.kind,
        rows: r.table_profile?.rows ?? null,
        profiled: Boolean(r.table_profile?.method),
        build: r.table_build && Object.keys(r.table_build).length ? r.table_build : null,
        columns: new Map(),
      };
      tables.set(key, table);
    }
    // A column without a value profile (added since the table's, or known only by name) makes the table unprofiled.
    if (r.column_id && !Array.isArray(r.profile?.roles)) table.profiled = false;
    if (r.column_id && r.column) {
      table.columns.set(r.column.toLowerCase(), {
        id: r.column_id,
        name: r.column,
        type: r.data_type,
        sensitivity: r.sensitivity ?? "none",
        textual: r.profile?.textual ?? /char|text|string|enum|uuid|json/i.test(r.data_type ?? ""),
        roles: r.profile?.roles ?? [],
        ...(r.profile?.references ? { references: r.profile.references } : {}),
      });
    }
  }
  const [last] = await tx.execute<{ truncated: boolean | null }>(sql`
    select (facts->>'truncated')::boolean as truncated from app.sync_run
    where org_id = ${orgId} and connection_id = ${connectionId} and status = 'succeeded'
    order by finished_at desc limit 1`);
  return { tables, truncated: Boolean(last?.truncated) };
}

/** Resolves a table as written in SQL: schema-qualified, or by name (public first, then a unique match). */
export function resolveTable(index: CatalogIndex, schema: string | null, name: string): IndexedTable | null {
  if (schema) return index.tables.get(`${schema}.${name}`.toLowerCase()) ?? null;
  const exact = index.tables.get(`public.${name}`.toLowerCase());
  if (exact) return exact;
  const matches = [...index.tables.values()].filter((t) => t.name.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? (matches[0] as IndexedTable) : null;
}

/** The closest names, by character-pair overlap (Dice), best first. */
export function closest(target: string, candidates: string[], limit = 3): string[] {
  const pairs = (s: string) => {
    const t = s.toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const a = pairs(target);
  return candidates
    .map((c) => {
      const b = pairs(c);
      let shared = 0;
      for (const p of a) if (b.has(p)) shared++;
      return { c, score: a.size + b.size ? (2 * shared) / (a.size + b.size) : 0 };
    })
    .filter((x) => x.score >= 0.3)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit)
    .map((x) => x.c);
}

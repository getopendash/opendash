/**
 * Reading a learned source's catalog for people (the Catalog tab), and the one thing an admin changes there: whether a
 * column is personal data. What the agent reads is built elsewhere (gateway/catalog-index, agent/catalog).
 */
import {
  type BuildInfo,
  type ColumnProfile,
  type ColumnRole,
  parseDataTime,
  type Sensitivity,
} from "@opendash/connectors";
import { isUuid, sql, type TenantTx } from "@opendash/db";
import { audit } from "../audit/write";
import { type ModelledAs, modelsByTable } from "./table-card";

export interface CatalogTreeTable {
  id: string;
  name: string;
  kind: "table" | "view";
  rows: number | null;
  columns: number;
}

export interface CatalogTreeSchema {
  id: string;
  name: string;
  tables: CatalogTreeTable[];
}

/** Schemas and their tables (no columns), in name order. Removed objects are left out. */
export async function catalogTree(tx: TenantTx, orgId: string, connectionId: string): Promise<CatalogTreeSchema[]> {
  const rows = await tx.execute<{
    id: string;
    parent_id: string | null;
    kind: "schema" | "table" | "view";
    name: string;
    rows: number | null;
    columns: number;
  }>(sql`
    select o.id, o.parent_id, o.kind, o.name, (o.profile->>'rows')::float8 as rows, coalesce(c.n, 0)::int as columns
    from app.catalog_object o
    left join (
      select parent_id, count(*) as n from app.catalog_object
      where org_id = ${orgId} and connection_id = ${connectionId} and kind = 'column' and removed_at is null
      group by parent_id
    ) c on c.parent_id = o.id
    where o.org_id = ${orgId} and o.connection_id = ${connectionId} and o.kind in ('schema', 'table', 'view')
      and o.removed_at is null
    order by o.name`);
  const schemas = new Map<string, CatalogTreeSchema>();
  for (const r of rows) if (r.kind === "schema") schemas.set(r.id, { id: r.id, name: r.name, tables: [] });
  for (const r of rows) {
    if (r.kind === "schema" || !r.parent_id) continue;
    schemas.get(r.parent_id)?.tables.push({ id: r.id, name: r.name, kind: r.kind, rows: r.rows, columns: r.columns });
  }
  return [...schemas.values()];
}

export interface CatalogColumn {
  id: string;
  name: string;
  dataType: string | null;
  nullable: boolean | null;
  comment: string | null;
  roles: ColumnRole[];
  sensitivity: Sensitivity;
  /** Why it was detected as personal or secret ("column name", "values look like email addresses"). */
  sensitivityReason: string | null;
  /** An admin set the sensitivity; later syncs keep it. */
  sensitivityByAdmin: boolean;
  nullFrac: number | null;
  /** How many distinct values it has: a stat; its values aren't kept. */
  ndv: number | null;
  references: ColumnProfile["references"] | null;
  /** Tables it partly joins (a subset), each with its share of matching values. */
  partialJoins: NonNullable<ColumnProfile["partialJoins"]>;
  /** Runs of the team's own queries that read it; 0 without a history. */
  queries: number;
}

export interface CatalogTable {
  id: string;
  schema: string;
  name: string;
  kind: "table" | "view";
  comment: string | null;
  rows: number | null;
  /** How the profile was read: the planner's statistics, or a sample. */
  method: "statistics" | "sample" | null;
  /** The table's latest data: the column it was read from, the value as stored, and as an instant when it is one. */
  freshness: { column: string; max: string; at: string | null } | null;
  primaryKey: string[];
  /** How it's built: engine, keys, what a view reads, its cleaned definition (for owners and admins). */
  build: BuildInfo | null;
  /** The datasets built over it, verified ones first. */
  models: ModelledAs[];
  /** Runs of the team's own queries that read it; 0 without a history. */
  queries: number;
  columns: CatalogColumn[];
}

/** One table of a source with its columns, in the source's order (new columns last). */
export async function catalogTable(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  tableId: string,
): Promise<CatalogTable | null> {
  if (!isUuid(tableId)) return null;
  const [t] = await tx.execute<{
    id: string;
    schema: string;
    name: string;
    kind: "table" | "view";
    comment: string | null;
    usage_score: number;
    profile: {
      rows?: number | null;
      method?: "statistics" | "sample";
      freshness?: { column: string; max: string } | null;
      primaryKey?: string[];
    };
    schema_info: BuildInfo | null;
  }>(sql`
    select t.id, s.name as schema, t.name, t.kind, t.comment, t.profile, t.usage_score, t.schema_info
    from app.catalog_object t join app.catalog_object s on s.org_id = t.org_id and s.id = t.parent_id
    where t.org_id = ${orgId} and t.connection_id = ${connectionId} and t.id = ${tableId}
      and t.kind in ('table', 'view') and t.removed_at is null`);
  if (!t) return null;
  const cols = await tx.execute<{
    id: string;
    name: string;
    data_type: string | null;
    nullable: boolean | null;
    comment: string | null;
    profile: Partial<ColumnProfile>;
    sensitivity: Sensitivity;
    sensitivity_set_by: string | null;
    usage_score: number;
  }>(sql`
    select id, name, data_type, nullable, comment, profile, sensitivity, sensitivity_set_by, usage_score
    from app.catalog_object
    where org_id = ${orgId} and parent_id = ${tableId} and kind = 'column' and removed_at is null
    order by id`);
  const datasets = await tx.execute<{
    id: string;
    ref: string;
    label: string;
    status: string;
    spec: unknown;
    tables: string[] | null;
  }>(sql`
    select i.id, i.slug as ref, i.title as label, i.status, v.spec, v.derived->'tables' as tables
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.kind = 'dataset' and i.deleted_at is null
    order by i.status = 'verified' desc, i.slug`);
  return {
    id: t.id,
    schema: t.schema,
    name: t.name,
    kind: t.kind,
    comment: t.comment,
    rows: t.profile.rows ?? null,
    method: t.profile.method ?? null,
    freshness: t.profile.freshness ? { ...t.profile.freshness, at: parseDataTime(t.profile.freshness.max) } : null,
    primaryKey: t.profile.primaryKey ?? [],
    build: t.schema_info && Object.keys(t.schema_info).length ? t.schema_info : null,
    models: modelsByTable(datasets).get(`${t.schema}.${t.name}`.toLowerCase()) ?? [],
    queries: Math.round(Number(t.usage_score)),
    columns: cols.map((c) => {
      return {
        id: c.id,
        name: c.name,
        dataType: c.data_type,
        nullable: c.nullable,
        comment: c.comment,
        roles: c.profile.roles ?? [],
        sensitivity: c.sensitivity,
        sensitivityReason: c.sensitivity_set_by ? null : (c.profile.sensitivityReason ?? null),
        sensitivityByAdmin: c.sensitivity_set_by !== null,
        nullFrac: c.profile.nullFrac ?? null,
        ndv: c.profile.ndv ?? null,
        references: c.profile.references ?? null,
        partialJoins: c.profile.partialJoins ?? [],
        queries: Math.round(Number(c.usage_score)),
      };
    }),
  };
}

/**
 * An admin marks a column as personal data, or clears the mark. The choice is kept by later syncs. Marking it
 * removes what OpenDash kept of its values at once: the value index, the profile's sample values and range, and the
 * table's freshness if it came from this column. Clearing it lets the next sync profile and index it again.
 * Secrets stay secret: clearing works on personal data only, so a detected secret can't be unmarked here.
 */
export async function setColumnSensitivity(
  tx: TenantTx,
  ctx: { orgId: string; userId: string },
  connectionId: string,
  columnId: string,
  personal: boolean,
): Promise<{ ok: true } | { ok: false; reason: "not_found" | "secret" }> {
  if (!isUuid(columnId)) return { ok: false, reason: "not_found" };
  const [c] = await tx.execute<{ sensitivity: Sensitivity; parent_id: string; name: string }>(sql`
    select sensitivity, parent_id, name from app.catalog_object
    where org_id = ${ctx.orgId} and connection_id = ${connectionId} and id = ${columnId} and kind = 'column'
      and removed_at is null
    for update`);
  if (!c) return { ok: false, reason: "not_found" };
  if (c.sensitivity === "secret") return { ok: false, reason: "secret" };
  if (personal) {
    await tx.execute(sql`
      update app.catalog_object set
        sensitivity = 'pii', sensitivity_set_by = ${ctx.userId}, profile = profile - 'top' - 'min' - 'max' - 'maxValue',
        updated_at = now()
      where org_id = ${ctx.orgId} and id = ${columnId}`);
    await tx.execute(sql`
      update app.catalog_object set profile = jsonb_set(profile, '{freshness}', 'null'::jsonb), updated_at = now()
      where org_id = ${ctx.orgId} and id = ${c.parent_id} and profile->'freshness'->>'column' = ${c.name}`);
  } else {
    await tx.execute(sql`
      update app.catalog_object set
        sensitivity = 'none', sensitivity_set_by = ${ctx.userId}, updated_at = now()
      where org_id = ${ctx.orgId} and id = ${columnId}`);
  }
  // Marking a column personal decides what the analyst may read of it: a change to the source's safety.
  await audit(tx, {
    action: "source.updated",
    actor: { type: "user", id: ctx.userId },
    target: { type: "connection", id: connectionId },
    fields: ["personal"],
    detail: { column: c.name.slice(0, 64), personal },
  });
  return { ok: true };
}

const words = (name: string) => name.replace(/_cents$/, "").replaceAll("_", " ");
/** "invoice_lines" → "invoice line": good enough for table names in a suggestion. */
const singular = (name: string) => words(name).replace(/([^s])s$/, "$1");

/**
 * Three questions to start with (an empty Ask), from what was learned: the largest tables with a time column, one
 * of their categories and one of their amounts (a total before a subtotal), naming the table. No metrics exist yet, so these are about tables, plainly worded.
 * Personal and secret columns are never used.
 */
export async function suggestedQuestions(tx: TenantTx, orgId: string, connectionId: string): Promise<string[]> {
  const rows = await tx.execute<{
    table: string;
    rows: number | null;
    fresh: string | null;
    category: string | null;
    amount: string | null;
  }>(sql`
    select t.name as table, (t.profile->>'rows')::float8 as rows, t.profile->'freshness'->>'column' as fresh,
      (select c.name from app.catalog_object c where c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column'
         and c.removed_at is null and c.sensitivity = 'none' and c.profile->'roles' ? 'category' order by c.id limit 1)
        as category,
      (select c.name from app.catalog_object c where c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column'
         and c.removed_at is null and c.sensitivity = 'none' and c.profile->'roles' ? 'amount_cents'
         order by case when c.name like 'total%' then 0 when c.name like 'amount%' then 1 else 2 end, c.id limit 1)
        as amount
    from app.catalog_object t
    where t.org_id = ${orgId} and t.connection_id = ${connectionId} and t.kind in ('table', 'view')
      and t.removed_at is null and t.profile->'freshness' ? 'column'
    order by (t.profile->>'rows')::float8 desc nulls last limit 6`);
  const out: string[] = [];
  const add = (q: string) => {
    if (out.length < 3 && !out.includes(q)) out.push(q);
  };
  for (const r of rows) {
    if (r.amount) add(`${singular(r.table)} ${words(r.amount)} by month this year`);
    else if (r.category) add(`${words(r.table)} by ${words(r.category)} last month`);
    else add(`How many ${words(r.table)} were added each month this year?`);
  }
  for (const r of rows) add(`How many ${words(r.table)} were added last month?`);
  return out.map((q) => q.charAt(0).toUpperCase() + q.slice(1));
}

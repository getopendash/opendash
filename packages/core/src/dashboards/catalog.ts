/**
 * What a dashboard can read from a source, as the data API describes it to the builder (names, columns and their
 * types, measures) and checks requests against: each dataset at the version an admin released; one not released yet at
 * its current version once its checks passed (read as unverified, and every number on it says so); and the
 * dashboard's own datasets (`withOwn`: SQL the analyst wrote, checked like Ask's). Each definition stands on its own: a
 * broken one is left out, never the rest.
 */
import { createHash } from "node:crypto";
import { type Definition, ownCatalogDataset } from "@opendash/apps/dashboard";
import type { Catalog, CatalogColumn, ColumnKind } from "@opendash/apps/protocol";
import type { DialectId } from "@opendash/connectors";
import { sql, type TenantTx } from "@opendash/db";
import {
  DatasetSpec as DatasetSchema,
  type DatasetSpec,
  MetricSpec as MetricSchema,
  type MetricSpec,
} from "../semantic/spec";

/** Names a dashboard may use: lower-case plain identifiers. */
export const PLAIN_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface CatalogEntry {
  spec: DatasetSpec;
  itemId: string;
  version: number;
  /** False for a dataset read at its current version, not released yet. */
  released: boolean;
  /** An own dataset's checked contract (its SQL, columns, types, key and links), hashed: its answers' cache scope. */
  contract?: string;
}

export interface LoadedCatalog {
  connectionId: string;
  sourceName: string;
  dialect: DialectId;
  catalog: Catalog;
  datasets: Map<string, CatalogEntry>;
  /** Metrics on its datasets, released or checked: `["metric", name]`. */
  metrics: Map<string, { spec: MetricSpec; released: boolean; itemId: string; version: number }>;
}

const KINDS: Record<DatasetSpec["columns"][number]["type"], ColumnKind> = {
  string: "text",
  boolean: "text",
  number: "number",
  time: "date",
};

/** The source's verified datasets as the data API knows them; null when the source isn't this organization's. */
export async function dashboardCatalog(
  tx: TenantTx,
  orgId: string,
  connectionId: string,
  /** A published version's pins: an unreleased definition at the version it read when published, never a later one. */
  pins: Record<string, number> = {},
): Promise<LoadedCatalog | null> {
  const pinned = JSON.stringify(pins);
  const [source] = await tx.execute<{ name: string; dialect: DialectId }>(sql`
    select name, dialect from app.connection where org_id = ${orgId} and id = ${connectionId}`);
  if (!source) return null;
  // Released first; else the version a published dashboard pinned; else the current version, once its checks are done
  // and found no failure (warnings, needs_review, are read: its numbers say Unverified; a failing or unchecked draft
  // isn't read).
  const rows = await tx.execute<{ id: string; slug: string; version: number; spec: unknown; released: boolean }>(sql`
    select i.id, i.slug, v.version, v.spec, i.released_version is not null as released
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id
      and v.version = coalesce(i.released_version, (${pinned}::jsonb ->> i.id::text)::int, i.current_version)
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.kind = 'dataset' and i.deleted_at is null
      and (i.released_version is not null or ${pinned}::jsonb ? i.id::text
        or (i.status <> 'deprecated' and v.derived->>'status' in ('passed', 'needs_review')))
    order by i.slug`);
  const catalog: Catalog = {};
  const datasets = new Map<string, CatalogEntry>();
  for (const row of rows) {
    const parsed = DatasetSchema.safeParse(row.spec);
    if (!parsed.success || !PLAIN_NAME.test(parsed.data.ref)) continue;
    const spec = parsed.data;
    const columns: Record<string, CatalogColumn> = {};
    for (const c of spec.columns) {
      if (!PLAIN_NAME.test(c.name)) continue;
      columns[c.name] = {
        kind: KINDS[c.type],
        ...(c.description ? { description: c.description } : {}),
        ...(c.type === "string" ? { search: true } : {}),
      };
    }
    if (!Object.keys(columns).length) continue;
    const key =
      spec.primary_key.length === 1 && spec.primary_key[0] && columns[spec.primary_key[0]]
        ? spec.primary_key[0]
        : undefined;
    const measures = Object.fromEntries(
      spec.measures
        .filter((m) => PLAIN_NAME.test(m.name))
        .map((m) => [m.name, { ...(m.description ? { description: m.description } : {}), format: m.format }]),
    );
    // Its links to other datasets: how a query on one joins another.
    const links = (spec.relationships ?? [])
      .filter(
        (r) =>
          PLAIN_NAME.test(r.to) && Object.entries(r.on).every(([a, b]) => PLAIN_NAME.test(a) && PLAIN_NAME.test(b)),
      )
      .map((r) => ({ to: r.to, on: { ...r.on } }));
    catalog[spec.ref] = {
      title: spec.label,
      ...(spec.description ? { description: spec.description } : {}),
      columns,
      ...(Object.keys(measures).length ? { measures } : {}),
      ...(key ? { key } : {}),
      ...(links.length ? { links } : {}),
      ...(row.released ? {} : { unverified: true as const }),
      ...(spec.snapshot ? { snapshot: { at: spec.snapshot.at } } : {}),
    };
    datasets.set(spec.ref, { spec, itemId: row.id, version: row.version, released: row.released });
  }

  // Metrics, the same way: released, or checked; each on a dataset read here.
  const metricRows = await tx.execute<{ id: string; version: number; spec: unknown; released: boolean }>(sql`
    select i.id, v.version, v.spec, i.released_version is not null as released
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id
      and v.version = coalesce(i.released_version, (${pinned}::jsonb ->> i.id::text)::int, i.current_version)
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.kind = 'metric' and i.deleted_at is null
      and (i.released_version is not null or ${pinned}::jsonb ? i.id::text
        or (i.status <> 'deprecated' and v.derived->>'status' in ('passed', 'needs_review')))
    order by i.slug`);
  const metrics = new Map<string, { spec: MetricSpec; released: boolean; itemId: string; version: number }>();
  for (const row of metricRows) {
    const parsed = MetricSchema.safeParse(row.spec);
    if (!parsed.success || !PLAIN_NAME.test(parsed.data.name)) continue;
    const m = parsed.data;
    const on = datasets.get(m.dataset);
    const described = catalog[m.dataset];
    if (!on || !described || !on.spec.measures.some((x) => x.name === m.measure)) continue;
    metrics.set(m.name, { spec: m, released: row.released, itemId: row.id, version: row.version });
    const time = m.time_column === "none" ? null : (m.time_column ?? on.spec.time_column);
    described.metrics = {
      ...(described.metrics ?? {}),
      [m.name]: {
        title: m.label,
        ...(time !== undefined ? { timeColumn: time } : {}),
        ...(m.segments.length ? { segments: [...m.segments] } : {}),
        ...(row.released && on.released ? {} : { unverified: true as const }),
      },
    };
  }
  return { connectionId, sourceName: source.name, dialect: source.dialect, catalog, datasets, metrics };
}

/**
 * What a definition reads that isn't released, at the version it reads now (by item id): pinned when it's published,
 * so a later edit to one of those drafts never changes the published version (a release by an admin still does).
 */
export function pinsOf(definition: Pick<Definition, "queries">, loaded: LoadedCatalog): Record<string, number> {
  const pins: Record<string, number> = {};
  for (const q of Object.values(definition.queries)) {
    if (q.source.connection !== loaded.connectionId) continue;
    const entry = loaded.datasets.get(q.source.dataset);
    if (entry && !entry.released && entry.itemId) pins[entry.itemId] = entry.version;
    for (const m of Object.values(q.measures ?? {})) {
      const metric = m[0] === "metric" ? loaded.metrics.get(m[1]) : undefined;
      if (metric && !metric.released) pins[metric.itemId] = metric.version;
    }
  }
  return pins;
}

/** What a definition reads that the catalog doesn't have now: a dataset, or a metric, by name. */
export function unresolved(definition: Pick<Definition, "queries">, loaded: LoadedCatalog): string[] {
  const out = new Set<string>();
  for (const q of Object.values(definition.queries)) {
    if (q.source.connection !== loaded.connectionId) continue;
    if (!loaded.datasets.has(q.source.dataset)) out.add(q.source.dataset);
    for (const m of Object.values(q.measures ?? {})) if (m[0] === "metric" && !loaded.metrics.has(m[1])) out.add(m[1]);
  }
  return [...out];
}

/** An own dataset's contract, hashed: what its answers are cached under (any change to it is a new key). */
function contractOf(ds: NonNullable<Definition["datasets"]>[string]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        "sql" in ds
          ? { sql: ds.sql, columns: ds.columns, key: ds.key ?? null, links: ds.links ?? [] }
          : { service: ds.service, rows: ds.rows ?? null, columns: ds.columns, key: ds.key ?? null },
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * The source's catalog with the dashboard's own datasets on it beside the rest (an own name, `t_…`, is the
 * dashboard's): each compiled like a dataset, its SQL in place of a released one's, and run through the same gateway.
 */
export function withOwn(loaded: LoadedCatalog, definition: Pick<Definition, "datasets">): LoadedCatalog {
  // SQL datasets on this source (a service dataset is read by service.ts, over its own snapshot).
  const own = Object.entries(definition.datasets ?? {}).flatMap(([name, ds]) =>
    "sql" in ds && ds.connection === loaded.connectionId ? [[name, ds] as const] : [],
  );
  if (!own.length) return loaded;
  const catalog: Catalog = { ...loaded.catalog };
  const datasets = new Map(loaded.datasets);
  for (const [name, ds] of own) {
    catalog[name] = ownCatalogDataset(ds);
    const spec = {
      ref: name,
      label: ds.title,
      sql: ds.sql,
      columns: ds.columns.map((c) => ({ name: c.name, type: c.type })),
      primary_key: ds.key ? [ds.key] : [],
      measures: [],
      segments: [],
      relationships: [],
    } as unknown as DatasetSpec;
    datasets.set(name, { spec, itemId: "", version: 0, released: false, contract: contractOf(ds) });
  }
  return { ...loaded, catalog, datasets };
}

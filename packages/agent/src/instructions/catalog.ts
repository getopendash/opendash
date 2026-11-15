/**
 * What the agent knows about a source before it asks anything: the learned catalog (its context pack).
 * The prompt gets a card for each learned table (how it's built, its keys and joins, the dataset over it, its
 * columns) while they fit, then the tables only known, one line each (the Modeler's view), or one line per table with
 * its detail in a file the agent reads (everyone else's).
 * The wording is the Catalog page's (core's table-card). Values shown come only from columns that are searchable now
 * (no personal data, secrets or free text), whatever an older profile holds.
 */
import type { BuildInfo } from "@opendash/connectors";
import {
  closest,
  engineHint,
  type JoinTarget,
  joinLabel,
  keysLine,
  type ModelledAs,
  modelledLine,
  modelsByTable,
  readsLine,
} from "@opendash/core";
import { sql, type TenantTx } from "@opendash/db";
import { inert } from "./context";

type ColumnRow = {
  table_id: string;
  schema: string;
  table: string;
  kind: string;
  table_comment: string | null;
  table_usage: number | null;
  table_build: BuildInfo | null;
  table_profile: {
    rows?: number | null;
    freshness?: { column: string; max: string } | null;
    primaryKey?: string[];
    method?: string;
  };
  column: string | null;
  data_type: string | null;
  nullable: boolean | null;
  comment: string | null;
  sensitivity: string | null;
  profile: {
    roles?: string[];
    top?: { value: string; freq: number }[];
    references?: { schema: string; table: string; column: string; declared?: boolean; overlap?: number };
    partialJoins?: { schema: string; table: string; column: string; overlap: number }[];
    min?: string;
    max?: string;
    nullFrac?: number | null;
    ndv?: number | null;
    temporal?: boolean;
    numeric?: boolean;
  } | null;
};

export interface CatalogColumn {
  name: string;
  type: string | null;
  nullable: boolean | null;
  comment: string | null;
  sensitivity: "none" | "pii" | "secret";
  roles: string[];
  references?: {
    schema: string;
    table: string;
    column: string;
    declared: boolean;
    /** The share of its sampled values found in the target, when checked on the data. */
    overlap?: number;
    /** Runs of the team's queries that read both sides; 0 without a history. */
    queries: number;
  };
  /** Tables it partly joins (a subset: the customers among organizations), each with its share. */
  partialJoins?: JoinTarget[];
  /** How many distinct values a category column has (a stat: its values are read live). */
  distinct?: number;
  nullFrac?: number | null;
}

export interface CatalogTable {
  schema: string;
  name: string;
  kind: string;
  comment: string | null;
  rows: number | null;
  freshness: { column: string; max: string } | null;
  primaryKey: string[];
  /** How many runs of the team's own queries read it; 0 without a history. */
  queries: number;
  /** Profiled (learned, or read once): its roles and joins are known. One that isn't is known by name. */
  profiled: boolean;
  /** How it's built: engine, keys, what a view reads, its cleaned definition. */
  build: BuildInfo | null;
  /** The datasets built over it. */
  models: ModelledAs[];
  columns: CatalogColumn[];
}

const sensitive = (s: string | null) => (s === "pii" || s === "secret" ? s : "none");

export async function loadCatalog(tx: TenantTx, orgId: string, connectionId: string): Promise<CatalogTable[]> {
  const rows = await tx.execute<ColumnRow>(sql`
    select t.id as table_id, s.name as schema, t.name as table, t.kind, t.comment as table_comment,
           t.profile as table_profile, t.usage_score as table_usage, t.schema_info as table_build,
           c.name as column, c.data_type, c.nullable, c.comment, c.sensitivity, c.profile
    from app.catalog_object t
    join app.catalog_object s on s.org_id = t.org_id and s.id = t.parent_id
    left join app.catalog_object c on c.org_id = t.org_id and c.parent_id = t.id and c.kind = 'column'
      and c.removed_at is null
    where t.org_id = ${orgId} and t.connection_id = ${connectionId} and t.kind in ('table', 'view')
      and t.removed_at is null
    -- The tables the team queries most first, so they're the ones described in full when a catalog doesn't fit.
    order by t.usage_score desc, s.name, t.name, c.created_at, c.name`);
  const tables = new Map<string, CatalogTable>();
  for (const r of rows) {
    let table = tables.get(r.table_id);
    if (!table) {
      table = {
        schema: r.schema,
        name: r.table,
        kind: r.kind,
        comment: r.table_comment,
        rows: r.table_profile?.rows ?? null,
        freshness: r.table_profile?.freshness ?? null,
        primaryKey: r.table_profile?.primaryKey ?? [],
        queries: Math.round(Number(r.table_usage ?? 0)),
        profiled: Boolean(r.table_profile?.method),
        build: r.table_build && Object.keys(r.table_build).length ? r.table_build : null,
        models: [],
        columns: [],
      };
      tables.set(r.table_id, table);
    }
    if (!r.column) continue;
    const p = r.profile ?? {};
    const sensitivity = sensitive(r.sensitivity);
    const roles = p.roles ?? [];
    const open = sensitivity === "none" && !roles.includes("free_text");
    table.columns.push({
      name: r.column,
      type: r.data_type,
      nullable: r.nullable,
      comment: r.comment,
      sensitivity,
      roles,
      ...(p.references
        ? {
            references: {
              schema: p.references.schema,
              table: p.references.table,
              column: p.references.column,
              declared: Boolean(p.references.declared),
              ...(p.references.overlap !== undefined && !p.references.declared
                ? { overlap: p.references.overlap }
                : {}),
              queries: 0,
            },
          }
        : {}),
      ...(p.partialJoins?.length ? { partialJoins: p.partialJoins } : {}),
      ...(open && roles.includes("category") && p.ndv ? { distinct: Math.round(p.ndv) } : {}),
      nullFrac: p.nullFrac ?? null,
    });
  }
  await countJoins(tx, orgId, connectionId, [...tables.values()]);
  await attachModels(tx, orgId, connectionId, [...tables.values()]);
  return [...tables.values()];
}

/** The verified datasets built over each table (the analyst trusts only those), from their latest check. */
async function attachModels(tx: TenantTx, orgId: string, connectionId: string, tables: CatalogTable[]) {
  const datasets = await tx.execute<{
    ref: string;
    label: string;
    status: string;
    spec: unknown;
    tables: string[] | null;
  }>(sql`
    select i.slug as ref, i.title as label, i.status, v.spec, v.derived->'tables' as tables
    from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.kind = 'dataset'
      and i.status = 'verified' and i.deleted_at is null
    order by i.slug`);
  const byTable = modelsByTable(datasets);
  for (const t of tables) t.models = byTable.get(`${t.schema}.${t.name}`.toLowerCase()) ?? [];
}

/** How often the team's queries read both sides of each known join, from the source's patterns (at most 500). */
async function countJoins(tx: TenantTx, orgId: string, connectionId: string, tables: CatalogTable[]) {
  const patterns = await tx.execute<{ tables: string[]; calls: string }>(sql`
    select tables, calls::text from app.query_pattern where org_id = ${orgId} and connection_id = ${connectionId}`);
  if (!patterns.length) return;
  const read = patterns.map((p) => ({ tables: new Set(p.tables), calls: Number(p.calls) }));
  for (const t of tables) {
    const from = `${t.schema}.${t.name}`.toLowerCase();
    for (const c of t.columns) {
      if (!c.references) continue;
      const to = `${c.references.schema}.${c.references.table}`.toLowerCase();
      c.references.queries = read.reduce((n, p) => (p.tables.has(from) && p.tables.has(to) ? n + p.calls : n), 0);
    }
  }
}

const ROLE_NOTES: Record<string, string> = {
  key: "key",
  time: "time",
  amount_cents: "amount in cents",
  category: "category",
  free_text: "free text",
};

function columnLine(c: CatalogColumn): string {
  const notes: string[] = [];
  for (const role of c.roles) {
    const note = ROLE_NOTES[role];
    if (note)
      notes.push(role === "category" && c.distinct ? `${note} (${c.distinct.toLocaleString("en-US")} distinct)` : note);
  }
  if (c.references) {
    const used = c.references.queries
      ? `read together in ${c.references.queries.toLocaleString("en-US")} of the team's query runs`
      : undefined;
    notes.push(joinLabel(c.references, false, used));
  }
  for (const p of c.partialJoins ?? []) notes.push(joinLabel(p, true));
  if (c.sensitivity === "pii") notes.push("personal data: count or filter only");
  if (c.sensitivity === "secret") notes.push("secret: never read");
  if (c.comment) notes.push(`"${c.comment.length > 120 ? `${c.comment.slice(0, 119)}…` : c.comment}"`);
  return `  ${c.name} ${c.type ?? "?"}${notes.length ? ` · ${notes.join(" · ")}` : ""}`;
}

function tableHeader(t: CatalogTable): string {
  const facts: string[] = [];
  if (t.kind === "view") facts.push("view");
  if (t.rows !== null) facts.push(`about ${t.rows.toLocaleString("en-US")} rows`);
  if (t.freshness) facts.push(`latest ${t.freshness.column} ${t.freshness.max.slice(0, 10)}`);
  if (t.queries > 0) facts.push(`read by ${t.queries.toLocaleString("en-US")} of the team's query runs`);
  const comment = t.comment ? ` · "${t.comment.slice(0, 160)}"` : "";
  return `${t.schema}.${t.name}${facts.length ? ` (${facts.join(", ")})` : ""}${comment}`;
}

/** What a card says about how the table is built and modelled, before its columns. */
function cardLines(t: CatalogTable): string[] {
  return [
    engineHint(t.build),
    keysLine(t.build, t.primaryKey),
    readsLine(t.build),
    ...t.models.map(modelledLine),
  ].flatMap((line) => (line ? [`  ${line}`] : []));
}

/** A table known, not learned: one line. */
function knownLine(t: CatalogTable): string {
  const facts: string[] = [];
  if (t.kind === "view") facts.push("view");
  if (t.build?.engine && t.build.engine !== "View") facts.push(t.build.engine);
  if (t.rows !== null) facts.push(`about ${t.rows.toLocaleString("en-US")} rows`);
  if (t.queries > 0) facts.push(`read by ${t.queries.toLocaleString("en-US")} of the team's query runs`);
  return `${t.schema}.${t.name}${facts.length ? ` (${facts.join(", ")})` : ""}`;
}

/**
 * The catalog block of the prompt: a card for each learned table (and each read once) while they fit, then the
 * tables only known, one line each, then the names of any left over.
 */
export function catalogForPrompt(tables: CatalogTable[], budgetChars = 100_000): string {
  const blocks: string[] = [];
  let used = 0;
  const rest: string[] = [];
  const known: string[] = [];
  for (const t of tables) {
    if (!t.profiled) {
      known.push(knownLine(t));
      continue;
    }
    const block = [tableHeader(t), ...cardLines(t), ...t.columns.map(columnLine)].join("\n");
    if (used + block.length > budgetChars) {
      rest.push(`${t.schema}.${t.name}`);
      continue;
    }
    blocks.push(block);
    used += block.length + 2;
  }
  if (known.length) {
    const lines: string[] = [];
    for (const line of known) {
      if (used + line.length > budgetChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    rest.push(...known.slice(lines.length).map((l) => l.split(" ")[0] as string));
    blocks.push(
      [
        "Known, not learned yet (its file gives a table's columns; its first query checks it for personal data):",
        ...lines,
      ].join("\n"),
    );
  }
  if (rest.length) {
    blocks.push(`More tables (their files give their columns): ${rest.join(", ")}`);
  }
  // Names and comments come from the source's own database: data, which can't close this fence or open another.
  return `<context source="catalog" trust="data">\n${inert(blocks.join("\n\n"))}\n</context>`;
}

/** A table's card as text, in the prompt's wording: what grep reads through. */
export const tableText = (t: CatalogTable): string =>
  [tableHeader(t), ...cardLines(t), ...t.columns.map(columnLine)].join("\n");

/** A table in one line: its name, what it is, how big, how read, and the start of its comment. */
export function indexLine(t: CatalogTable): string {
  const facts: string[] = [];
  if (t.kind === "view") facts.push("view");
  if (t.build?.engine && t.build.engine !== "View") facts.push(t.build.engine);
  if (t.rows !== null) facts.push(`about ${t.rows.toLocaleString("en-US")} rows`);
  if (t.queries > 0) facts.push(`read by ${t.queries.toLocaleString("en-US")} of the team's query runs`);
  if (!t.profiled) facts.push("not learned yet");
  const comment = t.comment ? ` · "${t.comment.length > 80 ? `${t.comment.slice(0, 79)}…` : t.comment}"` : "";
  return `${t.schema}.${t.name}${facts.length ? ` (${facts.join(", ")})` : ""}${comment}`;
}

/** The tables most read first: by the team's query runs, then learned before known, then by rows. */
export const byUse = (tables: CatalogTable[]): CatalogTable[] =>
  [...tables].sort(
    (a, b) =>
      b.queries - a.queries ||
      Number(b.profiled) - Number(a.profiled) ||
      (b.rows ?? -1) - (a.rows ?? -1) ||
      `${a.schema}.${a.name}`.localeCompare(`${b.schema}.${b.name}`),
  );

/**
 * A source as a folder's name in the knowledge folder: its name, with a slash written %2F (and a percent
 * sign %25), so it stays one part of a path and no two names give the same folder (names are unique in any case).
 * apps/web's run-steps reads it the same way.
 */
export const folderOf = (name: string) => name.trim().replace(/%/g, "%25").replace(/\//g, "%2F");

/** Where a source's tables are in the knowledge folder, as the prompt names it. */
export const tablesFolder = (name: string) => `/sources/${folderOf(name)}/tables`;

/** How much of the prompt the tables' index may take, in characters (about 3k tokens). */
export const TABLES_INDEX_CHARS = 8_000;

/**
 * The tables in the prompt: one line each, the most read first, while they fit; the rest are counted, and
 * `ls` lists them all. A table's detail is a file the agent reads (`folder`/<schema.table>.md).
 */
export function tablesForPrompt(tables: CatalogTable[], folder: string, budgetChars = TABLES_INDEX_CHARS): string {
  const lines: string[] = [];
  let used = 0;
  for (const t of byUse(tables)) {
    const line = indexLine(t);
    if (used + line.length + 1 > budgetChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  const more = tables.length - lines.length;
  if (more) lines.push(`…and ${more.toLocaleString("en-US")} more: ls ${folder} lists them all.`);
  if (!tables.length) lines.push("No tables learned yet.");
  // Names and comments come from the source's own database: data, which can't close this fence or open another.
  return `<context source="catalog" trust="data">\n${inert(lines.join("\n"))}\n</context>`;
}

/** The table a name means: schema-qualified, or a name only one schema has. */
export function findTable(tables: CatalogTable[], name: string): CatalogTable | undefined {
  const wanted = name.trim().toLowerCase();
  return (
    tables.find((t) => `${t.schema}.${t.name}`.toLowerCase() === wanted) ??
    (() => {
      const matches = tables.filter((t) => t.name.toLowerCase() === wanted);
      return matches.length === 1 ? matches[0] : undefined;
    })()
  );
}

/** A table's columns whose values its file reads live: categories that aren't personal, secret or free text. */
export const describedColumns = (t: CatalogTable): string[] =>
  t.columns
    .filter((c) => c.sensitivity === "none" && c.roles.includes("category") && !c.roles.includes("free_text"))
    .map((c) => `${t.schema}.${t.name}.${c.name}`);

/**
 * One table in detail, as its file in the knowledge folder gives it, or the closest names when it isn't one. `values`
 * are its category columns' most common values, read live when it's read, by column name.
 */
export function describeTable(tables: CatalogTable[], name: string, values: Record<string, string[]> = {}) {
  const wanted = name.trim().toLowerCase();
  const hit = findTable(tables, name);
  if (!hit) {
    return {
      error: `${name} isn't a table in this source.`,
      suggestions: closest(
        wanted,
        tables.map((t) => `${t.schema}.${t.name}`),
      ),
    };
  }
  const engine = engineHint(hit.build);
  const keys = keysLine(hit.build, hit.primaryKey);
  return {
    table: `${hit.schema}.${hit.name}`,
    kind: hit.kind,
    learned: hit.profiled,
    comment: hit.comment === null ? null : inert(hit.comment),
    rows: hit.rows,
    freshness: hit.freshness,
    primaryKey: hit.primaryKey,
    ...(hit.queries ? { teamQueryRuns: hit.queries } : {}),
    ...(engine ? { engine } : {}),
    ...(keys ? { keys } : {}),
    ...(hit.build?.reads?.length ? { reads: hit.build.reads.map((r) => `${r.schema}.${r.name}`) } : {}),
    // A view's query, cleaned: its literals are placeholders and its comments are gone.
    ...(hit.build?.definition ? { definition: inert(hit.build.definition) } : {}),
    ...(hit.models.length ? { modelledAs: hit.models.map(modelledLine) } : {}),
    columns: hit.columns.map((c) => ({
      name: c.name,
      type: c.type,
      nullable: c.nullable,
      roles: c.roles,
      ...(c.comment ? { comment: inert(c.comment) } : {}),
      ...(c.references
        ? {
            joins: `${c.references.schema}.${c.references.table}.${c.references.column}`,
            declared: c.references.declared,
            ...(c.references.overlap !== undefined
              ? { valuesMatching: Math.round(c.references.overlap * 100) / 100 }
              : {}),
            ...(c.references.queries ? { teamQueryRunsTogether: c.references.queries } : {}),
          }
        : {}),
      ...(c.sensitivity !== "none"
        ? { note: c.sensitivity === "pii" ? "personal data: count or filter only" : "secret: never read" }
        : {}),
      ...(c.partialJoins?.length ? { partlyJoins: c.partialJoins.map((p) => joinLabel(p, true)) } : {}),
      ...(c.distinct ? { distinct: c.distinct } : {}),
      ...(values[`${hit.schema}.${hit.name}.${c.name}`]?.length
        ? { commonValues: values[`${hit.schema}.${hit.name}.${c.name}`] }
        : {}),
      ...(c.nullFrac ? { nullShare: Math.round(c.nullFrac * 1000) / 1000 } : {}),
    })),
    // Tables that point at this one: what it joins to from the other side.
    referencedBy: tables.flatMap((t) =>
      t.columns
        .filter((c) => c.references && `${c.references.schema}.${c.references.table}` === `${hit.schema}.${hit.name}`)
        .map((c) => `${t.schema}.${t.name}.${c.name} → ${c.references?.column}`),
    ),
  };
}

/**
 * The sources a run can read: the one its question starts from, and the organization's other askable ones,
 * each loaded when a tool first names it and kept for the attempt. Sample data stays apart: a conversation on a
 * sample source reads other samples only, and one on real data reads real data only.
 */
import { dialectFor } from "@opendash/connectors";
import { askableSources, type ClaimedRun, loadSemanticModel } from "@opendash/core";
import { sql } from "@opendash/db";
import type { AgentDeps } from "../harness/deps";
import { loadCatalog, tablesFolder } from "../instructions/catalog";
import { inert } from "../instructions/context";
import type { RunSource } from "./types";

/** Another source, as the prompt's directory names it. */
export interface OtherSource {
  id: string;
  name: string;
  dialect: string;
}

export interface SourceRegistry {
  main: RunSource;
  /** The other sources it can read, by name. */
  others: OtherSource[];
  /** The source a tool call names (none: the main one), loaded once; null when it has none of that name. */
  pick(name?: string | null): Promise<RunSource | null>;
}

/** One source as the analyst reads it: its catalog, dialect and verified definitions. */
export async function loadSourceById(deps: AgentDeps, orgId: string, connectionId: string): Promise<RunSource> {
  return deps.withTenant(orgId, async (tx) => {
    const [c] = await tx.execute<{ name: string; dialect: string }>(sql`
      select name, dialect from app.connection where org_id = ${orgId} and id = ${connectionId}`);
    const tables = await loadCatalog(tx, orgId, connectionId);
    const semantic = await loadSemanticModel(tx, orgId, connectionId);
    return { connectionId, name: c?.name ?? "source", dialect: dialectFor(c?.dialect ?? "postgres"), tables, semantic };
  });
}

/** The run's sources: its own, loaded now, and the others it may read, loaded when first named. */
export async function sourceRegistry(deps: AgentDeps, run: ClaimedRun): Promise<SourceRegistry> {
  const main = await loadSourceById(deps, run.orgId, run.connectionId);
  const askable = await deps.withTenant(run.orgId, (tx) => askableSources(tx, run.orgId));
  const sample = askable.find((s) => s.id === run.connectionId)?.sample ?? false;
  const others = askable
    .filter((s) => s.id !== run.connectionId && s.sample === sample)
    .map((s) => ({ id: s.id, name: s.name, dialect: s.dialect }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const loaded = new Map<string, Promise<RunSource>>();
  return {
    main,
    others,
    async pick(name) {
      const wanted = name?.trim().toLowerCase();
      if (!wanted || wanted === main.name.toLowerCase()) return main;
      const other = others.find((o) => o.name.toLowerCase() === wanted);
      if (!other) return null;
      let source = loaded.get(other.id);
      if (!source) {
        source = loadSourceById(deps, run.orgId, other.id);
        loaded.set(other.id, source);
      }
      return source;
    },
  };
}

/** A registry of one: background agents read the source their work is about, and nothing else. */
export const onlySource = (main: RunSource): SourceRegistry => ({
  main,
  others: [],
  pick: async (name) => (!name?.trim() || name.trim().toLowerCase() === main.name.toLowerCase() ? main : null),
});

/** What a tool says when it's given a source the run can't read. */
export const unknownSource = (name: string, sources: SourceRegistry) => ({
  value: {
    error: `There's no source called "${name}" here. Sources: ${[sources.main.name, ...sources.others.map((o) => o.name)].join(", ")}.`,
  },
  summary: { failed: true, message: `No source called ${name}` },
});

/** How many other sources the prompt lists, and how long the list can be. */
export const OTHER_SOURCES_MAX = 8;
export const DIRECTORY_MAX = 10_000;

/** What the directory says of a source: its learned tables and verified metrics by name, and how many it knows. */
export interface SourceSummary {
  name: string;
  dialect: string;
  metrics: string[];
  learned: string[];
  known: number;
}

/**
 * The other sources' summaries, read cheaply in two queries (names only): a source whose catalog is huge, or whose
 * definitions don't hold together, can't fail a question that never reads it. Each loads in full only when named.
 */
export async function summarizeSources(
  deps: AgentDeps,
  orgId: string,
  others: OtherSource[],
): Promise<SourceSummary[]> {
  if (!others.length) return [];
  const ids = sql.join(
    others.map((o) => sql`${o.id}::uuid`),
    sql`, `,
  );
  const [tables, metrics] = await deps.withTenant(orgId, async (tx) => [
    await tx.execute<{ connection_id: string; fq: string; learned: boolean }>(sql`
      select t.connection_id, s.name || '.' || t.name as fq, (t.profile->>'method') is not null as learned
      from app.catalog_object t
      join app.catalog_object s on s.org_id = t.org_id and s.id = t.parent_id
      where t.org_id = ${orgId} and t.connection_id in (${ids}) and t.kind in ('table', 'view') and t.removed_at is null`),
    await tx.execute<{ connection_id: string; slug: string }>(sql`
      select connection_id, slug from app.context_item
      where org_id = ${orgId} and connection_id in (${ids}) and kind = 'metric' and deleted_at is null
        and released_version is not null`),
  ]);
  return others.map((o) => {
    const mine = (tables as { connection_id: string; fq: string; learned: boolean }[]).filter(
      (t) => t.connection_id === o.id,
    );
    return {
      name: o.name,
      dialect: dialectFor(o.dialect).name,
      metrics: (metrics as { connection_id: string; slug: string }[])
        .filter((m) => m.connection_id === o.id)
        .map((m) => m.slug)
        .sort(),
      learned: mine
        .filter((t) => t.learned)
        .map((t) => t.fq)
        .sort(),
      known: mine.filter((t) => !t.learned).length,
    };
  });
}

/**
 * The prompt's Other sources: each source's name, dialect, verified metrics and learned tables, by name, in
 * a stable order, fenced as data. The analyst reads a table's file under the source's folder when it needs one.
 */
export function directoryForPrompt(sources: SourceSummary[]): string {
  const lines: string[] = [];
  let size = 0;
  for (const [i, s] of sources.entries()) {
    const shown = s.learned.slice(0, 40);
    const line = [
      `- ${s.name} (${s.dialect}, ${tablesFolder(s.name).replace(/\/tables$/, "/")}):`,
      s.metrics.length ? `verified metrics ${s.metrics.join(", ")}.` : "no verified metrics.",
      shown.length
        ? `Learned tables: ${shown.join(", ")}${s.learned.length > shown.length ? `, and ${s.learned.length - shown.length} more` : ""}.`
        : "No learned tables yet.",
      s.known ? `${s.known} more known by name.` : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (size + line.length > DIRECTORY_MAX) {
      lines.push(`- and ${sources.length - i} more: name one as source to read it.`);
      break;
    }
    lines.push(line);
    size += line.length + 1;
  }
  return lines.length ? `<context source="other sources" trust="data">\n${inert(lines.join("\n"))}\n</context>` : "";
}

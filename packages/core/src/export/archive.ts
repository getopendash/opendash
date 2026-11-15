/**
 * A data export as a zip, made as it's downloaded: one file per table (`<table>.ndjson`, a row a line), read a page
 * at a time, each page in a short tenant transaction of its own (never one held for the whole download), under row
 * security, so whatever the conditions in tables.ts say, a row of another organization can't be in it.
 *
 * `exportArchive` yields the zip's bytes; the web app streams them. Files given as `extra` (the members, an account's
 * profile: what the auth package holds) go in beside the tables, and `manifest.json` closes it: what's inside, how
 * many rows of each, and what was left out and why.
 */
import { type SQL, sql, type TenantCtx, type TenantTx } from "@opendash/db";
import { Zip, ZipDeflate } from "fflate";
import { EXPORTED, type ExportSpec, NOT_EXPORTED } from "./tables";

export type ExportKind = "workspace" | "person";

export interface ExportDeps {
  withTenant: <T>(ctx: TenantCtx, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
}

export interface ExportPart {
  kind: ExportKind;
  orgId: string;
  /** Who asked: the conditions are theirs (what they can read, or what is theirs). */
  userId: string;
  /** The folder its files go under in the zip ("" for the root). */
  folder: string;
}

/** Rows read in one transaction. */
export const EXPORT_PAGE = 500;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One page of a table's rows after `after`, in key order, with the key of each. */
export async function exportPage(
  tx: TenantTx,
  spec: ExportSpec,
  part: Pick<ExportPart, "kind" | "orgId" | "userId">,
  after: string | null,
  limit = EXPORT_PAGE,
): Promise<{ k: string; row: Record<string, unknown> }[]> {
  const condition = (part.kind === "workspace" ? spec.workspace : spec.person)?.(part.userId);
  if (!condition) return [];
  const table = sql.identifier(spec.table);
  const org: SQL = spec.table === "org" ? sql`x.id` : sql`x.org_id`;
  const omit = `{${(spec.omit ?? []).join(",")}}`;
  // By its id where it has one (the primary key's own order); else by the key the table names, as text.
  const rows = spec.key
    ? await tx.execute<{ k: string; row: Record<string, unknown> }>(sql`
        select s.k, s.row from (
          select (${spec.key}) collate "C" as k, to_jsonb(x) - ${omit}::text[] as row
          from app.${table} x where ${org} = ${part.orgId}::uuid and (${condition})) s
        where ${after}::text is null or s.k > ${after}::text collate "C"
        order by s.k limit ${limit}`)
    : await tx.execute<{ k: string; row: Record<string, unknown> }>(sql`
        select x.id::text as k, to_jsonb(x) - ${omit}::text[] as row
        from app.${table} x
        where ${org} = ${part.orgId}::uuid and (${condition})
          and (${after}::uuid is null or x.id > ${after}::uuid)
        order by x.id limit ${limit}`);
  return [...rows];
}

export interface ExportManifest {
  format: "opendash-export/1";
  exportedAt: string;
  files: Record<string, { rows: number }>;
  notExported: Record<string, string>;
  notes: string[];
}

const NOTES = [
  "Each .ndjson file holds one table: a JSON object per line, as OpenDash stores it.",
  "Secrets (database passwords, model keys, Slack and MCP tokens) are never exported.",
  "Someone's private conversations and dashboards are theirs alone: a workspace's export has the asker's own and what the workspace shares.",
];

/**
 * The zip's bytes, as they're made. `parts` are exported in order (a workspace; or one person's own in each of
 * their workspaces, each under its folder); `extra` are whole files to put in first.
 */
export async function* exportArchive(
  deps: ExportDeps,
  parts: ExportPart[],
  extra: { name: string; json: unknown }[] = [],
  now: Date = new Date(),
): AsyncGenerator<Uint8Array> {
  for (const part of parts) {
    if (!UUID.test(part.orgId) || !UUID.test(part.userId))
      throw new Error("An export is of a workspace, for a person.");
  }
  const out: Uint8Array[] = [];
  let failed: Error | null = null;
  const zip = new Zip((error, chunk) => {
    if (error) failed = error;
    else out.push(chunk);
  });
  const encoder = new TextEncoder();
  const manifest: ExportManifest = {
    format: "opendash-export/1",
    exportedAt: now.toISOString(),
    files: {},
    notExported: NOT_EXPORTED,
    notes: NOTES,
  };
  function* drain(): Generator<Uint8Array> {
    if (failed) throw failed;
    while (out.length) yield out.shift() as Uint8Array;
  }
  const open = (name: string) => {
    const file = new ZipDeflate(name, { level: 6 });
    file.mtime = now;
    zip.add(file);
    return file;
  };

  for (const { name, json } of extra) {
    const file = open(name);
    file.push(encoder.encode(`${JSON.stringify(json, null, 2)}\n`), true);
    manifest.files[name] = { rows: Array.isArray(json) ? json.length : 1 };
    yield* drain();
  }

  for (const part of parts) {
    for (const spec of EXPORTED) {
      if (!(part.kind === "workspace" ? spec.workspace : spec.person)) continue;
      const name = `${part.folder ? `${part.folder}/` : ""}${spec.table}.ndjson`;
      const file = open(name);
      let after: string | null = null;
      let count = 0;
      for (;;) {
        const page = await deps.withTenant({ orgId: part.orgId, userId: part.userId }, (tx) =>
          exportPage(tx, spec, part, after),
        );
        if (page.length) {
          file.push(encoder.encode(page.map((r) => `${JSON.stringify(r.row)}\n`).join("")), false);
          count += page.length;
          after = page.at(-1)?.k ?? after;
          yield* drain();
        }
        if (page.length < EXPORT_PAGE) break;
      }
      file.push(new Uint8Array(0), true);
      manifest.files[name] = { rows: count };
      yield* drain();
    }
  }

  const last = open("manifest.json");
  last.push(encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`), true);
  zip.end();
  yield* drain();
}

/** A name for a folder in the zip from a workspace's: letters, digits, dashes; never empty, never a path. */
export function exportFolder(name: string, fallback: string): string {
  const safe = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return safe || fallback;
}

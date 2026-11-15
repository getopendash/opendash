import { Definition, provenanceOf, sourceMark } from "@opendash/apps/dashboard";
import type { Catalog, QueryRead } from "@opendash/apps/protocol";
import { isUuid, sql, type TenantTx } from "@opendash/db";

/**
 * Where each of an App's queries reads, in the reader's words, for the quiet line under its chart or grid ("Warehouse
 * · Accounts", "Fullstory · Checkout funnel"): the source's name (the warehouse connection's, or the connected
 * service's), what it reads there (the App's own dataset's title, or the released one's) and whether that's verified.
 * Names and the source's mark only: nothing a query returns. Without them, a tile wouldn't say which source it reads.
 */
export async function queryReads(
  tx: TenantTx,
  orgId: string,
  definition: unknown,
  catalogs: Record<string, Catalog>,
): Promise<Record<string, QueryRead>> {
  const parsed = Definition.safeParse(definition);
  if (!parsed.success) return {};
  const d = parsed.data;
  const ids = [...new Set(Object.values(d.queries).map((q) => q.source.connection))].filter(isUuid);
  if (!ids.length) return {};
  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await tx.execute<{ id: string; name: string; dialect: string | null; url: string | null }>(sql`
    select id::text as id, name, dialect, null as url from app.connection where org_id = ${orgId} and id in (${list})
    union all
    select id::text as id, name, null as dialect, url from app.mcp_server where org_id = ${orgId} and id in (${list})`);
  const names = new Map(rows.map((r) => [r.id, r.name]));
  // Each source's mark, drawn before its name: a database's by its dialect, a service's by its address.
  const marks = new Map(
    rows.map((r) => [
      r.id,
      sourceMark(r.dialect ? { dialect: r.dialect } : r.url ? { url: r.url, name: r.name } : undefined),
    ]),
  );
  const provenance = provenanceOf(d, catalogs);
  const out: Record<string, QueryRead> = {};
  for (const [qid, q] of Object.entries(d.queries)) {
    const own = d.datasets?.[q.source.dataset];
    const dataset =
      (own && own.connection === q.source.connection ? own.title : undefined) ??
      catalogs[q.source.connection]?.[q.source.dataset]?.title ??
      q.source.dataset.replace(/_/g, " ");
    out[qid] = {
      source: names.get(q.source.connection) ?? "a source",
      dataset,
      ...(provenance[qid] ? { provenance: provenance[qid] } : {}),
      ...(marks.get(q.source.connection) ? { mark: marks.get(q.source.connection) } : {}),
    };
  }
  return out;
}

/**
 * Walking the context graph: recursive CTEs over `edge`, 1–3 hops, inside the same RLS as
 * everything else. Apache AGE only if 3-hop walks pass p95 100 ms at real sizes.
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { EdgeRel, NodeKind } from "./project";

export type Reached = {
  id: string;
  kind: NodeKind;
  key: string;
  title: string | null;
  status: string | null;
  connection_id: string | null;
  /** Its nearest distance from where the walk started. */
  depth: number;
};

/** What's within `depth` hops of a node, along its edges either way (only `rels`, when given): each once, nearest first. */
export async function walkGraph(
  tx: TenantTx,
  orgId: string,
  from: string,
  options: { depth?: number; rels?: EdgeRel[]; limit?: number } = {},
): Promise<Reached[]> {
  if (!isUuid(from)) return [];
  const depth = Math.min(Math.max(options.depth ?? 3, 1), 3);
  const rels = options.rels?.length
    ? sql`and e.rel in (${sql.join(
        options.rels.map((r) => sql`${r}`),
        sql`, `,
      )})`
    : sql``;
  return tx.execute<Reached>(sql`
    with recursive walk(id, depth) as (
      select ${from}::uuid, 0
      union
      select case when e.src_id = w.id then e.dst_id else e.src_id end, w.depth + 1
      from walk w
      join app.edge e on e.org_id = ${orgId} and (e.src_id = w.id or e.dst_id = w.id) ${rels}
      where w.depth < ${depth}
    )
    select n.id, n.kind, n.key, n.title, n.status, n.connection_id, min(w.depth)::int as depth
    from walk w join app.node n on n.org_id = ${orgId} and n.id = w.id
    where w.id <> ${from}::uuid
    group by n.id, n.kind, n.key, n.title, n.status, n.connection_id
    order by min(w.depth), n.kind, n.key
    limit ${options.limit ?? 2000}`);
}

/** The edges touching these nodes, for drawing what they're connected to and how. */
export async function edgesOf(
  tx: TenantTx,
  orgId: string,
  ids: string[],
): Promise<{ rel: EdgeRel; src_id: string; dst_id: string; props: Record<string, unknown> }[]> {
  const list = ids.filter(isUuid);
  if (!list.length) return [];
  const arr = `{${list.join(",")}}`;
  return tx.execute(sql`
    select rel, src_id, dst_id, props from app.edge
    where org_id = ${orgId} and (src_id = any(${arr}::uuid[]) or dst_id = any(${arr}::uuid[]))`);
}

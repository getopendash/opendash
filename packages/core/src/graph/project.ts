/**
 * The context graph's projection: an organization's nodes and edges, rebuilt whole in one transaction from
 * what's canonical (the catalog, the organization's knowledge items, the Curator's learnings), so a rebuild is always
 * safe and no answer depends on it. Personal memories stay out; a topic reads the viewer's own where they live.
 */
import { isUuid, type SystemTx, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { topicKey } from "../learning/curator";

export type NodeKind = "table" | "column" | "dataset" | "metric" | "term" | "guide" | "learning" | "person";
export type EdgeRel = "MEANS" | "IS_NOT" | "ABOUT" | "SAID_BY" | "PART_OF" | "DEFINED_ON" | "MEASURES";

interface GraphNode {
  id: string;
  kind: NodeKind;
  key: string;
  title: string | null;
  status: string | null;
  connection_id: string | null;
  props: Record<string, unknown>;
}

interface GraphEdge {
  id: string;
  rel: EdgeRel;
  src_id: string;
  dst_id: string;
  props: Record<string, unknown>;
}

type ItemRow = {
  id: string;
  kind: "term" | "guide" | "dataset" | "metric";
  title: string;
  slug: string;
  status: string;
  connection_id: string | null;
  released_version: number | null;
  current_version: number;
  spec: Record<string, unknown> | null;
  derived: { tables?: string[] } | null;
  proposed: boolean;
};

const lower = (s: string) => s.toLowerCase();
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

/** An organization's graph, rebuilt: its nodes and edges replaced by what its canonical rows say now. */
export async function projectGraph(tx: TenantTx, orgId: string): Promise<{ nodes: number; edges: number }> {
  const tables = await tx.execute<{ id: string; fq_name: string; kind: string; connection_id: string }>(sql`
    select id, fq_name, kind, connection_id from app.catalog_object
    where org_id = ${orgId} and kind in ('table', 'view') and removed_at is null`);
  // The released version's meaning when there is one, the proposed one's otherwise (a learning waiting for a tap).
  const items = await tx.execute<ItemRow>(sql`
    select i.id, i.kind, i.title, i.slug, i.status, i.connection_id, i.released_version, i.current_version,
      coalesce(r.spec, c.spec) as spec, coalesce(r.derived, c.derived) as derived, r.version is null as proposed
    from app.context_item i
    join app.context_item_version c on c.org_id = i.org_id and c.item_id = i.id and c.version = i.current_version
    left join app.context_item_version r on r.org_id = i.org_id and r.item_id = i.id and r.version = i.released_version
    where i.org_id = ${orgId} and i.scope = 'org' and i.deleted_at is null
      and i.kind in ('term', 'guide', 'dataset', 'metric')`);
  const learnings = await tx.execute<{
    id: string;
    status: string;
    title: string;
    dedupe_key: string | null;
    evidence: { termId?: string; signals?: { userId?: string }[] } | null;
  }>(sql`
    select id, status, title, dedupe_key, evidence from app.proposal
    where org_id = ${orgId} and source = 'curator' and status not in ('superseded', 'discarded')`);

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const add = (n: GraphNode) => nodes.set(n.id, n);
  const link = (rel: EdgeRel, src: string, dst: string | undefined, props: Record<string, unknown> = {}) => {
    if (dst && nodes.has(src) && nodes.has(dst) && src !== dst) {
      edges.push({ id: uuidv7(), rel, src_id: src, dst_id: dst, props });
    }
  };

  // Tables and views, found by source and lowercased name.
  const tableOf = new Map<string, string>();
  for (const t of tables) {
    add({
      id: t.id,
      kind: "table",
      key: lower(t.fq_name),
      title: t.fq_name,
      status: null,
      connection_id: t.connection_id,
      props: t.kind === "view" ? { view: true } : {},
    });
    tableOf.set(`${t.connection_id}:${lower(t.fq_name)}`, t.id);
  }
  const table = (connectionId: string | null, name: unknown) =>
    connectionId && typeof name === "string" ? tableOf.get(`${connectionId}:${lower(name)}`) : undefined;

  // Only the columns something points at (a term's mapping), each part of its table.
  const terms = items.filter((i) => i.kind === "term");
  const wanted = [
    ...new Set(
      terms.flatMap((t) => {
        const column = (t.spec?.maps_to as { column?: unknown } | undefined)?.column;
        return t.connection_id && typeof column === "string" ? [`${t.connection_id}:${lower(column)}`] : [];
      }),
    ),
  ];
  const columnOf = new Map<string, string>();
  if (wanted.length) {
    const columns = await tx.execute<{ id: string; fq_name: string; connection_id: string }>(sql`
      select id, fq_name, connection_id from app.catalog_object
      where org_id = ${orgId} and kind = 'column' and removed_at is null
        and connection_id::text || ':' || lower(fq_name) = any(${`{${wanted.map((w) => `"${w}"`).join(",")}}`}::text[])`);
    for (const c of columns) {
      add({
        id: c.id,
        kind: "column",
        key: lower(c.fq_name),
        title: c.fq_name,
        status: null,
        connection_id: c.connection_id,
        props: {},
      });
      columnOf.set(`${c.connection_id}:${lower(c.fq_name)}`, c.id);
      link("PART_OF", c.id, table(c.connection_id, c.fq_name.split(".").slice(0, -1).join(".")));
    }
  }

  // Definitions, guides and terms.
  const bySlug = new Map<string, string>();
  for (const i of items) {
    const term = i.kind === "term";
    add({
      id: i.id,
      kind: i.kind,
      key: term ? topicKey(String(i.spec?.term ?? i.title)) : i.slug,
      title: term ? String(i.spec?.term ?? i.title) : i.title,
      status: i.status,
      connection_id: i.connection_id,
      props: term
        ? {
            means: i.spec?.means ?? null,
            synonyms: strings(i.spec?.synonyms),
            released: i.released_version,
            proposed: i.proposed,
          }
        : {},
    });
    if (i.kind === "dataset" || i.kind === "metric") bySlug.set(`${i.connection_id}:${i.kind}:${i.slug}`, i.id);
  }
  for (const i of items) {
    if (i.kind === "term") {
      const mapsTo = (i.spec?.maps_to ?? {}) as { column?: unknown; values?: unknown; metric?: unknown };
      if (typeof mapsTo.column === "string") {
        link("MEANS", i.id, columnOf.get(`${i.connection_id}:${lower(mapsTo.column)}`), {
          values: strings(mapsTo.values),
          ...(i.proposed ? { proposed: true } : {}),
        });
      }
      if (typeof mapsTo.metric === "string") {
        link("MEANS", i.id, bySlug.get(`${i.connection_id}:metric:${mapsTo.metric}`));
      }
      for (const t of strings(i.spec?.not)) link("IS_NOT", i.id, table(i.connection_id, t));
    } else if (i.kind === "guide") {
      link("ABOUT", i.id, table(i.connection_id, i.spec?.table));
    } else if (i.kind === "dataset") {
      for (const t of strings(i.derived?.tables)) link("DEFINED_ON", i.id, table(i.connection_id, t));
    } else if (i.kind === "metric") {
      link("MEASURES", i.id, bySlug.get(`${i.connection_id}:dataset:${String(i.spec?.dataset ?? "")}`));
    }
  }

  // Learnings, about their term, said by the people whose corrections they hold (a count each, never their words).
  for (const l of learnings) {
    add({
      id: l.id,
      kind: "learning",
      key: l.dedupe_key ?? `learning:${l.id}`,
      title: l.title,
      status: l.status,
      connection_id: null,
      props: {},
    });
    const by = new Map<string, number>();
    for (const s of l.evidence?.signals ?? []) {
      if (s.userId && isUuid(s.userId)) by.set(s.userId, (by.get(s.userId) ?? 0) + 1);
    }
    for (const [userId, count] of by) {
      if (!nodes.has(userId)) {
        add({ id: userId, kind: "person", key: userId, title: null, status: null, connection_id: null, props: {} });
      }
      link("SAID_BY", l.id, userId, { count });
    }
    if (l.evidence?.termId && isUuid(l.evidence.termId)) link("ABOUT", l.id, l.evidence.termId);
  }

  await tx.execute(sql`delete from app.node where org_id = ${orgId}`);
  const list = [...nodes.values()];
  for (let i = 0; i < list.length; i += 1000) {
    await tx.execute(sql`
      insert into app.node (org_id, id, kind, key, title, status, connection_id, props)
      select ${orgId}, n.id, n.kind, n.key, n.title, n.status, n.connection_id, n.props
      from jsonb_to_recordset(${JSON.stringify(list.slice(i, i + 1000))}::jsonb)
        as n(id uuid, kind text, key text, title text, status text, connection_id uuid, props jsonb)`);
  }
  for (let i = 0; i < edges.length; i += 1000) {
    await tx.execute(sql`
      insert into app.edge (org_id, id, rel, src_id, dst_id, props)
      select ${orgId}, e.id, e.rel, e.src_id, e.dst_id, e.props
      from jsonb_to_recordset(${JSON.stringify(edges.slice(i, i + 1000))}::jsonb)
        as e(id uuid, rel text, src_id uuid, dst_id uuid, props jsonb)
      on conflict do nothing`);
  }
  return { nodes: list.length, edges: edges.length };
}

/**
 * The organizations whose graph is out of date: knowledge or the catalog changed after it was projected, or a learning
 * is under way (its status moves without a timestamp). Never projected and with something to project counts too.
 */
export async function graphsDue(tx: SystemTx, limit = 100): Promise<string[]> {
  const rows = await tx.execute<{ id: string }>(sql`
    select o.id from app.org o
    where exists (
        select 1 from app.proposal p
        where p.org_id = o.id and p.source = 'curator' and p.status in ('drafting', 'held', 'evaluating', 'open'))
      or coalesce((select max(n.projected_at) from app.node n where n.org_id = o.id), '-infinity'::timestamptz) < greatest(
        (select max(greatest(i.updated_at, coalesce(i.deleted_at, i.updated_at))) from app.context_item i
          where i.org_id = o.id and i.scope = 'org'),
        (select max(greatest(c.updated_at, coalesce(c.removed_at, c.updated_at))) from app.catalog_object c
          where c.org_id = o.id),
        (select max(coalesce(p.decided_at, p.created_at)) from app.proposal p
          where p.org_id = o.id and p.source = 'curator'))
    order by o.id limit ${limit}`);
  return rows.map((r) => r.id);
}

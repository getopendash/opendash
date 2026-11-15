/**
 * Workspace search, by words alone: the workspace's knowledge and tables through
 * `app.search_context`, fused and weighed here, and the palette's conversations through the rules that already decide
 * who reads them. Dashboards aren't searched yet. Deterministic, no model.
 *
 * `contextSearch` is what a future `context_search` tool would call; wiring it into the analyst is a prompt change,
 * which waits on a DashBench run. Vectors, one-hop expansion and packing quotas come with that, and the context
 * graph's node index replaces the on-the-fly ranking.
 */
import { sql, type TenantTx } from "@opendash/db";
import type { LedgerDeps, Viewer } from "../runs/ledger";
import { listThreadPage } from "../runs/threads";
import { rrf } from "./rank";

export const KNOWLEDGE_KINDS = ["dataset", "metric", "term", "guide", "verified_query", "skill"] as const;
export type SearchKind = (typeof KNOWLEDGE_KINDS)[number] | "table";

export interface SearchHit {
  kind: SearchKind;
  id: string;
  connectionId: string | null;
  title: string;
  key: string;
  status: string;
  score: number;
}

/** Doc 06's trust weights: verified 1.0, observed (a table the catalog saw) 0.7, drafted 0.5, flagged 0.2. */
export function trustWeight(status: string): number {
  if (status === "verified") return 1;
  if (status === "observed") return 0.7;
  if (status === "needs_review" || status === "deprecated") return 0.2;
  return 0.5;
}

type Row = Omit<SearchHit, "score" | "connectionId"> & {
  connection_id: string | null;
  fts: number;
  sim: number;
  exact: boolean;
};

/**
 * Reciprocal rank fusion of the ranked lists (full text, name similarity, exact name), times the trust weight. Pure,
 * for tests.
 */
export function fuse(rows: Row[]): SearchHit[] {
  const key = (r: Row) => `${r.kind}:${r.id}`;
  // Ties broken by the other list's measure, then the title: deterministic, and the better match first.
  const score = rrf([
    rows
      .filter((r) => r.fts > 0)
      .sort((a, b) => b.fts - a.fts || b.sim - a.sim || a.title.localeCompare(b.title))
      .map(key),
    rows
      .filter((r) => r.sim > 0)
      .sort((a, b) => b.sim - a.sim || b.fts - a.fts || a.title.localeCompare(b.title))
      .map(key),
    rows
      .filter((r) => r.exact)
      .sort((a, b) => b.fts - a.fts || a.title.localeCompare(b.title))
      .map(key),
  ]);
  return rows
    .map((r) => ({
      kind: r.kind,
      id: r.id,
      connectionId: r.connection_id,
      title: r.title,
      key: r.key,
      status: r.status,
      score: (score.get(`${r.kind}:${r.id}`) ?? 0) * trustWeight(r.status),
    }))
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

/** The workspace's released knowledge and tables matching `q`, best first. */
export async function contextSearch(
  tx: TenantTx,
  q: string,
  options: { kinds?: readonly SearchKind[]; limit?: number } = {},
): Promise<SearchHit[]> {
  const text = q.trim().slice(0, 200);
  if (!text) return [];
  const kinds = options.kinds ?? [...KNOWLEDGE_KINDS, "table"];
  const rows = await tx.execute<Row>(sql`
    select kind, id, connection_id, title, key, status, fts, sim, exact
    from app.search_context(${text}, array[${sql.join(
      kinds.map((k) => sql`${k}`),
      sql`, `,
    )}]::text[])`);
  return fuse(rows).slice(0, Math.min(Math.max(options.limit ?? 20, 1), 100));
}

export interface WorkspaceSearch {
  knowledge: SearchHit[];
  tables: (SearchHit & { sourceName: string })[];
  conversations: { id: string; title: string; mine: boolean; at: string }[];
}

/** What the palette shows for `q`, each group capped, each read as the viewer may. */
export async function searchWorkspace(deps: LedgerDeps, viewer: Viewer, q: string): Promise<WorkspaceSearch> {
  const text = q.trim().slice(0, 200);
  const empty: WorkspaceSearch = { knowledge: [], tables: [], conversations: [] };
  if (!text) return empty;
  const [found, threads] = await Promise.all([
    deps.withTenant(viewer.orgId, async (tx) => {
      const hits = await contextSearch(tx, text, { limit: 40 });
      const tableHits = hits.filter((h) => h.kind === "table").slice(0, 5);
      const sources = tableHits.length
        ? await tx.execute<{ id: string; name: string }>(sql`
            select id, name from app.connection where org_id = ${viewer.orgId} and id in (${sql.join(
              [...new Set(tableHits.map((h) => h.connectionId as string))].map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`)
        : [];
      const names = new Map(sources.map((s) => [s.id, s.name]));
      return {
        knowledge: hits.filter((h) => h.kind !== "table").slice(0, 6),
        tables: tableHits.map((h) => ({ ...h, sourceName: names.get(h.connectionId as string) ?? "" })),
      };
    }),
    listThreadPage(deps, viewer, { q: text, limit: 5 }),
  ]);
  return {
    ...found,
    conversations: threads.threads.map((t) => ({
      id: t.id,
      title: t.title,
      mine: t.mine,
      at: t.lastMessageAt ?? t.createdAt,
    })),
  };
}

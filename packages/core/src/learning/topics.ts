/**
 * Knowledge → Learnings: one topic per thing. A topic is a term (released or proposed), or a learning
 * still working toward one, keyed by the term's topic key. Its page brings together what lived in five places: the
 * meaning, its learnings and how each was decided, the viewer's own memories about it, the guides on its tables, and
 * its tests. What's connected comes from the graph; statuses and meanings from the rows themselves, always fresh.
 *
 * Who sees what: an owner or admin, every topic; anyone else, a term the team uses, and topics they corrected or keep a
 * memory about. A memory is only ever its owner's (the caller's transaction carries them).
 */
import { isUuid, sql, type TenantTx } from "@opendash/db";
import type { TermSpec } from "../context/items";
import type { EdgeRel, NodeKind } from "../graph/project";
import { topicKey } from "./curator";
import { type LearningCard, learningsOfTopic, topicOfSlug, topicSlug } from "./learnings";

/** The team's (released) · waiting for a tap · being learned · reverted · proposed (a term not yet anyone's). */
export type TopicState = "team" | "waiting" | "learning" | "reverted" | "proposed";

export interface TopicMeaning {
  term: string;
  means: string | null;
  column: string | null;
  values: string[];
  not: string[];
  synonyms: string[];
}

export interface TopicSummary {
  slug: string;
  title: string;
  state: TopicState;
  /** In a line: "subscriptions where status in ('active')", or what it means in words. */
  line: string | null;
  learnings: number;
  corrections: number;
  memories: number;
  tests: number;
  at: string;
}

export interface TopicView extends TopicSummary {
  termId: string | null;
  /** The meaning the team uses (released), and a proposed one beside it when a learning waits. */
  released: TopicMeaning | null;
  proposed: TopicMeaning | null;
  cards: LearningCard[];
  /** The viewer's own memories about it. */
  yourMemories: { id: string; fact: string; at: string }[];
  guides: { id: string; title: string }[];
  definitions: { id: string; kind: "dataset" | "metric"; title: string }[];
  testCases: { id: string; question: string; verdict: string | null; at: string | null }[];
  /** For an owner or admin: answers in the last 30 days that read a table it isn't (counts, never the answers). */
  readNot: { table: string; answers: number }[] | null;
  /** What it's connected to, for its diagram: the term and what's within three hops, and the edges between them. */
  graph: TopicGraph | null;
}

export interface TopicGraph {
  nodes: {
    id: string;
    kind: NodeKind;
    title: string;
    connectionId: string | null;
    status?: string | null;
    /** Where it sits: the term, what it means, the table that is, a table it isn't, what's on that table, another term
     * on the same column, how it was learned. */
    role: "term" | "means" | "table" | "isnt" | "on" | "sibling" | "learned";
    /** A line for its hover card. */
    detail: string | null;
  }[];
  edges: { rel: EdgeRel; src: string; dst: string }[];
}

type Viewer = { orgId: string; userId: string | null; approver: boolean };

const meaningOf = (spec: TermSpec | null): TopicMeaning | null =>
  spec
    ? {
        term: spec.term,
        means: spec.means ?? null,
        column: spec.maps_to?.column ?? null,
        values: spec.maps_to?.values ?? [],
        not: spec.not ?? [],
        synonyms: spec.synonyms ?? [],
      }
    : null;

/** A meaning in a line: the table and filter when it has a column, its words otherwise. */
export function meaningLine(m: TopicMeaning | null): string | null {
  if (!m) return null;
  if (!m.column) return m.means;
  const parts = m.column.split(".");
  const table = parts.slice(0, -1).join(".");
  return m.values.length ? `${table} where ${parts.at(-1)} in (${m.values.map((v) => `'${v}'`).join(", ")})` : table;
}

type TermRow = {
  id: string;
  connection_id: string | null;
  title: string;
  status: string;
  released: TermSpec | null;
  current: TermSpec;
  released_version: number | null;
  current_version: number;
  updated_at: string;
};
type LearningRow = {
  id: string;
  status: string;
  dedupe_key: string | null;
  term_id: string | null;
  signals: { userId?: string }[] | null;
  at: string;
};

async function rowsOf(tx: TenantTx, viewer: Viewer, key: string | null) {
  const terms = await tx.execute<TermRow>(sql`
    select i.id, i.connection_id, i.title, i.status, r.spec as released, c.spec as current, i.released_version,
      i.current_version, i.updated_at
    from app.context_item i
    join app.context_item_version c on c.org_id = i.org_id and c.item_id = i.id and c.version = i.current_version
    left join app.context_item_version r on r.org_id = i.org_id and r.item_id = i.id and r.version = i.released_version
    where i.org_id = ${viewer.orgId} and i.kind = 'term' and i.scope = 'org' and i.deleted_at is null`);
  const learnings = await tx.execute<LearningRow>(sql`
    select id, status, dedupe_key, evidence->>'termId' as term_id, evidence->'signals' as signals,
      coalesce(decided_at, created_at) as at
    from app.proposal
    where org_id = ${viewer.orgId} and source = 'curator' and status not in ('superseded', 'discarded')
      ${key ? sql`and dedupe_key = ${key}` : sql``}`);
  const memories = viewer.userId
    ? await tx.execute<{ id: string; fact: string; about: string | null; at: string }>(sql`
        select i.id, i.title as fact, v.spec->>'about' as about, i.created_at as at
        from app.context_item i
        join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
        where i.org_id = ${viewer.orgId} and i.kind = 'memory' and i.scope = 'personal' and i.scope_id = ${viewer.userId}
          and i.deleted_at is null and v.spec->>'about' is not null`)
    : [];
  const tests = await tx.execute<{
    id: string;
    origin_ref: string;
    question: string;
    verdict: string | null;
    at: string | null;
  }>(sql`
    select c.id, c.origin_ref, c.question, r.verdict, r.created_at as at
    from app.eval_case c
    left join lateral (
      select verdict, created_at from app.eval_result r
      where r.org_id = c.org_id and r.case_id = c.id order by created_at desc limit 1) r on true
    where c.org_id = ${viewer.orgId} and c.origin = 'correction' and c.active`);
  return { terms, learnings, memories, tests };
}

/** A topic's state: the team's when its term is released; otherwise where its newest learning is. */
function stateOf(term: TermRow | undefined, learnings: LearningRow[]): TopicState {
  if (term?.released_version != null) return "team";
  const newest = learnings[0]?.status;
  if (newest === "open") return "waiting";
  if (newest === "reverted") return "reverted";
  if (newest && ["drafting", "held", "evaluating"].includes(newest)) return "learning";
  return "proposed";
}

function summarize(
  viewer: Viewer,
  rows: Awaited<ReturnType<typeof rowsOf>>,
): Map<string, TopicSummary & { termId: string | null; mine: boolean }> {
  const topics = new Map<string, TopicSummary & { termId: string | null; mine: boolean }>();
  const termOf = new Map<string, TermRow>();
  for (const t of rows.terms) termOf.set(topicKey((t.released ?? t.current).term ?? t.title), t);
  const keys = new Set([...termOf.keys(), ...rows.learnings.flatMap((l) => (l.dedupe_key ? [l.dedupe_key] : []))]);
  for (const key of keys) {
    const term = termOf.get(key);
    const learnings = rows.learnings
      .filter((l) => l.dedupe_key === key || (term && l.term_id === term.id))
      .sort((a, b) => b.at.localeCompare(a.at));
    if (!term && learnings.every((l) => ["rejected", "failed"].includes(l.status))) continue;
    const signals = learnings.flatMap((l) => l.signals ?? []);
    const memories = rows.memories.filter((m) => m.about && topicKey(m.about) === key);
    const tests = term ? rows.tests.filter((c) => c.origin_ref === term.id) : [];
    const spec = term ? (term.released ?? term.current) : null;
    const state = stateOf(term, learnings);
    const mine = signals.some((s) => s.userId === viewer.userId) || memories.length > 0;
    topics.set(key, {
      slug: topicSlug(key),
      title: spec?.term ?? term?.title ?? key.replace(/^term:/, ""),
      state,
      line: meaningLine(meaningOf(spec)),
      learnings: learnings.length,
      corrections: signals.length,
      memories: memories.length,
      tests: tests.length,
      at: [term?.updated_at, learnings[0]?.at, ...memories.map((m) => m.at)].filter(Boolean).sort().at(-1) ?? "",
      termId: term?.id ?? null,
      mine,
    });
  }
  return topics;
}

const visible = (viewer: Viewer, t: { state: TopicState; mine: boolean }) =>
  viewer.approver || t.state === "team" || t.mine;

/** The topics the viewer may see: what waits for a tap first, then the newest. */
export async function listTopics(tx: TenantTx, viewer: Viewer): Promise<TopicSummary[]> {
  const order: Record<TopicState, number> = { waiting: 0, learning: 1, proposed: 2, team: 3, reverted: 4 };
  return [...summarize(viewer, await rowsOf(tx, viewer, null)).values()]
    .filter((t) => visible(viewer, t))
    .sort((a, b) => order[a.state] - order[b.state] || b.at.localeCompare(a.at))
    .map(({ termId: _t, mine: _m, ...t }) => t);
}

const STATUS: Record<string, string> = {
  verified: "released",
  proposed: "proposed",
  draft: "a draft",
  needs_review: "needs review",
};
const LEARNED: Record<string, string> = {
  drafting: "being learned",
  held: "held",
  evaluating: "being checked",
  open: "waiting for a tap",
  approved: "approved",
  rejected: "not taken",
  reverted: "reverted",
  failed: "couldn't be learned",
};
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * A topic's diagram, along the paths that mean something: what the term means (the column, the table
 * that is, the guides and definitions on it, other terms on the same column), the tables it isn't (nothing beyond
 * them), and how it was learned, as one summary. Anyone but an approver sees only what's released, and not the
 * learnings.
 */
async function topicGraph(
  tx: TenantTx,
  viewer: Viewer,
  termId: string,
  line: string | null,
  learned: { learnings: number; corrections: number; people: number; status: string | null },
): Promise<TopicGraph> {
  type E = { rel: EdgeRel; src_id: string; dst_id: string; props: Record<string, unknown> };
  const along = (side: "src_id" | "dst_id", ids: string[], rels: EdgeRel[]) =>
    ids.length
      ? tx.execute<E>(sql`
          select rel, src_id, dst_id, props from app.edge
          where org_id = ${viewer.orgId} and ${sql.raw(side)} = any(${`{${ids.join(",")}}`}::uuid[])
            and rel in (${sql.join(
              rels.map((r) => sql`${r}`),
              sql`, `,
            )})`)
      : Promise.resolve([] as E[]);
  const fromTerm = await along("src_id", [termId], ["MEANS", "IS_NOT"]);
  const meant = fromTerm.filter((e) => e.rel === "MEANS").map((e) => e.dst_id);
  const isnt = fromTerm.filter((e) => e.rel === "IS_NOT").map((e) => e.dst_id);
  const partOf = await along("src_id", meant, ["PART_OF"]);
  const tables = partOf.map((e) => e.dst_id);
  const siblings = (await along("dst_id", meant, ["MEANS"])).filter((e) => e.src_id !== termId);
  const on = await along("dst_id", tables, ["ABOUT", "DEFINED_ON"]);
  const role = new Map<string, TopicGraph["nodes"][number]["role"]>([[termId, "term"]]);
  for (const id of meant) role.set(id, "means");
  for (const id of isnt) role.set(id, "isnt");
  for (const id of tables) if (!role.has(id)) role.set(id, "table");
  for (const e of siblings) if (!role.has(e.src_id)) role.set(e.src_id, "sibling");
  for (const e of on) if (!role.has(e.src_id)) role.set(e.src_id, "on");
  const ids = [...role.keys()];
  const rows = await tx.execute<{
    id: string;
    kind: NodeKind;
    title: string | null;
    key: string;
    status: string | null;
    connection_id: string | null;
  }>(sql`
    select id, kind, title, key, status, connection_id from app.node
    where org_id = ${viewer.orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])`);
  const values = new Map(
    fromTerm.filter((e) => e.rel === "MEANS").map((e) => [e.dst_id, (e.props.values as string[] | undefined) ?? []]),
  );
  const tableName = new Map(rows.filter((r) => r.kind === "table").map((r) => [r.id, r.title ?? r.key]));
  const onWhat = new Map(on.map((e) => [e.src_id, tableName.get(e.dst_id) ?? null]));
  const visible = rows.filter(
    (r) => r.id === termId || viewer.approver || r.kind === "table" || r.kind === "column" || r.status === "verified",
  );
  const nodes: TopicGraph["nodes"] = visible.map((r) => {
    const at = role.get(r.id) ?? "on";
    const title = r.title ?? r.key;
    const state = r.status ? STATUS[r.status] : null;
    const detail =
      at === "term"
        ? line
        : at === "means"
          ? r.kind === "column"
            ? `The column it means${values.get(r.id)?.length ? `, where it's ${values.get(r.id)?.join(", ")}` : ""}`
            : "The metric it means"
          : at === "table"
            ? "The table it means"
            : at === "isnt"
              ? "A table it isn't: never read it for this"
              : at === "sibling"
                ? `Another term on the same column${state ? ` · ${state}` : ""}`
                : `${r.kind === "guide" ? "A guide" : r.kind === "metric" ? "A metric" : "A dataset"} on ${onWhat.get(r.id) ?? "its table"}${state ? ` · ${state}` : ""}`;
    return { id: r.id, kind: r.kind, title, connectionId: r.connection_id, status: r.status, role: at, detail };
  });
  const shown = new Set(nodes.map((n) => n.id));
  const edges = [...fromTerm, ...partOf, ...siblings, ...on]
    .filter((e) => shown.has(e.src_id) && shown.has(e.dst_id))
    .map((e) => ({ rel: e.rel, src: e.src_id, dst: e.dst_id }));
  if (viewer.approver && learned.learnings) {
    const id = `learned:${termId}`;
    nodes.push({
      id,
      kind: "learning",
      title: learned.status
        ? `${LEARNED[learned.status] ?? learned.status}`.replace(/^./, (c) => c.toUpperCase())
        : "Learned",
      connectionId: null,
      status: learned.status,
      role: "learned",
      detail: `${plural(learned.learnings, "learning")} · ${plural(learned.corrections, "correction")} by ${plural(learned.people, "person", "people")}`,
    });
    edges.push({ rel: "ABOUT", src: id, dst: termId });
  }
  return { nodes, edges };
}

/** One topic's page, or null when it isn't there or isn't the viewer's to see. */
export async function getTopic(tx: TenantTx, viewer: Viewer, slug: string): Promise<TopicView | null> {
  const key = topicOfSlug(slug);
  const rows = await rowsOf(tx, viewer, null);
  const summary = summarize(viewer, rows).get(key);
  if (!summary || !visible(viewer, summary)) return null;
  const term = rows.terms.find((t) => t.id === summary.termId);
  const released = meaningOf(term?.released ?? null);
  const current = meaningOf(term?.current ?? null);
  // A change waiting for a tap isn't the team's yet: an approver's to see, or whoever corrected it.
  const proposed =
    term &&
    (viewer.approver || summary.mine) &&
    (term.released_version === null || term.current_version > term.released_version)
      ? current
      : null;
  // What it's connected to, along the paths that mean something (its diagram, and the guides and definitions on it).
  const cards = await learningsOfTopic(tx, viewer, key);
  const people = new Set(
    rows.learnings
      .filter((l) => l.dedupe_key === key || (term && l.term_id === term.id))
      .flatMap((l) => (l.signals ?? []).flatMap((x) => (x.userId ? [x.userId] : []))),
  ).size;
  const graph = term
    ? await topicGraph(tx, viewer, term.id, meaningLine(released ?? current), {
        learnings: summary.learnings,
        corrections: summary.corrections,
        people,
        status: cards[0]?.status ?? null,
      })
    : null;
  const guides = (graph?.nodes ?? []).filter((n) => n.kind === "guide");
  const definitions = (graph?.nodes ?? []).filter(
    (n) => n.role === "on" && (n.kind === "dataset" || n.kind === "metric"),
  );
  const not = released?.not ?? current?.not ?? [];
  const readNot =
    viewer.approver && not.length
      ? await Promise.all(
          not.map(async (table) => {
            const [r] = await tx.execute<{ n: number }>(sql`
              select count(distinct requester_id)::int as n from app.query_run
              where org_id = ${viewer.orgId} and connection_id = ${term?.connection_id ?? null}
                and requester_type = 'run' and created_at > now() - interval '30 days'
                and reads @> ${JSON.stringify({ tables: [table.toLowerCase()] })}::jsonb`);
            return { table, answers: r?.n ?? 0 };
          }),
        )
      : null;
  return {
    ...summary,
    termId: summary.termId,
    released,
    proposed,
    cards,
    yourMemories: rows.memories
      .filter((m) => m.about && topicKey(m.about) === key)
      .map((m) => ({ id: m.id, fact: m.fact, at: m.at })),
    guides: guides.map((g) => ({ id: g.id, title: g.title })),
    definitions: definitions.map((d) => ({ id: d.id, kind: d.kind as "dataset" | "metric", title: d.title })),
    testCases: term
      ? rows.tests
          .filter((c) => c.origin_ref === term.id)
          .map((c) => ({ id: c.id, question: c.question, verdict: c.verdict, at: c.at }))
      : [],
    readNot,
    graph,
  };
}

export const isTopicSlug = (slug: string) => /^[\p{L}\p{N}]+(-[\p{L}\p{N}]+)*$/u.test(slug) && !isUuid(slug);

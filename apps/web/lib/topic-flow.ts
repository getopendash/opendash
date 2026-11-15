import { Graph, layout } from "@dagrejs/dagre";
import type { TopicGraph } from "@opendash/core";

/**
 * A topic's diagram for React Flow, laid out left to right by dagre so edges don't cross: how it was
 * learned → the term (and other terms on the same column) → what it means (its table and filter, one box) and the
 * tables it isn't → the guides and definitions on that table. Pure: tested apart from the drawing.
 */
export type Tone = "term" | "isnt" | "plain" | "learned";

export interface FlowNodeFields {
  kind: string;
  /** "Table · datawarehouse", "Guide"… */
  label: string;
  title: string;
  /** A second line: the filter it means. */
  sub: string | null;
  /** For the hover card: the whole name and what it is. */
  full: string;
  detail: string | null;
  href: string | null;
  tone: Tone;
}

/** React Flow keeps node data as a record. */
export type FlowNodeData = FlowNodeFields & Record<string, unknown>;

export interface FlowNode {
  id: string;
  type: "topic";
  position: { x: number; y: number };
  width: number;
  height: number;
  data: FlowNodeData;
}

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  type: "topic";
  data: { label: string | null; isnt: boolean };
}

export const NODE_W = 216;
const LINE = 18;
/** Characters of a title on one line at the node's width. */
const PER_LINE = 26;
const ON_MAX = 6;

const KIND: Record<string, string> = {
  term: "Term",
  column: "Column",
  table: "Table",
  guide: "Guide",
  dataset: "Dataset",
  metric: "Metric",
  learning: "How it was learned",
};

const heightOf = (title: string, sub: string | null) =>
  12 + 16 + Math.min(2, Math.ceil(title.length / PER_LINE)) * LINE + (sub ? 16 : 0) + 12;

/** schema.table → the table's name, and its schema for the label. */
const split = (fq: string) => {
  const parts = fq.split(".");
  return { name: parts.at(-1) ?? fq, schema: parts.length > 1 ? parts.slice(0, -1).join(".") : null };
};

export function layoutTopicFlow(graph: TopicGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const term = graph.nodes.find((n) => n.role === "term");
  if (!term) return { nodes: [], edges: [] };
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const tableOf = new Map(graph.edges.filter((e) => e.rel === "PART_OF").map((e) => [e.src, e.dst]));
  // The column a term means and its table are one box: "subscriptions, where status is active".
  const boxOf = (id: string) => (byId.get(id)?.kind === "column" && tableOf.get(id) ? (tableOf.get(id) as string) : id);
  const nodes = new Map<string, FlowNodeData>();
  const put = (id: string, data: Omit<FlowNodeFields, "full"> & { full?: string }) =>
    nodes.set(id, { ...data, full: data.full ?? data.title });

  const href = (n: TopicGraph["nodes"][number]): string | null => {
    switch (n.kind) {
      case "term":
        return `/knowledge/glossary/${n.id}`;
      case "table":
        return n.connectionId ? `/data/sources/${n.connectionId}/catalog?table=${n.id}` : null;
      case "guide":
        return `/knowledge/guides/${n.id}`;
      case "dataset":
        return `/knowledge/datasets/${n.id}`;
      case "metric":
        return `/knowledge/metrics/${n.id}`;
      case "learning":
        return "#how-it-was-learned";
      default:
        return null;
    }
  };

  // Other terms on the same column are named on its box, not drawn: the diagram stays about this one.
  const others = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.rel === "MEANS" && byId.get(e.src)?.role === "sibling") {
      others.set(boxOf(e.dst), [...(others.get(boxOf(e.dst)) ?? []), byId.get(e.src)?.title ?? ""]);
    }
  }
  const withOthers = (id: string, detail: string | null) =>
    others.get(id)?.length ? `${detail ? `${detail}. ` : ""}Other terms on it: ${others.get(id)?.join(", ")}` : detail;
  for (const n of graph.nodes) {
    if (n.role === "sibling") continue;
    if (n.role === "means" && n.kind === "column" && tableOf.get(n.id)) {
      const table = byId.get(tableOf.get(n.id) as string);
      const { name, schema } = split(table?.title ?? n.title);
      const column = n.title.split(".").at(-1) ?? n.title;
      const where = n.detail?.includes("where it's") ? n.detail.split("where it's ")[1] : null;
      put(table?.id ?? n.id, {
        kind: "table",
        label: `What it means${schema ? ` · ${schema}` : ""}`,
        title: name,
        sub: where ? `where ${column} is ${where}` : `its ${column}`,
        full: table?.title ?? n.title,
        detail: withOthers(table?.id ?? n.id, n.detail),
        href: table ? href(table) : null,
        tone: "plain",
      });
      continue;
    }
    if (n.role === "table" || (n.kind === "column" && tableOf.get(n.id))) continue;
    if (n.kind === "table") {
      const { name, schema } = split(n.title);
      put(n.id, {
        kind: "table",
        label: `${n.role === "isnt" ? "Not this table" : "Table"}${schema ? ` · ${schema}` : ""}`,
        title: name,
        sub: null,
        full: n.title,
        detail: n.detail,
        href: href(n),
        tone: n.role === "isnt" ? "isnt" : "plain",
      });
      continue;
    }
    put(n.id, {
      kind: n.kind,
      label: KIND[n.kind] ?? n.kind,
      title: n.title,
      sub: null,
      detail: n.detail,
      href: href(n),
      tone: n.role === "term" ? "term" : n.role === "learned" ? "learned" : "plain",
    });
  }

  // Edges as they read, left to right; what's on a table hangs off it (at most six, then "+N more").
  const edges: FlowEdge[] = [];
  const link = (source: string, target: string, label: string | null = null, isnt = false) => {
    if (
      nodes.has(source) &&
      nodes.has(target) &&
      source !== target &&
      !edges.some((e) => e.source === source && e.target === target)
    ) {
      edges.push({ id: `${source}->${target}`, source, target, type: "topic", data: { label, isnt } });
    }
  };
  const onCount = new Map<string, number>();
  for (const e of graph.edges) {
    const src = byId.get(e.src);
    if (e.rel === "MEANS" && src?.role === "term") link(term.id, boxOf(e.dst), "means");
    else if (e.rel === "IS_NOT") link(term.id, e.dst, "isn't", true);
    else if (e.rel === "ABOUT" && src?.role === "learned") link(e.src, term.id);
    else if ((e.rel === "ABOUT" || e.rel === "DEFINED_ON") && src?.role === "on") {
      const at = boxOf(e.dst);
      const n = (onCount.get(at) ?? 0) + 1;
      onCount.set(at, n);
      if (n <= ON_MAX) link(at, e.src);
      else nodes.delete(e.src);
    }
  }
  for (const [at, n] of onCount) {
    if (n > ON_MAX) {
      const id = `more:${at}`;
      put(id, {
        kind: "more",
        label: "And more",
        title: `${n - ON_MAX} more on this table`,
        sub: null,
        detail: "Listed under On its table, below.",
        href: "#on-its-table",
        tone: "plain",
      });
      link(at, id);
    }
  }
  // A box with nothing joining it (left out above) isn't drawn.
  for (const id of [...nodes.keys()]) {
    if (id !== term.id && !edges.some((e) => e.source === id || e.target === id)) nodes.delete(id);
  }

  const g = new Graph();
  g.setGraph({ rankdir: "LR", nodesep: 22, ranksep: 132, marginx: 8, marginy: 8 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const [id, d] of nodes) g.setNode(id, { width: NODE_W, height: heightOf(d.title, d.sub) });
  for (const e of edges) g.setEdge(e.source, e.target);
  layout(g);
  // "N more on this table" goes last in its column, whatever order dagre chose.
  for (const id of nodes.keys()) {
    if (!id.startsWith("more:")) continue;
    const at = g.node(id);
    const below = [...nodes.keys()]
      .map((other) => ({ other, p: g.node(other) }))
      .filter(({ other, p }) => other !== id && p.x === at.x && p.y > at.y)
      .sort((a, b) => b.p.y - a.p.y)[0];
    if (below) [at.y, below.p.y] = [below.p.y, at.y];
  }
  return {
    nodes: [...nodes.entries()].map(([id, data]) => {
      const p = g.node(id);
      const height = heightOf(data.title, data.sub);
      return {
        id,
        type: "topic" as const,
        position: { x: p.x - NODE_W / 2, y: p.y - height / 2 },
        width: NODE_W,
        height,
        data,
      };
    }),
    edges,
  };
}

/** The drawing's size at zoom 1, for its frame. */
export function extentOf(nodes: FlowNode[]): { width: number; height: number } {
  if (!nodes.length) return { width: 0, height: 0 };
  const right = Math.max(...nodes.map((n) => n.position.x + n.width));
  const bottom = Math.max(...nodes.map((n) => n.position.y + n.height));
  const left = Math.min(...nodes.map((n) => n.position.x));
  const top = Math.min(...nodes.map((n) => n.position.y));
  return { width: right - left, height: bottom - top };
}

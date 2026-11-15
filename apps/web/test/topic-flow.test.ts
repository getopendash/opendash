import type { TopicGraph } from "@opendash/core";
import { describe, expect, it } from "vitest";
import { layoutTopicFlow, NODE_W } from "../lib/topic-flow";

type N = TopicGraph["nodes"][number];
const node = (id: string, kind: N["kind"], role: N["role"], title: string, detail: string | null = null): N => ({
  id,
  kind,
  role,
  title,
  detail,
  connectionId: "c",
  status: "verified",
});

const graph = (extra: Partial<TopicGraph> = {}): TopicGraph => ({
  nodes: [
    node("t", "term", "term", "Paying accounts", "public.memberships where status in ('active')"),
    node("col", "column", "means", "public.memberships.status", "The column it means, where it's active"),
    node("tab", "table", "table", "public.memberships", "The table it means"),
    node("not", "table", "isnt", "public.trial_accounts", "A table it isn't: never read it for this"),
    node("g", "guide", "on", "Canceled memberships", "A guide on public.memberships · released"),
    node("l", "learning", "learned", "Approved", "1 learning · 1 correction by 1 person"),
    ...(extra.nodes ?? []),
  ],
  edges: [
    { rel: "MEANS", src: "t", dst: "col" },
    { rel: "PART_OF", src: "col", dst: "tab" },
    { rel: "IS_NOT", src: "t", dst: "not" },
    { rel: "ABOUT", src: "g", dst: "tab" },
    { rel: "ABOUT", src: "l", dst: "t" },
    ...(extra.edges ?? []),
  ],
});

describe("a topic's diagram", () => {
  it("reads left to right: how it was learned, the term, what it means and isn't, what's on that table", () => {
    const { nodes, edges } = layoutTopicFlow(graph());
    const at = (id: string) => nodes.find((n) => n.id === id);
    // The column and its table are one box: what it means, with its filter.
    expect(at("col")).toBeUndefined();
    expect(at("tab")?.data).toMatchObject({
      label: "What it means · public",
      title: "memberships",
      sub: "where status is active",
      full: "public.memberships",
      href: "/data/sources/c/catalog?table=tab",
    });
    expect(at("not")?.data).toMatchObject({ label: "Not this table · public", title: "trial_accounts", tone: "isnt" });
    const x = (id: string) => at(id)?.position.x ?? Number.NaN;
    expect(x("l")).toBeLessThan(x("t"));
    expect(x("t")).toBeLessThan(x("tab"));
    expect(x("tab")).toBe(x("not"));
    expect(x("tab")).toBeLessThan(x("g"));
    expect(edges.map((e) => [e.source, e.target, e.data.label, e.data.isnt])).toEqual(
      expect.arrayContaining([
        ["t", "tab", "means", false],
        ["t", "not", "isn't", true],
        ["tab", "g", null, false],
        ["l", "t", null, false],
      ]),
    );
    // No two boxes overlap.
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const apart =
          a.position.x + NODE_W <= b.position.x ||
          b.position.x + NODE_W <= a.position.x ||
          a.position.y + a.height <= b.position.y ||
          b.position.y + b.height <= a.position.y;
        expect(apart).toBe(true);
      }
    }
  });

  it("shows six things on a table and counts the rest, and nothing without its term", () => {
    const datasets = Array.from({ length: 8 }, (_, i) => node(`d${i}`, "dataset", "on", `Dataset ${i}`));
    const { nodes } = layoutTopicFlow(
      graph({ nodes: datasets, edges: datasets.map((d) => ({ rel: "DEFINED_ON" as const, src: d.id, dst: "tab" })) }),
    );
    const on = nodes.filter((n) => n.data.kind === "dataset" || n.data.kind === "guide");
    expect(on).toHaveLength(6);
    const more = nodes.find((n) => n.id === "more:tab");
    expect(more?.data.title).toBe("3 more on this table");
    expect(Math.max(...on.map((n) => n.position.y))).toBeLessThan(more?.position.y ?? 0);
    expect(layoutTopicFlow({ nodes: [], edges: [] }).nodes).toEqual([]);
    // Another term on the same column is named on the box it means, not drawn.
    const sibling = layoutTopicFlow(
      graph({
        nodes: [node("t2", "term", "sibling", "Lapsed accounts")],
        edges: [{ rel: "MEANS", src: "t2", dst: "col" }],
      }),
    );
    expect(sibling.nodes.find((n) => n.id === "t2")).toBeUndefined();
    expect(sibling.nodes.find((n) => n.id === "tab")?.data.detail).toBe(
      "The column it means, where it's active. Other terms on it: Lapsed accounts",
    );
  });
});

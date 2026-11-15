import type { SearchKind } from "@opendash/core";

/** Where a search hit opens. */
export function hitHref(h: { kind: SearchKind; id: string; connectionId: string | null }): string {
  switch (h.kind) {
    case "metric":
      return `/knowledge/metrics/${h.id}`;
    case "dataset":
      return `/knowledge/datasets/${h.id}`;
    case "term":
      return `/knowledge/glossary/${h.id}`;
    case "guide":
      return `/knowledge/guides/${h.id}`;
    case "verified_query":
      return `/knowledge/verified/${h.id}`;
    case "skill":
      return `/knowledge/skills/${h.id}`;
    case "table":
      return `/data/sources/${h.connectionId}/catalog?table=${h.id}`;
  }
}

/** What a hit is, in words: "metric", "glossary term". */
export const KIND_LABEL: Record<SearchKind, string> = {
  metric: "metric",
  dataset: "dataset",
  term: "glossary term",
  guide: "guide",
  verified_query: "verified query",
  skill: "skill",
  table: "table",
};

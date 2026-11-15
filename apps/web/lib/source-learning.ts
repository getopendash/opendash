import type { LearningTable } from "@opendash/core";

/** A table's name without its schema: what people call it on the screen (the choose screen's "joins customers"). */
export const shortName = (fq: string) => fq.slice(fq.indexOf(".") + 1);

/** Why a table is where it is on the choose screen: view, size, how often the team reads it, what it joins. */
export function learningWhy(t: LearningTable, first = false, history = true): string {
  const parts = [
    t.kind === "view" ? "View" : null,
    t.rows !== null ? `${Math.round(t.rows).toLocaleString("en-US")} rows` : null,
    // Without a query history, every table would say "not queried": that says nothing about this one.
    t.queries
      ? `read by ${t.queries.toLocaleString("en-US")}${first ? " of your team's queries" : ""}`
      : history
        ? "not queried"
        : null,
    t.joinsTo.length
      ? `joins ${t.joinsTo.slice(0, 2).map(shortName).join(", ")}${t.joinsTo.length > 2 ? "…" : ""}`
      : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * The table the picked ones join to most that isn't picked, and which picked ones join it: "shipments and
 * order_items join orders, which isn't picked". Null when every join stays among the picked tables.
 */
export function alsoLearn(tables: LearningTable[], picked: Set<string>): { table: string; joinedBy: string[] } | null {
  const known = new Set(tables.map((t) => t.name));
  const by = new Map<string, string[]>();
  for (const t of tables) {
    if (!picked.has(t.name)) continue;
    for (const j of t.joinsTo) {
      if (picked.has(j) || !known.has(j)) continue;
      by.set(j, [...(by.get(j) ?? []), t.name]);
    }
  }
  const [best] = [...by.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  return best ? { table: best[0], joinedBy: best[1] } : null;
}

/** "a and b", "a, b and 2 more": the picked tables that join it, by their short names. */
export function joinedByText(names: string[]): string {
  const short = names.map(shortName);
  if (short.length <= 2) return short.join(" and ");
  return `${short.slice(0, 2).join(", ")} and ${short.length - 2} more`;
}

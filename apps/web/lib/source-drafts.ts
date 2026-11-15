import type { DraftCandidate } from "@opendash/core";

/** 1,234 → "1.2k", 18,000,000 → "18M": a table's size at a glance. */
function compact(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, "")}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
  return n.toLocaleString("en-US");
}

/** A table's name without its schema, as the picker says what it joins. */
const short = (name: string) => name.slice(name.lastIndexOf(".") + 1);

/**
 * Why the picker ranks a table where it does, two facts at most: how many of the team's queries read it, how
 * many tables join to it, its size, what it joins. A view says so first; one a dataset covers already says that.
 */
export function candidateWhy(c: DraftCandidate): string {
  const facts = [
    c.queries ? `read by ${c.queries.toLocaleString("en-US")} ${c.queries === 1 ? "query" : "queries"}` : null,
    c.joinedBy ? `${c.joinedBy} ${c.joinedBy === 1 ? "table joins" : "tables join"} to it` : null,
    c.rows !== null ? `${compact(c.rows)} rows` : null,
    c.joins.length
      ? `joins ${short(c.joins[0] as string)}${c.joins.length > 1 ? ` and ${c.joins.length - 1} more` : ""}`
      : null,
  ]
    .filter((f) => f !== null)
    .slice(0, 2);
  const lead = [c.modelled ? "Has a dataset" : null, c.kind === "view" ? "View" : null].filter((f) => f !== null);
  const words = [...lead, ...facts].join(" · ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
}

const money = (n: number) => `$${n.toFixed(2)}`;

/**
 * What a draft over n tables costs at most, said before it runs: the run's cap, from the background budget, and
 * what's left of it this month.
 */
export function draftCapText(
  tables: number,
  cost: { perTableUsd: number; baseUsd: number; leftUsd: number; budgetUsd: number },
): { text: string; over: boolean } {
  if (cost.budgetUsd <= 0) {
    return { text: "Background work is off (its monthly budget is $0), so the draft would be held.", over: true };
  }
  const cap = cost.baseUsd + cost.perTableUsd * Math.max(1, tables);
  const over = cap > cost.leftUsd;
  return {
    text: `At most ${money(cap)} for ${tables} ${tables === 1 ? "table" : "tables"} (the run stops there), from the background budget: ${money(cost.leftUsd)} of ${money(cost.budgetUsd)} left this month.${over ? " That's more than what's left." : ""}`,
    over,
  };
}

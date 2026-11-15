/** Reciprocal rank fusion's constant: k = 60. */
export const RRF_K = 60;

/**
 * Reciprocal rank fusion: each ranked list adds `1 / (60 + rank)` to every key in it. The one way
 * OpenDash ranks a search: the palette's lists (full text, similar names, exact names) and the analyst's
 * `context_search` (the same, and vectors).
 */
export function rrf(lists: string[][]): Map<string, number> {
  const score = new Map<string, number>();
  for (const list of lists) {
    for (const [i, key] of list.entries()) score.set(key, (score.get(key) ?? 0) + 1 / (RRF_K + i + 1));
  }
  return score;
}

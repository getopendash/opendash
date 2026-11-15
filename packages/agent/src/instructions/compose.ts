/**
 * How an agent's prompt is put together: a list of sections, each in the layer of what it changes with.
 *   - agent: the agent's own rules and its database's notes, the same for every run of that agent on that database
 *     (the analyst's in two versions: a source with verified metrics or without);
 *   - source: what the source and the team's definitions hold (catalog, metrics, glossary, guides, other sources);
 *   - question: what belongs to one run (the date, the insight it checks, the week it reviews).
 * The layers are what the prompt cache is built on (harness/cache.ts): the agent layer is the first system block and
 * the source layer the second, each a cache point, and the question layer goes with the run's question, after the
 * cache. Each section carries its own spacing, so a layer is its sections joined as they are, in the order written.
 */
export type Layer = "agent" | "source" | "question";

export interface Section {
  layer: Layer;
  text: string;
}

/** A section of each layer; a falsy one (a conditional left out) is skipped. */
export const part = {
  agent: (text: string): Section => ({ layer: "agent", text }),
  source: (text: string): Section => ({ layer: "source", text }),
  question: (text: string): Section => ({ layer: "question", text }),
};

export type Sections = (Section | false | null | undefined | "")[];

export interface Composed {
  /** Each layer's sections, joined in the order they're written: what the cache holds of each, what budgets measure. */
  layers: Record<Layer, string>;
}

export function compose(sections: Sections): Composed {
  const kept = sections.filter((s): s is Section => typeof s === "object" && s !== null && s.text !== "");
  const of = (layer: Layer) =>
    kept
      .filter((s) => s.layer === layer)
      .map((s) => s.text)
      .join("");
  return { layers: { agent: of("agent"), source: of("source"), question: of("question") } };
}

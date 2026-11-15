/**
 * The source's verified metrics as the prompt lists them (context in the prompt while it fits): each with
 * what it means, how it takes time, and the fields it can be grouped and filtered by. The compiler checks every
 * query against the same model, so the list is a guide, never a promise.
 */
import { type LoadedModel, metricFields, metricFinestGrain, metricTimeColumn } from "@opendash/core";

export function metricsForPrompt(loaded: LoadedModel | null): string {
  if (!loaded) return "";
  const { model } = loaded;
  const lines: string[] = [];
  for (const m of [...model.metrics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const dataset = model.datasets.get(m.dataset);
    if (!dataset) continue;
    const time = metricTimeColumn(m, dataset);
    const finest = metricFinestGrain(m, dataset);
    const fields = metricFields(model, m.name).filter((f) => f.dimension && f.column.type !== "time");
    const optional = dataset.segments.filter((s) => !s.default && !m.segments.includes(s.name)).map((s) => s.name);
    const defaults = dataset.segments.filter((s) => s.default).map((s) => s.name);
    lines.push(
      [
        `- ${m.name} (${m.label}): ${m.description}`,
        `  time: ${time ? `by ${time}${m.default_grain ? `, usually by ${m.default_grain}` : ""}${finest ? `; one value per ${finest}, so never by a shorter grain or range` : ""}${dataset.snapshot ? `; a snapshot: a longer period gives its last ${finest ?? "snapshot"}'s value, never a sum` : ""}` : `the current state${dataset.snapshot ? " (the latest snapshot)" : ""}; no time range, grain or comparison`}`,
        fields.length ? `  by: ${fields.map((f) => f.name).join(", ")}` : null,
        defaults.length
          ? `  always applied unless asked otherwise: ${defaults.join(", ")} (exclude_segments lifts one)`
          : null,
        optional.length ? `  optional segments: ${optional.join(", ")}` : null,
        m.synonyms.length ? `  also called: ${m.synonyms.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return lines.join("\n");
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Whole words or phrases only ("MRR" in "mrr?", not "arr" in "carry"), the plural or the singular. */
const says = (text: string, phrase: string) => {
  const p = phrase.trim().toLowerCase();
  if (p.length < 2) return false;
  return [p, p.replace(/s$/, "")].some((v) => new RegExp(`(^|[^a-z0-9])${literal(v)}s?($|[^a-z0-9])`).test(text));
};

/**
 * The verified metrics a question names, by name, label or synonym ("monthly recurring revenue", "MRR", "churn"): a
 * verified query over one of them is a candidate for the question even when its wording is far from the question's.
 */
export function mentionedMetrics(question: string, loaded: LoadedModel | null): string[] {
  if (!loaded) return [];
  const text = question.toLowerCase();
  return [...loaded.model.metrics.values()]
    .filter((m) => [m.name.replace(/_/g, " "), m.name, m.label, ...m.synonyms].some((p) => says(text, p)))
    .map((m) => m.name);
}

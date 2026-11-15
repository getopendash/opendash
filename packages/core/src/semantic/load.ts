import { buildModel, type SemanticModel } from "./model";
import { DatasetSpec, MetricSpec, parseSpec } from "./spec";

/** A model from authored YAML (a pack, or a source's verified items), or every problem, each naming its item. */
export function modelFromYaml(
  datasets: string[],
  metrics: string[],
): { ok: true; model: SemanticModel } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const parse = <T>(schema: typeof DatasetSpec | typeof MetricSpec, body: string, what: string): T | null => {
    const r = parseSpec(schema, body);
    if (r.ok) return r.spec as T;
    const name = /^(?:ref|name):\s*(\S+)/m.exec(body)?.[1] ?? "?";
    problems.push(...r.problems.map((p) => `${what} ${name}: ${p}`));
    return null;
  };
  const ds = datasets.map((b) => parse<DatasetSpec>(DatasetSpec, b, "Dataset")).filter((d) => d !== null);
  const ms = metrics.map((b) => parse<MetricSpec>(MetricSpec, b, "Metric")).filter((m) => m !== null);
  if (problems.length) return { ok: false, problems };
  return buildModel(ds, ms);
}

/**
 * A semantic model: the datasets and metrics of one source, checked against each other (every name a metric, a
 * segment or a relationship uses exists). The compiler only takes a model that passed. Checking SQL against the
 * source itself (does the dataset run, do its columns exist) is the validation job's, in the worker.
 */
import type { TimeGrain } from "@opendash/connectors";
import type { DatasetSpec, MetricSpec } from "./spec";

export interface SemanticModel {
  datasets: ReadonlyMap<string, DatasetSpec>;
  metrics: ReadonlyMap<string, MetricSpec>;
}

/** The time column a metric ranges and groups by, or null when it's about the current state. */
export function metricTimeColumn(metric: MetricSpec, dataset: DatasetSpec): string | null {
  if (metric.time_column === "none") return null;
  return metric.time_column ?? dataset.time_column ?? null;
}

/** The finest grain a metric can be read at (its time column's, `month` for a month-end snapshot), or null for any. */
export function metricFinestGrain(metric: MetricSpec, dataset: DatasetSpec): TimeGrain | null {
  const column = metricTimeColumn(metric, dataset);
  return (column && dataset.columns.find((c) => c.name === column)?.grain) || null;
}

/** Whether one of a model's metrics has time, as its definition says: a time column of its own or its dataset's. */
export function metricHasTime(model: SemanticModel, name: string): boolean {
  const metric = model.metrics.get(name);
  const dataset = metric ? model.datasets.get(metric.dataset) : undefined;
  return Boolean(metric && dataset && metricTimeColumn(metric, dataset) !== null);
}

function duplicates(names: string[]): string[] {
  return [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
}

/**
 * The definitions as they hold together without what's gone: a relationship to a dataset that isn't there (rejected,
 * deleted) and a metric on one are left out, as answers leave them out, so one removed draft can't break every other
 * definition on its source. `keep` is a definition being checked itself: its own links aren't left out.
 */
export function withoutDangling(
  datasets: DatasetSpec[],
  metrics: MetricSpec[],
  keep?: { kind: "dataset" | "metric"; name: string },
): { datasets: DatasetSpec[]; metrics: MetricSpec[] } {
  const refs = new Set(datasets.map((d) => d.ref));
  return {
    datasets: datasets.map((d) =>
      keep?.kind === "dataset" && keep.name === d.ref
        ? d
        : { ...d, relationships: d.relationships.filter((r) => refs.has(r.to)) },
    ),
    metrics: metrics.filter((m) => (keep?.kind === "metric" && keep.name === m.name) || refs.has(m.dataset)),
  };
}

/** Builds a model, or says everything that's wrong with it. */
export function buildModel(
  datasets: DatasetSpec[],
  metrics: MetricSpec[],
): { ok: true; model: SemanticModel } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  for (const d of duplicates(datasets.map((d) => d.ref))) problems.push(`Two datasets are named ${d}.`);
  for (const m of duplicates(metrics.map((m) => m.name))) problems.push(`Two metrics are named ${m}.`);
  const byRef = new Map(datasets.map((d) => [d.ref, d]));

  for (const d of datasets) {
    const columns = new Map(d.columns.map((c) => [c.name, c]));
    const at = `Dataset ${d.ref}`;
    for (const c of duplicates(d.columns.map((c) => c.name))) problems.push(`${at}: column ${c} is listed twice.`);
    for (const k of d.primary_key) if (!columns.has(k)) problems.push(`${at}: primary key ${k} isn't a column.`);
    if (d.time_column && columns.get(d.time_column)?.type !== "time") {
      problems.push(`${at}: time column ${d.time_column} isn't a time column.`);
    }
    if (d.snapshot && columns.get(d.snapshot.at)?.type !== "time") {
      problems.push(`${at}: snapshot at ${d.snapshot.at} isn't a time column.`);
    } else if (d.snapshot && !columns.get(d.snapshot.at)?.grain) {
      // Snapshots are compared by their period, not their instant: rows written at 09:00:01 and 09:00:02 are one.
      problems.push(
        `${at}: snapshot at ${d.snapshot.at} needs its grain, the period each snapshot is taken for (grain: day or month).`,
      );
    }
    for (const c of d.columns) {
      if (c.grain && c.type !== "time") problems.push(`${at}: ${c.name} has a grain but isn't a time column.`);
    }
    const names = [...d.measures.map((m) => m.name), ...d.segments.map((s) => s.name)];
    for (const n of duplicates(names)) problems.push(`${at}: ${n} is defined twice.`);
    for (const n of names) if (columns.has(n)) problems.push(`${at}: ${n} is both a column and a measure or segment.`);
    for (const r of d.relationships) {
      const target = byRef.get(r.to);
      if (!target) {
        problems.push(`${at}: relates to ${r.to}, which isn't a dataset.`);
        continue;
      }
      for (const [ours, theirs] of Object.entries(r.on)) {
        if (!columns.has(ours)) problems.push(`${at}: the join to ${r.to} uses ${ours}, which isn't a column.`);
        if (!target.columns.some((c) => c.name === theirs)) {
          problems.push(`${at}: the join to ${r.to} uses ${r.to}.${theirs}, which isn't a column.`);
        }
      }
    }
  }

  for (const m of metrics) {
    const at = `Metric ${m.name}`;
    const d = byRef.get(m.dataset);
    if (!d) {
      problems.push(`${at}: there's no dataset ${m.dataset}. Datasets: ${[...byRef.keys()].sort().join(", ")}.`);
      continue;
    }
    if (!d.measures.some((x) => x.name === m.measure)) {
      problems.push(`${at}: ${m.dataset} has no measure ${m.measure}.`);
    }
    for (const s of m.segments) {
      if (!d.segments.some((x) => x.name === s)) problems.push(`${at}: ${m.dataset} has no segment ${s}.`);
    }
    const time = m.time_column;
    if (time && time !== "none" && d.columns.find((c) => c.name === time)?.type !== "time") {
      problems.push(`${at}: ${m.dataset}.${time} isn't a time column.`);
    }
  }

  if (problems.length) return { ok: false, problems };
  return { ok: true, model: { datasets: byRef, metrics: new Map(metrics.map((m) => [m.name, m])) } };
}

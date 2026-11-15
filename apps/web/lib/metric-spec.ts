/** A metric query's spec in words: what it computes, row by row. Pure; shared by client and server. */
export interface MetricSpecLike {
  metrics: string[];
  dimensions?: string[];
  filters?: { field: string; op: string; value?: unknown }[];
  segments?: string[];
  exclude_segments?: string[];
  time?: { grain?: string; range?: string | { from: string; to: string }; compare?: string };
}

const words = (token: string) => token.replace(/_/g, " ");
const value = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

/** [label, value] rows: Metric, By, Period, Compared with, Filters, Segments. `titles` names metrics by slug. */
export function describeSpec(spec: MetricSpecLike, titles: Record<string, string> = {}): [string, string][] {
  const rows: [string, string][] = [
    [spec.metrics.length > 1 ? "Metrics" : "Metric", spec.metrics.map((m) => titles[m] ?? m).join(", ")],
  ];
  const by = [...(spec.time?.grain ? [spec.time.grain] : []), ...(spec.dimensions ?? [])];
  if (by.length) rows.push(["By", by.join(", ")]);
  const range = spec.time?.range;
  if (range)
    rows.push(["Period", typeof range === "string" ? words(range) : `${range.from} to ${range.to} (exclusive)`]);
  if (spec.time?.compare) rows.push(["Compared with", "the period before"]);
  for (const f of spec.filters ?? []) rows.push(["Filter", `${f.field} ${f.op} ${value(f.value)}`.trim()]);
  const segments = [...(spec.segments ?? []), ...(spec.exclude_segments ?? []).map((s) => `not ${s}`)];
  rows.push(["Segments", segments.length ? segments.map(words).join(", ") : "the defaults"]);
  return rows;
}

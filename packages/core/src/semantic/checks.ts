/**
 * Testing definitions against the source's data ("Tested against your data"; anything that
 * touches the customer's database runs in the worker). Every check is a query through the gateway, recorded as a
 * query_run requested by the definition, so the same read-only session, limits and personal-data rules apply.
 *
 * A dataset: it runs, its columns are the ones it declares, its grain is unique, its n:1 joins land on unique keys,
 * and its time column is filled. A metric: its dataset passes, and it compiles and runs. The results go into the
 * version's `derived`, which is all the UI reads.
 */
import { type DialectId, dialectFor } from "@opendash/connectors";
import { sql } from "@opendash/db";
import { type GatewayDeps, type QueryOutcome, runQuery } from "../gateway/gateway";
import { compileMetricQuery, SemanticError } from "./compile";
import { buildModel, metricFinestGrain, metricTimeColumn, withoutDangling } from "./model";
import { DatasetSpec, MetricSpec } from "./spec";

export interface DefinitionCheck {
  name: string;
  status: "passed" | "warn" | "failed";
  detail?: string;
}

/** What the checks found for one version: `passed` (Tests passed), `needs_review` (a warning), or `failed`. */
export interface DefinitionDerived {
  status: "passed" | "needs_review" | "failed";
  checks: DefinitionCheck[];
  /** Datasets: how many rows it has. Metrics: its latest value, as checked. */
  rows?: number;
  /** Datasets: the catalog tables it reads (`schema.table`), from the gateway's analysis of it. */
  tables?: string[];
  sample?: {
    /** "Last month" for a metric over time, "Now" for a current state. */
    label: string;
    /** The period it's for (2026-09-01), when the metric has time. */
    period?: string;
    value: number | string | null;
    /** The period before's value, for the change. */
    previous?: number | string | null;
  };
  /** A metric over time: its value for each of the last twelve whole months. */
  trend?: { period: string; value: number | string | null }[];
  checkedAt: string;
}

const MATCHES: Record<DatasetSpec["columns"][number]["type"], (t: string) => boolean> = {
  number: (t) => t === "number",
  string: (t) => t === "text",
  boolean: (t) => t === "boolean",
  time: (t) => t === "timestamp" || t === "date",
};

const plural = (n: number, one: string) => `${n.toLocaleString("en-US")} ${n === 1 ? one : `${one}s`}`;
const overall = (checks: DefinitionCheck[]): DefinitionDerived["status"] =>
  checks.some((c) => c.status === "failed")
    ? "failed"
    : checks.some((c) => c.status === "warn")
      ? "needs_review"
      : "passed";

/**
 * Checks a source's definitions at their current versions: the ones not tested yet and the metrics on a dataset that
 * changed, or all of them (`all`), or only these (`only`, by id, with the metrics on a dataset among them): a drafting
 * call tests what it wrote, never what a parallel one did. Returns how many were checked.
 */
export async function checkDefinitions(
  deps: GatewayDeps,
  job: { orgId: string; connectionId: string },
  options: { now?: Date; all?: boolean; only?: string[]; signal?: AbortSignal } = {},
): Promise<number> {
  const { rows, dialect } = await deps.withTenant(job.orgId, async (tx) => {
    const [c] = await tx.execute<{ dialect: DialectId; name: string }>(sql`
      select dialect, name from app.connection
      where org_id = ${job.orgId} and id = ${job.connectionId} and deleted_at is null`);
    const items = await tx.execute<{
      id: string;
      kind: "dataset" | "metric";
      version: number;
      spec: unknown;
      derived: DefinitionDerived | null;
      unreleased: boolean;
      released_spec: unknown;
      released_derived: DefinitionDerived | null;
    }>(sql`
      select i.id, i.kind, i.current_version as version, v.spec, v.derived,
        i.released_version is distinct from i.current_version as unreleased,
        rv.spec as released_spec, rv.derived as released_derived
      from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      -- A version waiting over a released one: the released one too, for the released metrics on it.
      left join app.context_item_version rv on rv.org_id = i.org_id and rv.item_id = i.id
        and rv.version = i.released_version and i.released_version <> i.current_version
      where i.org_id = ${job.orgId} and i.connection_id = ${job.connectionId} and i.deleted_at is null
        and i.status <> 'deprecated' and i.kind in ('dataset', 'metric')`);
    return { rows: items, dialect: c?.dialect };
  });
  if (!dialect || !rows.length) return 0;
  const b = dialectFor(dialect).sql;
  const datasets = rows.filter((r) => r.kind === "dataset").map((r) => ({ row: r, spec: DatasetSpec.parse(r.spec) }));
  const metrics = rows.filter((r) => r.kind === "metric").map((r) => ({ row: r, spec: MetricSpec.parse(r.spec) }));
  const byRef = new Map(datasets.map((d) => [d.spec.ref, d.spec]));
  const results = new Map<string, DefinitionDerived>();
  // What to test: versions not tested yet, and the metrics on a dataset that changed (unless asked for all, or for these).
  const only = options.only ? new Set(options.only) : null;
  const mine = (r: (typeof rows)[number]) => !only || only.has(r.id);
  const changed = new Set(
    datasets.filter((d) => mine(d.row) && (options.all || only || !d.row.derived)).map((d) => d.spec.ref),
  );
  const due = (r: (typeof rows)[number], datasetRef?: string) =>
    only
      ? only.has(r.id) || (datasetRef !== undefined && changed.has(datasetRef))
      : options.all || !r.derived || (datasetRef !== undefined && changed.has(datasetRef));
  const at = (options.now ?? new Date()).toISOString();

  // A dataset version not released yet (a draft, an edit) is held to its database's advice, as SQL the model writes
  // is: a ReplacingMergeTree read without FINAL fails its first check, with the fix. A released one's
  // retest isn't: an admin approved it, and its metrics run as compiled.
  const advised = new Set(rows.filter((r) => r.kind === "dataset" && r.unreleased).map((r) => r.id));
  // A caller that stops (a drafting run out of time) stops the checks: each query takes its signal, and no new one starts.
  const run = (itemId: string, title: string, text: string): Promise<QueryOutcome> => {
    options.signal?.throwIfAborted();
    return runQuery(deps, {
      orgId: job.orgId,
      connectionId: job.connectionId,
      sql: text,
      mode: "execute",
      title,
      requester: { type: "definition", id: itemId },
      ...(advised.has(itemId) ? { advise: true } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  };
  const cell = (r: QueryOutcome, column = 0) => Number(r.rows[0]?.[column] ?? Number.NaN);

  for (const { row, spec: d } of datasets) {
    if (!due(row)) continue;
    const checks: DefinitionCheck[] = [];
    const cte = (ref: string, s: DatasetSpec) => `with ${b.ident(ref)} as (\n${s.sql.trim().replace(/;\s*$/, "")}\n)`;
    const data = cte("d", d);
    const counted = await run(row.id, `Check · ${d.ref} · rows`, `${data}\nselect count(*) as n from ${b.ident("d")}`);
    if (counted.status !== "succeeded") {
      checks.push({ name: "Runs on your data", status: "failed", detail: counted.error?.message ?? "It didn't run." });
      results.set(row.id, { status: "failed", checks, checkedAt: at });
      continue;
    }
    const total = cell(counted);
    checks.push({ name: "Runs on your data", status: "passed", detail: plural(total, "row") });

    const cols = d.columns.map((c) => b.ident(c.name)).join(", ");
    const shape = await run(
      row.id,
      `Check · ${d.ref} · columns`,
      `${data}\nselect ${cols} from ${b.ident("d")} limit 1`,
    );
    if (shape.status !== "succeeded") {
      checks.push({ name: "Columns are as declared", status: "failed", detail: shape.error?.message ?? "" });
    } else {
      const wrong = d.columns.filter((c, i) => {
        const t = shape.columns[i]?.type;
        return t !== undefined && t !== "other" && !MATCHES[c.type](t);
      });
      checks.push({
        name: "Columns are as declared",
        status: wrong.length ? "warn" : "passed",
        detail: wrong.length
          ? `${wrong.map((c) => c.name).join(", ")} ${wrong.length === 1 ? "has" : "have"} another type`
          : `${d.columns.length} of ${d.columns.length}`,
      });
    }

    const key = d.primary_key.map((k) => b.ident(k)).join(", ");
    const dupes = await run(
      row.id,
      `Check · ${d.ref} · grain`,
      `${data}\nselect count(*) as n from (select ${key} from ${b.ident("d")} group by ${key} having count(*) > 1) as x`,
    );
    const duplicated = cell(dupes);
    checks.push(
      dupes.status !== "succeeded"
        ? { name: "Grain is unique", status: "failed", detail: dupes.error?.message ?? "" }
        : duplicated === 0
          ? { name: "Grain is unique", status: "passed", detail: plural(total, "row") }
          : { name: "Grain is unique", status: "failed", detail: `${plural(duplicated, "key")} repeat` },
    );

    const joins = d.relationships.filter((r) => r.type !== "1:n" && byRef.has(r.to));
    let joinsOk = 0;
    const joinProblems: string[] = [];
    for (const r of joins) {
      const target = byRef.get(r.to) as DatasetSpec;
      const idents = Object.values(r.on).map((k) => b.ident(k));
      const keys = idents.join(", ");
      // Rows without a key (NULL) match nothing, so they can't count a row twice: only keys that repeat do.
      const present = idents.map((k) => `${k} is not null`).join(" and ");
      const out = await run(
        row.id,
        `Check · ${d.ref} → ${r.to}`,
        `${cte("t", target)}\nselect count(*) as n from (select ${keys} from ${b.ident("t")} where ${present} group by ${keys} having count(*) > 1) as x`,
      );
      if (out.status === "succeeded" && cell(out) === 0) joinsOk += 1;
      else joinProblems.push(r.to);
    }
    if (joins.length) {
      checks.push({
        name: "Joins are many-to-one",
        status: joinProblems.length ? "failed" : "passed",
        detail: joinProblems.length
          ? `${joinProblems.join(", ")} repeats its key, so joining it would count rows twice`
          : `${joinsOk} of ${joins.length}`,
      });
    }

    // Joins match: most of a join's keys are found on the other side, or grouping by its fields drops rows.
    // One-column joins, over at most 10,000 of the dataset's keys; below 95% it's a warning, with the share.
    const single = d.relationships.filter((r) => r.type !== "1:n" && byRef.has(r.to) && Object.keys(r.on).length === 1);
    if (single.length) {
      const shares: { to: string; share: number }[] = [];
      const unchecked: string[] = [];
      for (const r of single) {
        const target = byRef.get(r.to) as DatasetSpec;
        const [ours, theirs] = Object.entries(r.on)[0] as [string, string];
        const out = await run(
          row.id,
          `Check · ${d.ref} → ${r.to} · keys found`,
          `${data},
${b.ident("t")} as (
${target.sql.trim().replace(/;\s*$/, "")}
)
select count(*) as n, sum(case when ${b.ident("k")} in (select ${b.ident(theirs)} from ${b.ident("t")}) then 1 else 0 end) as found
from (select ${b.ident(ours)} as ${b.ident("k")} from ${b.ident("d")} where ${b.ident(ours)} is not null limit 10000) as x`,
        );
        const keys = cell(out);
        if (out.status !== "succeeded") {
          unchecked.push(
            `${r.to} couldn't be checked${out.error?.message ? ` (${out.error.message.slice(0, 160)})` : ""}`,
          );
        } else if (keys > 0) shares.push({ to: r.to, share: cell(out, 1) / keys });
        else unchecked.push(`${r.to} has no keys to check: ${ours} is always empty`);
      }
      const low = shares.filter((s) => s.share < 0.95);
      const problems = [...low.map((s) => `${Math.round(s.share * 100)}% of its keys are in ${s.to}`), ...unchecked];
      checks.push({
        name: "Joins match",
        status: problems.length ? "warn" : "passed",
        detail: problems.length ? problems.join("; ") : `${shares.length} of ${single.length}`,
      });
    }

    if (d.time_column) {
      const filled = await run(
        row.id,
        `Check · ${d.ref} · ${d.time_column}`,
        `${data}\nselect count(${b.ident(d.time_column)}) as n from ${b.ident("d")}`,
      );
      const share = total ? cell(filled) / total : 1;
      checks.push({
        name: `${d.time_column} is filled`,
        status: filled.status !== "succeeded" ? "failed" : share >= 0.95 ? "passed" : "warn",
        detail: `${Math.round(share * 100)}%`,
      });
    }
    results.set(row.id, { status: overall(checks), checks, rows: total, tables: counted.tables ?? [], checkedAt: at });
  }

  // Built as the definitions hold together: a link to a dataset that's gone doesn't fail every metric.
  const modelOf = (specs: DatasetSpec[]) => {
    const whole = withoutDangling(
      specs,
      metrics.map((m) => m.spec),
    );
    return buildModel(whole.datasets, whole.metrics);
  };
  const latest = modelOf(datasets.map((d) => d.spec));
  // A released metric is tested as Ask answers it, on its dataset's released version: a dataset's draft (the
  // analyst's, an edit) never changes the figures of a metric already released (Home's tiles, its page), only its own.
  const releasedSpec = (d: (typeof datasets)[number]) =>
    d.row.unreleased && d.row.released_spec ? DatasetSpec.parse(d.row.released_spec) : null;
  const asReleased = modelOf(datasets.map((d) => releasedSpec(d) ?? d.spec));
  for (const { row, spec: m } of metrics) {
    if (!due(row, m.dataset)) continue;
    const onDataset = datasets.find((d) => d.spec.ref === m.dataset);
    const released = !row.unreleased && onDataset ? releasedSpec(onDataset) : null;
    // Its dataset's draft is all that changed: it reads the released dataset as before.
    if (released && row.derived && !options.all && !only?.has(row.id)) continue;
    const built = released ? asReleased : latest;
    const checks: DefinitionCheck[] = [];
    const dataset = onDataset ? { spec: released ?? onDataset.spec } : undefined;
    const datasetStatus = onDataset
      ? released
        ? onDataset.row.released_derived?.status
        : (results.get(onDataset.row.id) ?? onDataset.row.derived)?.status
      : undefined;
    checks.push({
      name: "Its dataset passes",
      status: datasetStatus === "passed" ? "passed" : datasetStatus === "needs_review" ? "warn" : "failed",
      detail: m.dataset,
    });
    if (!built.ok) {
      checks.push({ name: "Compiles", status: "failed", detail: built.problems.join(" ") });
      results.set(row.id, { status: "failed", checks, checkedAt: at });
      continue;
    }
    const timed = dataset ? metricTimeColumn(m, dataset.spec) !== null : false;
    // Read by month, or by its own grain when that's longer (a quarterly snapshot can't be read by month).
    const finest = dataset ? metricFinestGrain(m, dataset.spec) : null;
    const by = finest === "quarter" || finest === "year" ? finest : "month";
    const test = {
      month: { range: "last_12_months", months: 1, label: "Last month" },
      quarter: { range: "last_8_quarters", months: 3, label: "Last quarter" },
      year: { range: "last_5_years", months: 12, label: "Last year" },
    }[by];
    let compiled: ReturnType<typeof compileMetricQuery> | null = null;
    try {
      compiled = compileMetricQuery(
        built.model,
        {
          metrics: [m.name],
          // A year of whole months: the latest value, the one before, and the trend Home's tiles draw.
          ...(timed ? { time: { grain: by, range: test.range } } : {}),
        },
        { now: options.now ?? new Date(), sql: b },
      );
      checks.push({ name: "Compiles", status: "passed" });
    } catch (error) {
      checks.push({
        name: "Compiles",
        status: "failed",
        detail: error instanceof SemanticError ? error.message : String(error),
      });
    }
    let sample: DefinitionDerived["sample"];
    let trend: DefinitionDerived["trend"];
    if (compiled) {
      options.signal?.throwIfAborted();
      const out = await runQuery(deps, {
        orgId: job.orgId,
        connectionId: job.connectionId,
        sql: compiled.sql,
        params: compiled.params,
        mode: "execute",
        title: `Check · ${m.name}`,
        requester: { type: "definition", id: row.id },
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (out.status === "succeeded") {
        const col = (name: string) => out.columns.findIndex((c) => c.name === name);
        const value = (row: unknown[] | undefined) => (row?.[col(m.name)] ?? null) as number | string | null;
        if (timed && compiled.grain) {
          const month = (row: unknown[] | undefined) => String(row?.[col(by)] ?? "").slice(0, 10);
          trend = out.rows.map((r) => ({ period: month(r), value: value(r) }));
          const last = out.rows.at(-1);
          const before = out.rows.at(-2);
          // The one before is the previous period only if no period is missing between them.
          const expected = last ? new Date(`${month(last)}T00:00:00Z`) : null;
          expected?.setUTCMonth(expected.getUTCMonth() - test.months);
          const adjacent = before && expected && month(before) === expected.toISOString().slice(0, 10);
          sample = {
            label: test.label,
            ...(last ? { period: month(last) } : {}),
            value: value(last),
            previous: adjacent ? value(before) : null,
          };
        } else {
          sample = { label: "Now", value: value(out.rows[0]) };
        }
        checks.push({
          name: "Runs on your data",
          status: "passed",
          ...(out.durationMs !== null ? { detail: `${out.durationMs} ms` } : {}),
        });
      } else {
        checks.push({ name: "Runs on your data", status: "failed", detail: out.error?.message ?? "" });
      }
    }
    results.set(row.id, {
      status: overall(checks),
      checks,
      ...(sample ? { sample } : {}),
      ...(trend ? { trend } : {}),
      checkedAt: at,
    });
  }

  await deps.withTenant(job.orgId, async (tx) => {
    for (const r of rows) {
      const derived = results.get(r.id);
      if (!derived) continue;
      await tx.execute(sql`
        update app.context_item_version set derived = ${JSON.stringify(derived)}::jsonb
        where org_id = ${job.orgId} and item_id = ${r.id} and version = ${r.version}`);
    }
  });
  return results.size;
}

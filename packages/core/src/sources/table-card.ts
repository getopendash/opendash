/**
 * How a table is described, in one wording for the analyst's prompt, a table's file and the Catalog page: what the
 * analyst knows about a table, people can see. Pure: callers load the catalog rows and the datasets.
 */
import { type BuildInfo, baseEngine } from "@opendash/connectors";

/**
 * What a table's engine means for reading it, or null when it reads as stored: its name (with the columns it works
 * by) and what to do. Merges happen in the background, so until then a ReplacingMergeTree keeps every version of a
 * row, and a Summing or Collapsing one keeps the parts.
 */
export function engineInfo(build: BuildInfo | null | undefined): { name: string; hint: string } | null {
  const engine = build?.engine;
  if (!engine) return null;
  const [first, second] = build?.engineColumns ?? [];
  switch (baseEngine(engine)) {
    case "ReplacingMergeTree":
      return {
        name: `${engine}${first ? ` by ${first}` : ""}`,
        hint: `A row is replaced by its newest version only when parts merge, so a key can repeat${second ? ` and rows marked ${second} stay` : ""} until then. Read it with FINAL (from t FINAL, or from t AS x FINAL: after its alias) to count each key once`,
      };
    case "CollapsingMergeTree":
    case "VersionedCollapsingMergeTree": {
      const sign = first ?? "sign";
      return {
        name: `${engine} by ${sign}`,
        hint: `Rows cancel out in pairs by ${sign} (1 and -1) only when parts merge. Count with sum(${sign}), add a measure up as sum(x * ${sign}), and keep keys with having sum(${sign}) > 0`,
      };
    }
    case "SummingMergeTree":
      return {
        name: engine,
        hint: "Rows with the same sorting key are added together only when parts merge. Always aggregate it, with sum() by its key",
      };
    case "AggregatingMergeTree":
      return {
        name: engine,
        hint: "Holds aggregate states, not values. Read them with -Merge functions (countMerge, sumMerge, uniqMerge) grouped by its sorting key",
      };
    case "Null":
      return { name: engine, hint: "Holds no rows; what's written to it only feeds materialized views" };
    default:
      return null;
  }
}

/** The engine, as one line for the analyst: `ReplacingMergeTree by version: A row is replaced …`. */
export function engineHint(build: BuildInfo | null | undefined): string | null {
  const info = engineInfo(build);
  return info ? `${info.name}: ${info.hint}` : null;
}

/** Its keys: Postgres's and MySQL's unique key, or ClickHouse's sorting, primary and partition keys (not unique). */
export function keysLine(build: BuildInfo | null | undefined, primaryKey: string[]): string | null {
  const parts: string[] = [];
  if (build?.sortingKey) parts.push(`sorted by ${build.sortingKey}`);
  if (build?.primaryKey && build.primaryKey !== build.sortingKey) parts.push(`primary key ${build.primaryKey}`);
  if (build?.partitionKey) parts.push(`partitioned by ${build.partitionKey}`);
  if (!parts.length && primaryKey.length) parts.push(`unique key ${primaryKey.join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}

/** What a view (or materialized view) reads. */
export function readsLine(build: BuildInfo | null | undefined): string | null {
  const reads = build?.reads ?? [];
  return reads.length ? `reads ${reads.map((r) => `${r.schema}.${r.name}`).join(", ")}` : null;
}

export interface JoinTarget {
  schema: string;
  table: string;
  column: string;
  declared?: boolean;
  /** The share of the column's sampled values found in the target (0–1), when the join was checked on the data. */
  overlap?: number;
}

/**
 * A column's join, as `→ crm.organizations.id (98% of values match)`; a partial one as `partly → …`. `also` adds a
 * note in the same parentheses (how often the team reads both).
 */
export function joinLabel(j: JoinTarget, partial = false, also?: string): string {
  const how = j.declared
    ? "declared"
    : j.overlap !== undefined
      ? `${Math.max(1, Math.round(j.overlap * 100))}% of values match`
      : null;
  const notes = [how, also].filter(Boolean).join("; ");
  return `${partial ? "partly " : ""}→ ${j.schema}.${j.table}.${j.column}${notes ? ` (${notes})` : ""}`;
}

/** A dataset over the table: what the semantic layer says one row is, and when to use it. */
export interface ModelledAs {
  /** The dataset's knowledge item, when known (the Catalog page links to it). */
  id?: string;
  ref: string;
  label: string;
  status: string;
  grain: string;
  description: string | null;
  usageGuidance: string | null;
  snapshot: boolean;
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** `Modelled as mrr_monthly, a snapshot (…): one row per … . Use for MRR …` */
export function modelledLine(m: ModelledAs): string {
  const head = `Modelled as ${m.ref}${m.status === "verified" ? "" : ` (${m.status})`}${m.snapshot ? ", a snapshot (a longer period reads its last)" : ""}`;
  const grain = clip(m.grain, 160).replace(/\.$/, "");
  const more = m.usageGuidance ? clip(m.usageGuidance, 280) : m.description ? clip(m.description, 200) : null;
  const body = [grain, more].filter(Boolean).join(". ");
  return body ? `${head}: ${body}` : head;
}

/**
 * The datasets built over each table, by `schema.table`: the first table each reads in its latest check
 * (`derived.tables`, in the order its SQL names them). A table it only joins (accounts, to leave test accounts out)
 * isn't what it models.
 */
export function modelsByTable(
  datasets: { id?: string; ref: string; label: string; status: string; spec: unknown; tables: string[] | null }[],
): Map<string, ModelledAs[]> {
  const out = new Map<string, ModelledAs[]>();
  for (const d of datasets) {
    const spec = (d.spec ?? {}) as {
      grain?: string;
      description?: string;
      usage_guidance?: string;
      snapshot?: unknown;
    };
    const m: ModelledAs = {
      ...(d.id ? { id: d.id } : {}),
      ref: d.ref,
      label: d.label,
      status: d.status,
      grain: spec.grain ?? "",
      description: spec.description ?? null,
      usageGuidance: spec.usage_guidance ?? null,
      snapshot: Boolean(spec.snapshot),
    };
    const main = d.tables?.[0]?.toLowerCase();
    if (main) out.set(main, [...(out.get(main) ?? []), m]);
  }
  return out;
}

/** A column as the shape hints read it. */
export interface ShapeColumn {
  name: string;
  type: string | null;
  roles: string[];
}

const DATE_TYPE = /^(date|date32|nullable\(date|timestamp|datetime|nullable\(datetime)/i;
const SNAPSHOT_NAME = /^(snapshot|as_of|day|date|month|week|period)(_date|_day|_at|_month)?$|_snapshot$/i;
const NAME_COLUMN = /^(metric|metric_name|metric_key|kpi|measure|attribute|property|field|key|name)$/i;
const VALUE_COLUMN = /^(value|metric_value|val|amount|count|number)$/i;
const NUMBER_TYPE = /^(nullable\()?(u?int|float|decimal|numeric|double|real|bigint|integer|smallint)/i;

/** A key's columns: `org_id, toDate(created_at)` → org_id, created_at. */
const keyColumns = (key: string | undefined) =>
  (key ?? "")
    .split(",")
    .map((k) => k.trim().replace(/^\w+\((\w+)\)$/, "$1"))
    .filter(Boolean);

/**
 * What a table's shape suggests to whoever models it (the Modeler's brief): that its rows may be snapshots (a key of
 * an entity and a date), or that it holds figures by name (a name column beside a value column). Hints, never facts:
 * the drafting agent checks them on the data.
 */
export function shapeHints(t: { columns: ShapeColumn[]; build: BuildInfo | null; primaryKey: string[] }): string[] {
  const hints: string[] = [];
  const keys = [...new Set([...keyColumns(t.build?.sortingKey), ...keyColumns(t.build?.primaryKey), ...t.primaryKey])];
  const dated = t.columns.filter(
    (c) => SNAPSHOT_NAME.test(c.name) && (DATE_TYPE.test(c.type ?? "") || c.roles.includes("time")),
  );
  const at = dated.find((c) => keys.includes(c.name)) ?? (keys.length ? undefined : dated[0]);
  const entity = keys.filter((k) => k !== at?.name);
  if (at && (entity.length || !keys.length)) {
    hints.push(
      `It may be a snapshot: ${entity.length ? `its key is ${entity.join(", ")} and ${at.name}, so each row may be ${entity.join(", ")}'s state on that ${at.name}` : `${at.name} may date each row's state`}. If so, the dataset says snapshot: { at: ${at.name} }, with ${at.name}'s grain (day or month); if each row is an event that adds up, it isn't one.`,
    );
  }
  const named = t.columns.find((c) => NAME_COLUMN.test(c.name) && !NUMBER_TYPE.test(c.type ?? ""));
  const value = t.columns.find((c) => VALUE_COLUMN.test(c.name) && NUMBER_TYPE.test(c.type ?? ""));
  if (named && value) {
    hints.push(
      `It may hold figures by name: each ${named.name} is its own figure in ${value.name}. Draft one measure per ${named.name} that matters (its ${value.name} where ${named.name} = '…', found with value_lookup), never one measure over all of them.`,
    );
  }
  return hints;
}

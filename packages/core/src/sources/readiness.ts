/**
 * The readiness score: how ready a source is to answer questions,
 * out of 100, for admins. Five parts with equal weight, each with what to do next:
 *
 * - the most-used tables (the team's ten most-queried; without a query history, the ten largest) covered by verified
 *   datasets;
 * - verified metrics, against five;
 * - the value index over the columns that can have one;
 * - verified queries, against ten;
 * - the latest eval run's pass rate on this source's questions.
 *
 * "Verified" is what the analyst uses: a definition with a released version, at that version.
 */
import { sql, type TenantTx } from "@opendash/db";
import { learningChoice } from "./learning";

export const READINESS_TABLES = 10;
export const READINESS_METRICS = 5;
export const READINESS_QUERIES = 10;

export type ReadinessKey = "coverage" | "metrics" | "profiled" | "queries" | "evals";
/** `sync`: a sync indexes values and tests every definition again (refreshDefinitionChecks), so it fixes both. */
export type ReadinessAction =
  | "verify_dataset"
  | "verify_metrics"
  | "verify_queries"
  | "sync"
  | "learn"
  | "add_evals"
  | "run_evals";

export interface ReadinessPart {
  key: ReadinessKey;
  label: string;
  /** 0 to 1. */
  score: number;
  /** What it counts: "3 of 10 most-used tables". */
  detail: string;
  /** What would raise it, or null when it's full. */
  next: { action: ReadinessAction; label: string; table?: string } | null;
}

export interface Readiness {
  /** 0 to 100, the parts' mean. */
  score: number;
  parts: ReadinessPart[];
  /** Whether the tables part was ranked by the team's own queries (else by size). */
  history: boolean;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const ratio = (have: number, of: number) => (of > 0 ? Math.min(have, of) / of : 0);
/** "2 of 5", or "13 verified" once the aim is reached. */
const against = (have: number, aim: number) =>
  have >= aim ? `${have.toLocaleString("en-US")} verified` : `${have} of ${aim}`;

export async function sourceReadiness(tx: TenantTx, orgId: string, connectionId: string): Promise<Readiness> {
  // Key tables are the ones the choose screen ranks first: the most used, else the most joined, then the
  // largest; an archive nobody joins never counts as key.
  const ranked = (await learningChoice(tx, orgId, connectionId))?.tables ?? [];
  const history = ranked.some((t) => t.queries > 0);
  const key = (history ? ranked.filter((t) => t.queries > 0) : ranked).slice(0, READINESS_TABLES);
  const profiledRows = key.length
    ? await tx.execute<{ fq_name: string }>(sql`
        select fq_name from app.catalog_object
        where org_id = ${orgId} and connection_id = ${connectionId} and kind in ('table', 'view') and removed_at is null
          and profile ? 'method' and fq_name in (${sql.join(
            key.map((t) => sql`${t.name}`),
            sql`, `,
          )})`)
    : [];
  const profiledSet = new Set(profiledRows.map((r) => r.fq_name));
  const tables = key.map((t) => ({
    fq_name: t.name,
    usage: t.queries,
    learn: t.learned,
    profiled: profiledSet.has(t.name),
  }));

  const verified = await tx.execute<{ kind: string; tables: string[] | null }>(sql`
    select i.kind, v.derived->'tables' as tables from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    where i.org_id = ${orgId} and i.connection_id = ${connectionId} and i.released_version is not null
      and i.deleted_at is null and i.kind in ('dataset', 'metric', 'verified_query')`);
  const datasets = verified.filter((d) => d.kind === "dataset");
  const covered = new Set(datasets.flatMap((d) => (d.tables ?? []).map((t) => t.toLowerCase())));
  const unmeasured = datasets.filter((d) => !d.tables).length;
  const coveredTables = tables.filter((t) => covered.has(t.fq_name.toLowerCase()));
  const uncovered = tables.find((t) => !covered.has(t.fq_name.toLowerCase()));
  const metrics = verified.filter((d) => d.kind === "metric").length;
  const queries = verified.filter((d) => d.kind === "verified_query").length;

  // Learned: picked to learn, so its stats, roles, joins and sensitivity are read on every sync (no values
  // are kept). A key table not learned is the next step; one learned but not profiled yet waits for a sync.
  const learned = tables.filter((t) => t.learn).length;
  const unlearned = tables.find((t) => !t.learn);
  const waiting = tables.some((t) => t.learn && !t.profiled);

  const [cases] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.eval_case
    where org_id = ${orgId} and connection_id = ${connectionId} and active`);
  // The latest finished run that checked any of this source's questions, counting only those.
  const [latest] = await tx.execute<{ passed: number; done: number }>(sql`
    with latest as (
      select r.id from app.eval_run r
      where r.org_id = ${orgId} and r.status = 'done' and exists (
        select 1 from app.eval_result x
        join app.eval_case c on c.org_id = x.org_id and c.id = x.case_id and c.connection_id = ${connectionId}
        where x.org_id = r.org_id and x.eval_run_id = r.id)
      order by r.finished_at desc nulls last, r.id desc limit 1)
    select (count(*) filter (where x.verdict = 'pass'))::int as passed, count(*)::int as done
    from latest l
    join app.eval_result x on x.org_id = ${orgId} and x.eval_run_id = l.id
    join app.eval_case c on c.org_id = x.org_id and c.id = x.case_id and c.connection_id = ${connectionId}`);
  const evals = { cases: cases?.n ?? 0, passed: latest?.passed ?? 0, done: latest?.done ?? 0 };

  const rankedBy = history ? "most-used" : "key";
  const parts: ReadinessPart[] = [
    {
      key: "coverage",
      label: "Key tables have verified datasets",
      score: ratio(coveredTables.length, tables.length),
      detail: tables.length
        ? `${coveredTables.length} of ${plural(tables.length, `${rankedBy} table`)}`
        : "No tables learned yet",
      next: unmeasured
        ? {
            action: "sync",
            label: `Sync now to see which tables ${plural(unmeasured, "dataset")} ${unmeasured === 1 ? "covers" : "cover"}`,
          }
        : uncovered
          ? { action: "verify_dataset", label: `Verify a dataset over ${uncovered.fq_name}`, table: uncovered.fq_name }
          : null,
    },
    {
      key: "metrics",
      label: "Verified metrics",
      score: ratio(metrics, READINESS_METRICS),
      detail: against(metrics, READINESS_METRICS),
      next:
        metrics < READINESS_METRICS
          ? { action: "verify_metrics", label: `Verify ${plural(READINESS_METRICS - metrics, "more metric")}` }
          : null,
    },
    {
      key: "profiled",
      label: "Key tables learned",
      score: ratio(learned, tables.length),
      detail: tables.length ? `${learned} of ${plural(tables.length, `${rankedBy} table`)}` : "No tables learned yet",
      next: unlearned
        ? { action: "learn", label: `Learn ${unlearned.fq_name}`, table: unlearned.fq_name }
        : waiting
          ? { action: "sync", label: "Sync now to profile the rest" }
          : null,
    },
    {
      key: "queries",
      label: "Verified queries",
      score: ratio(queries, READINESS_QUERIES),
      detail: against(queries, READINESS_QUERIES),
      next:
        queries < READINESS_QUERIES
          ? {
              action: "verify_queries",
              label: `Verify ${plural(READINESS_QUERIES - queries, "more query", "more queries")}`,
            }
          : null,
    },
    {
      key: "evals",
      label: "Eval questions pass",
      score: evals.done ? evals.passed / evals.done : 0,
      detail: !evals.cases
        ? "No eval questions for this source yet"
        : evals.done
          ? `${evals.passed} of ${plural(evals.done, "check")} passed in the latest run`
          : "Not run yet",
      next: !evals.cases
        ? { action: "add_evals", label: "Add eval questions" }
        : !evals.done || evals.passed < evals.done
          ? { action: "run_evals", label: evals.done ? "Fix what failed, then run evals again" : "Run evals" }
          : null,
    },
  ];
  return {
    score: Math.round((parts.reduce((n, p) => n + p.score, 0) / parts.length) * 100),
    parts,
    history,
  };
}

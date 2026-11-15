/**
 * One metric check (the `metric.check` job): a watched metric read once for its period, however many
 * routines watch it, through the gateway (so every value is a query-run cell). Its last whole week or month is judged:
 * freshness first (the metric's own period), then an unusual value, any line a routine drew (its own period too),
 * and on months a trend that shifted and its goals. A metric read by week has a month check as well when a routine
 * asks for what's unusual: this week's news, and this month's.
 * Each finding is filed once as an insight, and the routines whose condition it meets are told in the same
 * transaction. No model is involved.
 */
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import type { PgBoss } from "pg-boss";
import type { DeploymentKeys } from "../ai/settings";
import { GoalSpec } from "../context/goals";
import { displayMetric, type MetricDirection, type MetricFormat } from "../figures/metric";
import type { GatewayDeps } from "../gateway/gateway";
import { type CheckGrain, checkHourFrom, isTimeZone, lastWholePeriod, nextCheckAt } from "../routines/schedule";
import {
  audienceKey,
  type Filed,
  filingK,
  tellFindings,
  type WatchingRoutine,
  watchingRoutines,
} from "../routines/tell";
import { runMetricQuery } from "../semantic/run";
import { lockFor } from "../tenancy/locks";
import { crossed, type Line, lineKey } from "./crossing";
import { candidateOf, DEFAULT_DETECTOR, type Observed, observe, type SeriesPoint } from "./detect";
import { forecastGoal, goalRiskSeverity } from "./goal-risk";
import { watchableMetrics } from "./metrics";
import { TREND_BEFORE, trendRate, trendShift, trendTitle } from "./trend";

const MONTH = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
const date = (period: string) => new Date(`${period.slice(0, 10)}T00:00:00Z`);

/** "September 2026", or "the week of Oct 5, 2026". */
export function periodName(period: string, grain: CheckGrain): string {
  return grain === "month" ? MONTH.format(date(period)) : `the week of ${DAY.format(date(period))}`;
}

/** What a check reads: 26 weeks, or 24 months (enough for the detector's baseline and a trend's). */
const RANGE: Record<CheckGrain, string> = { week: "last_26_weeks", month: "last_24_months" };

/** A figure an insight shows: read from a query-run cell, so it opens its trace. */
export interface CellClaim {
  queryRunId: string;
  row: number;
  column: string;
  value: number;
  display: string;
  period: string;
}

/** An unusual value's figures. The band isn't a cell: it's derived from the periods before, and says so. */
export interface AnomalyClaims {
  metric: { id: string; title: string; format: MetricFormat; direction: MetricDirection };
  grain: CheckGrain;
  value: CellClaim;
  previous: CellClaim | null;
  /**
   * The band it was found outside, at the sensitivity it was filed at (`k`), and its width per unit of k (`spread`),
   * so a routine at another sensitivity shows its own. `periods`: how many changes it's judged against.
   */
  expected: { value: number; lo: number; hi: number; display: string; periods: number; k: number; spread: number };
  /** Good news by the metric's direction; null for a neutral metric. */
  good: boolean | null;
}

/** A line crossed: the latest value (a cell), and the line (not a cell: a routine drew it). */
export interface ThresholdClaims {
  metric: { id: string; title: string; format: MetricFormat; direction: MetricDirection };
  grain: CheckGrain;
  value: CellClaim;
  line: Line & { display: string };
  /** The run beyond the line: its first period, and how many. */
  since: string;
  periods: number;
}

/** A goal at risk's figures: the latest month (a cell), its projection and the target (not cells). */
export interface GoalRiskClaims {
  goal: {
    id: string;
    title: string;
    target: { value: number; display: string };
    due: string;
    direction: "at_least" | "at_most";
  };
  metric: { id: string; title: string; format: MetricFormat };
  value: CellClaim;
  projected: { value: number; display: string; month: string };
  trendMonths: number;
}

/**
 * A trend's figures: the latest month (a cell), and the metric's median change a month before the shift
 * and during it (not cells: derived from the months' cells, and said to be).
 */
export interface TrendClaims {
  metric: { id: string; title: string; format: MetricFormat; direction: MetricDirection };
  value: CellClaim;
  /** The shift's first month. */
  since: string;
  months: { before: number; recent: number };
  before: { value: number; display: string };
  recent: { value: number; display: string };
  /** Changes as shares a month, else in the metric's units. */
  relative: boolean;
  /** Good news by the metric's direction; null for a neutral metric. */
  good: boolean | null;
}

export interface CheckState {
  lastRunAt?: string;
  /** ok: judged; waiting: its period hasn't landed; error: it couldn't run (why in lastError). */
  lastStatus?: "ok" | "waiting" | "error";
  lastError?: string;
  /** The period it last judged, or waited for (YYYY-MM-DD). */
  lastPeriod?: string;
}

export interface CheckResult {
  status: "ok" | "waiting" | "error" | "skipped";
  observations: number;
  /** The insights it found or found again, and those of them it filed for the first time. */
  found: string[];
  filed: string[];
  /** The routine runs it made to tell them. */
  runs: number;
}

export type CheckDeps = GatewayDeps & { boss: PgBoss; deploymentKeys: DeploymentKeys };

interface Loaded {
  id: string;
  metricId: string;
  connectionId: string;
  grain: CheckGrain;
  tz: string;
  usable: boolean;
  connectionName: string;
}

const NONE: Omit<CheckResult, "status"> = { observations: 0, found: [], filed: [], runs: 0 };

export async function runCheck(
  deps: CheckDeps,
  job: { orgId: string; checkId: string },
  now = new Date(),
): Promise<CheckResult> {
  const loaded = await deps.withTenant(job.orgId, async (tx) => {
    const [row] = await tx.execute<{
      id: string;
      metric_id: string;
      connection_id: string;
      grain: CheckGrain;
      tz: string;
      usable: boolean | null;
      connection_name: string | null;
    }>(sql`
      select k.id, k.metric_id, k.connection_id, k.grain, o.tz, c.name as connection_name,
        (c.deleted_at is null and c.status <> 'disabled') as usable
      from app.metric_check k
      join app.org o on o.id = k.org_id
      left join app.connection c on c.org_id = k.org_id and c.id = k.connection_id
      where k.org_id = ${job.orgId} and k.id = ${job.checkId} and k.deleted_at is null`);
    if (!row) return null;
    const [metric] = await watchableMetrics(tx, job.orgId, [row.metric_id]);
    const routines = await watchingRoutines(tx, job.orgId, { id: row.metric_id, connectionId: row.connection_id });
    const check: Loaded = {
      id: row.id,
      metricId: row.metric_id,
      connectionId: row.connection_id,
      grain: row.grain,
      tz: isTimeZone(row.tz) ? row.tz : "UTC",
      usable: Boolean(row.usable),
      connectionName: row.connection_name ?? "A source",
    };
    return { check, metric: metric ?? null, routines };
  });
  if (!loaded) return { status: "skipped", ...NONE };
  const { check, metric, routines } = loaded;
  const fail = (lastError: string) =>
    deps.withTenant(job.orgId, async (tx) => {
      await saveState(tx, job.orgId, check, { lastStatus: "error", lastError }, nextDay(now, check.tz), now);
      return { status: "error" as const, ...NONE };
    });
  if (!metric) return fail("Its metric was deleted, or isn't verified any more.");
  if (!check.usable) return fail("Its source was removed or turned off.");
  if (!metric.grain) return fail("Its metric has no weeks or months to check: it needs a time field.");
  // The primary check reads the metric's own period: freshness and lines are its. A month check of a metric read by
  // week judges its months: an unusual month, a trend, its goals.
  const primary = check.grain === metric.grain;
  if (!primary && check.grain === "week") return fail("Its metric is read by month now; its month check reads it.");
  const outcome = await runMetricQuery(deps, {
    orgId: job.orgId,
    connectionId: check.connectionId,
    query: { metrics: [metric.slug], time: { grain: check.grain, range: RANGE[check.grain] } },
    mode: "execute",
    title: `Check · ${metric.title} by ${check.grain}`,
    requester: { type: "check", id: check.id },
    now,
  });
  if (outcome.status !== "succeeded") {
    return fail(
      outcome.error?.message ?? (outcome.status === "timeout" ? "Its query timed out." : "Its query didn't finish."),
    );
  }
  const names = outcome.columns.map((c) => c.name);
  const at = { period: names.indexOf(check.grain), value: names.indexOf(metric.slug) };
  if (at.period < 0 || at.value < 0) return fail(`Its query didn't return ${check.grain}s.`);
  const points: SeriesPoint[] = outcome.rows.map((r, row) => {
    const raw = r[at.value];
    const value = raw === null || raw === undefined || raw === "" ? null : Number(raw);
    return { period: String(r[at.period] ?? "").slice(0, 10), value: Number.isFinite(value) ? value : null, row };
  });
  // The workspace's findings are its shared routines' (Watching, and any that reach past their owner); a private
  // routine adds its owner's own only where it sees what none of those does (a line only it draws, a sensitivity
  // none of them has), so someone's private choices never show in the shared feed.
  const shared = routines.filter((r) => r.privateTo === null);
  const owners = [...new Set(routines.flatMap((r) => (r.privateTo ? [r.privateTo] : [])))];
  const theirs = (owner: string) => routines.filter((r) => r.privateTo === owner);
  const asking = (rs: WatchingRoutine[], kind: string) => rs.some((r) => r.spec.condition.kind === kind);
  const spec = { ...DEFAULT_DETECTOR, madK: filingK(shared) };
  const observed = observe(points, spec, check.grain);
  const period = lastWholePeriod(now, check.grain);
  const latest = observed.at(-1);
  const m = { ...metric, column: metric.slug, queryRunId: outcome.queryRunId };

  return deps.withTenant(job.orgId, async (tx) => {
    // A source's checks write one at a time: its late-data incident reads its other checks' states, so two at once
    // could each miss the other's (an incident left open, or one missing while a check waits).
    await lockFor(tx, `source-checks:${check.connectionId}`);
    for (const o of observed) await saveObservation(tx, job.orgId, check.id, o, outcome.queryRunId);
    const found: Upserted[] = [];
    if (!latest || latest.period < period) {
      // Freshness first: a period that hasn't landed is one incident for the source, and nothing else.
      if (primary) found.push(await judgeLate(tx, job.orgId, check, metric.title, period, outcome.queryRunId));
      await saveState(tx, job.orgId, check, { lastStatus: "waiting", lastPeriod: period }, nextDay(now, check.tz), now);
      return settle(tx, deps, job.orgId, check, routines, found, [], observed.length, "waiting", now);
    }
    // It landed: the source's incident is over once none of its checks still waits.
    await tx.execute(sql`
      update app.insight set status = 'resolved', status_at = now()
      where org_id = ${job.orgId} and kind = 'data_quality' and connection_id = ${check.connectionId}
        and status in ('new', 'seen')
        and not exists (select 1 from app.metric_check k where k.org_id = ${job.orgId}
          and k.connection_id = ${check.connectionId} and k.deleted_at is null and k.id <> ${check.id}
          and k.state->>'lastStatus' = 'waiting')`);
    const filedExtra: Filed[] = [];
    const anomaly = async (observedAt: Observed[], at: typeof spec, ownerId: string | null) => {
      const a = await judgeAnomaly(tx, job.orgId, check, m, observedAt, at, ownerId);
      if (!a) return false;
      found.push(a.upserted);
      if (a.upserted.inserted) {
        filedExtra.push({
          id: a.upserted.id,
          kind: "anomaly",
          metricId: metric.id,
          connectionId: check.connectionId,
          band: a.band,
          ownerId,
        });
      }
      return true;
    };
    const sharedUnusual = asking(shared, "unusual");
    const filedShared = sharedUnusual && (await anomaly(observed, spec, null));
    if (!filedShared) {
      // Unusual only at an owner's own sensitivity: theirs, read again at it.
      for (const owner of owners.filter((o) => asking(theirs(o), "unusual"))) {
        const k = filingK(theirs(owner));
        if (sharedUnusual && k >= spec.madK) continue;
        const at = { ...DEFAULT_DETECTOR, madK: k };
        await anomaly(observe(points, at, check.grain), at, owner);
      }
    }
    if (primary) {
      const lines = linesByAudience(routines, metric.id);
      for (const { line, ownerId } of lines) {
        const t = await judgeLine(tx, job.orgId, check, m, observed, line, ownerId);
        if (t) {
          found.push(t);
          if (t.inserted)
            filedExtra.push({
              id: t.id,
              kind: "threshold",
              metricId: metric.id,
              connectionId: check.connectionId,
              line,
              ownerId,
            });
        }
      }
      // A line no routine draws any more isn't watched: its open finding resolves.
      const drawn = `{${lines.map((l) => `"${audienceKey(l.ownerId, lineKey(metric.id, l.line))}"`).join(",")}}`;
      await tx.execute(sql`
        update app.insight set status = 'resolved', status_at = now()
        where org_id = ${job.orgId} and kind = 'threshold' and metric_id = ${metric.id} and status in ('new', 'seen')
          and not exists (select 1 from unnest(${drawn}::text[]) p where starts_with(dedupe_key, p))`);
    }
    if (check.grain === "month") {
      // A trend is the workspace's when a shared routine watches for the unusual, else each private owner's.
      const trendFor = sharedUnusual ? [null] : owners.filter((o) => asking(theirs(o), "unusual"));
      for (const ownerId of trendFor) {
        const t = await judgeTrend(tx, job.orgId, check, m, points, ownerId);
        if (t) found.push(t);
      }
      found.push(...(await judgeGoals(tx, job.orgId, check, m, points, observed)));
    }
    await saveState(
      tx,
      job.orgId,
      check,
      { lastStatus: "ok", lastPeriod: latest.period },
      nextCheckAt(latest.period, check.grain, check.tz),
      now,
    );
    return settle(tx, deps, job.orgId, check, routines, found, filedExtra, observed.length, "ok", now);
  });
}

/**
 * A source's late data: one open incident for the source however many of its checks wait (found again, it's one
 * more occurrence), keyed by the first period it waited for, so a dismissal holds for that lateness only.
 */
async function judgeLate(
  tx: TenantTx,
  orgId: string,
  check: Loaded,
  metricTitle: string,
  period: string,
  queryRunId: string,
): Promise<Upserted> {
  const [open] = await tx.execute<{ id: string }>(sql`
    update app.insight set occurrences = occurrences + 1, last_seen_at = now()
    where id = (select id from app.insight where org_id = ${orgId} and kind = 'data_quality'
      and connection_id = ${check.connectionId} and status in ('new', 'seen') order by first_seen_at limit 1)
      and org_id = ${orgId}
    returning id`);
  if (open) return { id: open.id, kind: "data_quality", metricId: null, inserted: false };
  return upsertInsight(tx, {
    orgId,
    checkId: check.id,
    connectionId: check.connectionId,
    kind: "data_quality",
    metricId: null,
    direction: null,
    period,
    title: `${check.connectionName}'s data for ${periodName(period, check.grain)} hasn't arrived`,
    summary: `${metricTitle} has no value for ${periodName(period, check.grain)} yet, so its checks wait for it.`,
    severity: 1,
    score: null,
    dedupeKey: `freshness:${check.connectionId}:${check.grain}:${period}`,
    claims: {},
    queryRunIds: [queryRunId],
  });
}

/** Tells what was filed for the first time, and sums the check up. */
async function settle(
  tx: TenantTx,
  deps: CheckDeps,
  orgId: string,
  check: Loaded,
  routines: WatchingRoutine[],
  found: Upserted[],
  detailed: Filed[],
  observations: number,
  status: "ok" | "waiting",
  now: Date,
): Promise<CheckResult> {
  const filed: Filed[] = found
    .filter((f) => f.inserted)
    .map(
      (f) =>
        detailed.find((d) => d.id === f.id) ?? {
          id: f.id,
          kind: f.kind,
          metricId: f.metricId,
          connectionId: check.connectionId,
          ownerId: f.ownerId ?? null,
        },
    );
  const runs = await tellFindings(tx, deps, { orgId, tz: check.tz, filed, routines }, now);
  return {
    status,
    observations,
    found: found.flatMap((f) => (f.id ? [f.id] : [])),
    filed: filed.map((f) => f.id),
    runs,
  };
}

type MetricRead = {
  id: string;
  title: string;
  format: MetricFormat;
  direction: MetricDirection;
  column: string;
  queryRunId: string;
};

const claimOf = (m: MetricRead, x: { period: string; value: number; row: number }): CellClaim => ({
  queryRunId: m.queryRunId,
  row: x.row,
  column: m.column,
  value: x.value,
  display: displayMetric(m.format, x.value),
  period: x.period,
});

/** As precisely as the metric's own values are (84–94 for a count). */
const decimalsOf = (observed: { value: number }[]) =>
  Math.min(2, Math.max(0, ...observed.map((x) => (String(x.value).split(".")[1] ?? "").length)));

const goodOf = (direction: MetricDirection, up: boolean) =>
  direction === "neutral" ? null : up === (direction === "higher_is_better");

/** The latest period beyond its band (at the most sensitive routine's k), by more than the materiality threshold. */
async function judgeAnomaly(
  tx: TenantTx,
  orgId: string,
  check: Loaded,
  m: MetricRead,
  observed: Observed[],
  spec: typeof DEFAULT_DETECTOR,
  ownerId: string | null,
): Promise<{ upserted: Upserted; band: NonNullable<Filed["band"]> } | null> {
  const found = candidateOf(observed, spec);
  if (!found) return null;
  const o = found.observed;
  const before = observed.at(-2) ?? null;
  const round = (v: number) => Number(v.toFixed(decimalsOf(observed)));
  const claims: AnomalyClaims = {
    metric: { id: m.id, title: m.title, format: m.format, direction: m.direction },
    grain: check.grain,
    value: claimOf(m, o),
    previous: before ? claimOf(m, before) : null,
    expected: {
      value: o.expected,
      lo: o.expectedLo,
      hi: o.expectedHi,
      display: `${displayMetric(m.format, round(o.expectedLo))}–${displayMetric(m.format, round(o.expectedHi))}`,
      periods: Math.min(observed.length - 1, spec.window),
      k: spec.madK,
      spread: o.spread,
    },
    good: goodOf(m.direction, o.value > o.expectedHi),
  };
  const upserted = await upsertInsight(tx, {
    orgId,
    checkId: check.id,
    connectionId: check.connectionId,
    kind: "anomaly",
    metricId: m.id,
    direction: found.direction,
    period: o.period,
    title: anomalyTitle(m.title, found.direction, o, before, check.grain),
    summary: `Against how it changed over the ${check.grain}s before, its value for ${periodName(o.period, check.grain)} is outside the range it was expected in.`,
    severity: found.severity,
    score: o.score,
    dedupeKey: audienceKey(ownerId, `anomaly:${m.id}:${check.grain}:${found.direction}:${o.period}`),
    ownerId,
    claims,
    queryRunIds: [m.queryRunId],
  });
  return { upserted, band: { value: o.value, expected: o.expected, spread: o.spread } };
}

/** Words only, and true to the numbers: a metric that grew, but by less than usual, "grew less than usual". */
export function anomalyTitle(
  title: string,
  direction: "up" | "down",
  o: Observed,
  before: Observed | null,
  grain: CheckGrain,
): string {
  const when = `in ${periodName(o.period, grain)}`;
  const rose = before ? o.value > before.value : direction === "up";
  if (direction === "up") return `${title} ${rose ? "rose more than usual" : "fell less than usual"} ${when}`;
  return `${title} ${rose ? "grew less than usual" : "fell more than usual"} ${when}`;
}

/**
 * The lines the routines that watch this metric draw, each once for whom it's drawn: the workspace when a shared
 * routine draws it, else each private owner who does.
 */
function linesByAudience(routines: WatchingRoutine[], metricId: string): { line: Line; ownerId: string | null }[] {
  const drawing = new Map<string, { line: Line; owners: Set<string | null> }>();
  for (const r of routines) {
    const c = r.spec.condition;
    if (c.kind !== "crosses" || !r.spec.metricIds.includes(metricId)) continue;
    const key = `${c.direction}:${c.value}`;
    const entry = drawing.get(key) ?? { line: { direction: c.direction, value: c.value }, owners: new Set() };
    entry.owners.add(r.privateTo);
    drawing.set(key, entry);
  }
  return [...drawing.values()].flatMap(({ line, owners }) =>
    owners.has(null) ? [{ line, ownerId: null }] : [...owners].map((ownerId) => ({ line, ownerId })),
  );
}

/**
 * A line crossed: the run of periods beyond it that ends at the latest is one insight, keyed by where the run began;
 * back on the right side, it resolves, and a later crossing is a new one.
 */
async function judgeLine(
  tx: TenantTx,
  orgId: string,
  check: Loaded,
  m: MetricRead,
  observed: Observed[],
  line: Line,
  ownerId: string | null,
): Promise<Upserted | null> {
  const prefix = audienceKey(ownerId, lineKey(m.id, line));
  const run = crossed(observed, line, check.grain);
  const key = run ? `${prefix}${run.since}` : null;
  await tx.execute(sql`
    update app.insight set status = 'resolved', status_at = now()
    where org_id = ${orgId} and starts_with(dedupe_key, ${prefix}) and dedupe_key is distinct from ${key}
      and status in ('new', 'seen')`);
  if (!run || !key) return null;
  const lineDisplay = displayMetric(m.format, line.value);
  const verb = line.direction === "below" ? "below" : "above";
  const claims: ThresholdClaims = {
    metric: { id: m.id, title: m.title, format: m.format, direction: m.direction },
    grain: check.grain,
    value: claimOf(m, run.latest),
    line: { ...line, display: lineDisplay },
    since: run.since,
    periods: run.periods,
  };
  const good = goodOf(m.direction, line.direction === "above");
  return upsertInsight(tx, {
    orgId,
    checkId: check.id,
    connectionId: check.connectionId,
    kind: "threshold",
    metricId: m.id,
    direction: line.direction === "above" ? "up" : "down",
    period: run.latest.period,
    title:
      run.periods === 1
        ? `${m.title} went ${verb} ${lineDisplay} in ${periodName(run.latest.period, check.grain)}`
        : `${m.title} has been ${verb} ${lineDisplay} for ${run.periods} ${check.grain}s`,
    summary: `A routine watches for ${m.title} ${line.direction === "below" ? "falling below" : "going above"} ${lineDisplay}; its value for ${periodName(run.latest.period, check.grain)} is ${verb} it.`,
    // A line someone drew is worth a look whichever way it's crossed; going the bad way, more so.
    severity: good === false ? 2 : 1,
    score: null,
    dedupeKey: key,
    ownerId,
    claims,
    queryRunIds: [m.queryRunId],
  });
}

/**
 * Trends: the metric's month-on-month change, moved and stayed moved, is an insight keyed by where the
 * shift began, so it's one card while the shift goes on and a dismissal holds for it. Any other open trend on the
 * metric (one that didn't hold, or is the new normal) resolves.
 */
async function judgeTrend(
  tx: TenantTx,
  orgId: string,
  check: Loaded,
  m: MetricRead,
  points: SeriesPoint[],
  ownerId: string | null,
): Promise<Upserted | null> {
  const t = trendShift(points);
  const key = t ? audienceKey(ownerId, `trend:${m.id}:${t.direction}:${t.since}`) : null;
  await tx.execute(sql`
    update app.insight set status = 'resolved', status_at = now()
    where org_id = ${orgId} and kind = 'trend' and metric_id = ${m.id} and owner_id is not distinct from ${ownerId}
      and dedupe_key is distinct from ${key} and status in ('new', 'seen')`);
  if (!t || !key) return null;
  const rate = (change: number) => ({ value: change, display: trendRate(m.format, t.relative, change) });
  const claims: TrendClaims = {
    metric: { id: m.id, title: m.title, format: m.format, direction: m.direction },
    value: claimOf(m, t.latest),
    since: t.since,
    months: { before: TREND_BEFORE, recent: t.months },
    before: rate(t.before),
    recent: rate(t.recent),
    relative: t.relative,
    good: goodOf(m.direction, t.direction === "up"),
  };
  return upsertInsight(tx, {
    orgId,
    checkId: check.id,
    connectionId: check.connectionId,
    kind: "trend",
    metricId: m.id,
    direction: t.direction,
    period: t.latest.period,
    title: trendTitle(m.title, t),
    summary: `Its month-on-month change has been ${t.direction === "up" ? "higher" : "lower"} for ${t.months} months in a row than in the ${TREND_BEFORE} before.`,
    severity: t.severity,
    score: null,
    dedupeKey: key,
    ownerId,
    claims,
    queryRunIds: [m.queryRunId],
  });
}

const DUE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Goal risk ("forecast vs target"): each goal on the metric, its latest month projected on its trend to the
 * goal's month. At risk, it's an insight for that latest month (the one before resolves); back on course, any open
 * one resolves. A goal is itself the ask: its risk is filed whenever its metric has a month check.
 */
async function judgeGoals(
  tx: TenantTx,
  orgId: string,
  check: Loaded,
  m: MetricRead,
  points: SeriesPoint[],
  observed: Observed[],
): Promise<Upserted[]> {
  const goals = await tx.execute<{ id: string; title: string; spec: GoalSpec }>(sql`
    select g.id, g.title, gv.spec from app.context_item g
    join app.context_item_version gv on gv.org_id = g.org_id and gv.item_id = g.id and gv.version = g.released_version
    where g.org_id = ${orgId} and g.kind = 'goal' and g.deleted_at is null and gv.spec->>'metric' = ${m.id}`);
  const decimals = decimalsOf(observed);
  // A goal that's gone, or now measures another metric, leaves this metric's goal risks: they resolve.
  const live = goals.map((g) => `goal_risk:${g.id}:${m.id}:`);
  await tx.execute(sql`
    update app.insight set status = 'resolved', status_at = now()
    where org_id = ${orgId} and kind = 'goal_risk' and metric_id = ${m.id} and status in ('new', 'seen')
      and not exists (select 1 from unnest(${`{${live.map((k) => `"${k}"`).join(",")}}`}::text[]) k where starts_with(dedupe_key, k))`);
  const found: Upserted[] = [];
  for (const g of goals) {
    // Keyed by goal and metric: a goal moved to another metric starts afresh there.
    const prefix = `goal_risk:${g.id}:`;
    const spec = GoalSpec.safeParse(g.spec);
    const f = spec.success ? forecastGoal(points, spec.data) : null;
    const key = f && !f.onCourse ? `${prefix}${m.id}:${f.latest.period}` : null;
    await tx.execute(sql`
      update app.insight set status = 'resolved', status_at = now()
      where org_id = ${orgId} and starts_with(dedupe_key, ${prefix}) and dedupe_key is distinct from ${key}
        and status in ('new', 'seen')`);
    if (!f || f.onCourse || !key || !spec.success) continue;
    const due = DUE.format(date(spec.data.due));
    const keepBelow = spec.data.direction === "at_most";
    const claims: GoalRiskClaims = {
      goal: {
        id: g.id,
        title: g.title,
        target: { value: spec.data.target, display: displayMetric(m.format, spec.data.target) },
        due: spec.data.due,
        direction: spec.data.direction,
      },
      metric: { id: m.id, title: m.title, format: m.format },
      value: claimOf(m, f.latest),
      projected: {
        value: f.projected,
        display: displayMetric(m.format, Number(f.projected.toFixed(decimals))),
        month: f.dueMonth,
      },
      trendMonths: f.trend.months,
    };
    found.push(
      await upsertInsight(tx, {
        orgId,
        checkId: check.id,
        connectionId: check.connectionId,
        kind: "goal_risk",
        metricId: m.id,
        direction: null,
        period: f.latest.period,
        title: `${m.title} is on course to ${keepBelow ? "go over" : "miss"} its goal for ${due}`,
        summary: `On its trend over the ${f.trend.months} months before, its value for ${periodName(f.dueMonth, "month")} would ${keepBelow ? "be above" : "fall short of"} the target.`,
        severity: goalRiskSeverity(f.shortfall),
        score: null,
        dedupeKey: key,
        claims,
        queryRunIds: [m.queryRunId],
      }),
    );
  }
  return found.filter((u) => u.id);
}

async function saveObservation(tx: TenantTx, orgId: string, checkId: string, o: Observed, queryRunId: string) {
  await tx.execute(sql`
    insert into app.observation (org_id, check_id, period_start, value, expected, expected_lo, expected_hi, spread,
      score, query_run_id, row)
    values (${orgId}, ${checkId}, ${o.period}, ${o.value}, ${o.expected}, ${o.expectedLo}, ${o.expectedHi}, ${o.spread},
      ${o.score}, ${queryRunId}, ${o.row})
    on conflict (org_id, check_id, period_start) do update set value = excluded.value,
      expected = excluded.expected, expected_lo = excluded.expected_lo, expected_hi = excluded.expected_hi,
      spread = excluded.spread, score = excluded.score, query_run_id = excluded.query_run_id, row = excluded.row,
      observed_at = now()`);
}

interface InsightInput {
  orgId: string;
  checkId: string;
  connectionId: string;
  kind: Filed["kind"];
  metricId: string | null;
  direction: "up" | "down" | null;
  period: string;
  title: string;
  summary: string;
  severity: number;
  score: number | null;
  dedupeKey: string;
  /** Null (or left out): the workspace's. Set: that person's alone (audienceKey). */
  ownerId?: string | null;
  claims: AnomalyClaims | ThresholdClaims | GoalRiskClaims | TrendClaims | Record<string, never>;
  queryRunIds: string[];
}

/** An insight as the upsert left it: whether it was filed now (`inserted`) or found again. */
interface Upserted {
  id: string;
  kind: Filed["kind"];
  metricId: string | null;
  inserted: boolean;
  /** Whose it is: null for the workspace's. */
  ownerId?: string | null;
}

/**
 * Doc 09's dedupe: one open insight per key, so finding it again adds an occurrence and refreshes its figures. One a
 * person dismissed stays closed: dismissing September's anomaly doesn't bring it back. One that resolved on its own
 * (a goal back on course) can be found again.
 */
async function upsertInsight(tx: TenantTx, i: InsightInput): Promise<Upserted> {
  const none = { id: "", kind: i.kind, metricId: i.metricId, inserted: false, ownerId: i.ownerId ?? null };
  const [closed] = await tx.execute(sql`
    select 1 from app.insight where org_id = ${i.orgId} and dedupe_key = ${i.dedupeKey} and status = 'dismissed' limit 1`);
  if (closed) return none;
  const [row] = await tx.execute<{ id: string; inserted: boolean }>(sql`
    insert into app.insight (org_id, id, check_id, connection_id, kind, metric_id, direction, period, title, summary,
      severity, score, dedupe_key, owner_id, claims, query_run_ids)
    values (${i.orgId}, ${uuidv7()}, ${i.checkId}, ${i.connectionId}, ${i.kind}, ${i.metricId}, ${i.direction},
      ${i.period}, ${i.title}, ${i.summary}, ${i.severity}, ${i.score}, ${i.dedupeKey}, ${i.ownerId ?? null},
      ${JSON.stringify(i.claims)}::jsonb,
      ${`{${i.queryRunIds.join(",")}}`}::uuid[])
    on conflict (org_id, dedupe_key) where status in ('new', 'seen') do update set
      occurrences = app.insight.occurrences + 1, last_seen_at = now(), title = excluded.title,
      summary = excluded.summary, severity = excluded.severity, score = excluded.score, claims = excluded.claims,
      query_run_ids = excluded.query_run_ids, check_id = excluded.check_id
    returning id, (xmax = 0) as inserted`);
  return row
    ? { id: row.id, kind: i.kind, metricId: i.metricId, inserted: row.inserted, ownerId: i.ownerId ?? null }
    : none;
}

/** The next check hour strictly after now: tomorrow morning, where the workspace is. */
const nextDay = (now: Date, tz: string) => checkHourFrom(new Date(now.getTime() + 1), tz);

async function saveState(tx: TenantTx, orgId: string, check: Loaded, state: CheckState, next: Date, now: Date) {
  await tx.execute(sql`
    update app.metric_check set state = ${JSON.stringify({ ...state, lastRunAt: now.toISOString() })}::jsonb,
      next_check_at = ${next.toISOString()}, updated_at = now()
    where org_id = ${orgId} and id = ${check.id}`);
}

/** The dead letter's part: a check that kept failing says so, and tries again the next morning. */
export async function checkFailed(
  deps: Pick<GatewayDeps, "withTenant">,
  job: { orgId: string; checkId: string },
  now = new Date(),
) {
  await deps.withTenant(job.orgId, async (tx) => {
    const [o] = await tx.execute<{ tz: string }>(sql`select tz from app.org where id = ${job.orgId}`);
    const tz = o && isTimeZone(o.tz) ? o.tz : "UTC";
    await tx.execute(sql`
      update app.metric_check set updated_at = now(), next_check_at = ${nextDay(now, tz).toISOString()},
        state = state || ${JSON.stringify({ lastStatus: "error", lastError: "It stopped the worker twice.", lastRunAt: now.toISOString() })}::jsonb
      where org_id = ${job.orgId} and id = ${job.checkId}`);
  });
}

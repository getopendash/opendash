// Metric checks: a verified metric watched by the workspace's Watching routine is checked by its own period
// (week where it can be, month otherwise), each value a query-run cell, freshness first; what it finds is filed once
// as an insight: deduped, dismissible, traced. A check nothing needs any more is removed, its traces kept.
import { uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkFailed,
  checkHourFrom,
  composerChoices,
  deleteGoal,
  dismissInsight,
  getQueryCard,
  getWatching,
  listGoals,
  listInsights,
  nextCheckAt,
  openInsightCount,
  queueDueChecks,
  RoutineProblem,
  saveGoal,
  unwatchMetric,
  watchedByRoutines,
  watchMetric,
} from "../src";
import { actor, check, checkOf, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
let ids: Record<string, string> = {};
const NOW = new Date("2026-10-11T09:00:00Z");
const ctx = () => ({ orgId: s.orgId, userId: s.userId, canManage: true });
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RoutineProblem) return error.message;
    throw error;
  }
};
const open = () => s.tenant((tx) => listInsights(tx, { orgId: s.orgId, userId: null }));
const id = (slug: string) => ids[slug] as string;

beforeAll(async () => {
  ({ s, ids } = await verifiedSource(NOW));
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("watching a metric", () => {
  it("offers verified metrics with weeks or months, each checked by its own period", async () => {
    // Whether it has time is its definition's say, never a stored check: early metrics, released before their
    // check kept a trend, couldn't be watched. New accounts' check here keeps none.
    await s.t.owner`update app.context_item_version v set derived = v.derived - 'trend'
      from app.context_item i where i.org_id = v.org_id and i.id = v.item_id and v.version = i.released_version
        and i.id = ${id("new_accounts")}`;
    const offered = (await s.tenant((tx) => composerChoices(tx, actor(s)))).metrics;
    expect(offered.find((c) => c.title === "New accounts")).toMatchObject({ grain: "week", watchedBy: 0 });
    expect(offered.find((c) => c.title === "Monthly recurring revenue")).toMatchObject({ grain: "month" });
    expect(offered.map((c) => c.title)).not.toContain("Active subscriptions");
    for (const slug of ["new_accounts", "mrr"]) await s.tenant((tx) => watchMetric(tx, actor(s), id(slug), NOW));
    // Watched twice is still once.
    await s.tenant((tx) => watchMetric(tx, actor(s), id("mrr"), NOW));
    const refused = (metricId: string) => problem(s.tenant((tx) => watchMetric(tx, actor(s), metricId, NOW)));
    expect(await refused(id("active_subscriptions"))).toBe(
      "Active subscriptions has no weeks or months to check: it needs a time field.",
    );
    expect(await refused(uuidv7())).toBe("Pick verified metrics.");
    expect(await problem(s.tenant((tx) => watchMetric(tx, actor(s, s.userId, false), id("trials"), NOW)))).toBe(
      "Only owners and admins choose what's watched.",
    );
    // New accounts is read by week, and by month for its trend; MRR, a month-end snapshot, by month.
    expect(await checkOf(s, id("new_accounts"), "week")).not.toBeNull();
    expect(await checkOf(s, id("new_accounts"), "month")).not.toBeNull();
    expect(await checkOf(s, id("mrr"), "month")).not.toBeNull();
    expect(await checkOf(s, id("mrr"), "week")).toBeNull();
    const watched = await s.tenant((tx) => watchedByRoutines(tx, actor(s)));
    expect(watched.map((m) => [m.metric.title, m.grain])).toEqual([
      ["Monthly recurring revenue", "month"],
      ["New accounts", "week"],
    ]);
  });

  it("judges New accounts' months, and finds September's dip, its figures read from a query cell", async () => {
    const result = await check(s, id("new_accounts"), "month", NOW);
    expect(result).toMatchObject({ status: "ok", observations: 24, runs: 0 });
    const [insight] = await open();
    expect(result.filed).toEqual([insight?.id]);
    expect(insight).toMatchObject({
      kind: "anomaly",
      title: "New accounts fell more than usual in September 2026",
      direction: "down",
      period: "2026-09-01",
      severity: 2,
      occurrences: 1,
      claims: {
        metric: { id: id("new_accounts"), title: "New accounts", direction: "higher_is_better" },
        grain: "month",
        value: { value: 77, display: "77", column: "new_accounts", period: "2026-09-01" },
        previous: { value: 88, period: "2026-08-01" },
        expected: { display: "84–94", periods: 12, k: 3 },
        good: false,
      },
    });
    expect(insight?.claims?.expected.spread).toBeGreaterThan(0);
    expect(insight?.series.map((p) => p.value)).toHaveLength(12);
    expect(insight?.series.at(-1)).toEqual({ period: "2026-09-01", value: 77 });
    // The value is a cell of the check's query run, and anyone in the organization can open its trace.
    const card = await getQueryCard(
      s.deps,
      { orgId: s.orgId, userId: uuidv7() },
      insight?.claims?.value.queryRunId as string,
    );
    expect(card?.preview?.[insight?.claims?.value.row as number]?.map(String)).toContain("77");
    const [observation] = await s.t.owner<{ count: number }[]>`
      select count(*)::int as count from app.observation
      where check_id = ${(await checkOf(s, id("new_accounts"), "month")) as string} and expected is not null`;
    expect(observation?.count).toBe(17);
  });

  it("reads its weeks for the last whole one, a week apart", async () => {
    const result = await check(s, id("new_accounts"), "week", NOW);
    expect(result.status).toBe("ok");
    expect(result.observations).toBeGreaterThan(20);
    const [state] = await s.t.owner<{ state: { lastPeriod?: string }; next_check_at: Date }[]>`
      select state, next_check_at from app.metric_check where id = ${(await checkOf(s, id("new_accounts"), "week")) as string}`;
    // Sunday Oct 11: the week of Oct 5 isn't over, so the week of Sep 28 is the last whole one.
    expect(state?.state.lastPeriod).toBe("2026-09-28");
    expect(state?.next_check_at.toISOString()).toBe(nextCheckAt("2026-09-28", "week", "UTC").toISOString());
  });

  it("takes MRR's slowing growth for a trend, not for news of any one month", async () => {
    // An open trend on the metric that no longer holds (it began elsewhere) resolves when the real one is found.
    const stale = uuidv7();
    await s.t.owner`
      insert into app.insight (org_id, id, connection_id, kind, metric_id, direction, period, title, summary, severity,
        dedupe_key, claims)
      values (${s.orgId}, ${stale}, ${s.connectionId}, 'trend', ${id("mrr")}, 'up', '2026-05-01', 'An old shift', 'x', 1,
        ${`trend:${id("mrr")}:up:2026-03-01`}, '{}'::jsonb)`;
    const result = await check(s, id("mrr"), "month", NOW);
    expect(result.status).toBe("ok");
    const trend = (await open()).find((i) => i.kind === "trend");
    expect(result.filed).toEqual([trend?.id]);
    expect(trend).toMatchObject({
      title: "Monthly recurring revenue's growth slowed over the last 3 months",
      direction: "down",
      period: "2026-09-01",
      severity: 1,
      trend: {
        value: { display: "$412.6k", period: "2026-09-01", column: "mrr" },
        since: "2026-07-01",
        before: { display: "7% a month" },
        recent: { display: "5.1% a month" },
        good: false,
      },
    });
    expect((await open()).some((i) => i.kind === "anomaly" && i.claims?.metric.id === id("mrr"))).toBe(false);
    const [old] = await s.t.owner<{ status: string }[]>`select status from app.insight where id = ${stale}`;
    expect(old?.status).toBe("resolved");
    // Found again it's the same insight, filed nothing new; dismissed, it stays so.
    const again = await check(s, id("mrr"), "month", NOW);
    expect([again.found, again.filed]).toEqual([[trend?.id], []]);
    expect((await open()).find((i) => i.kind === "trend")?.occurrences).toBe(2);
    await s.tenant((tx) => dismissInsight(tx, ctx(), trend?.id as string, "known_issue"));
    expect((await check(s, id("mrr"), "month", NOW)).found).toEqual([]);
    expect((await open()).some((i) => i.kind === "trend")).toBe(false);
  });

  it("forecasts a goal on its metric: at risk is an insight, back on course resolves it", async () => {
    const goal = await s.tenant((tx) =>
      saveGoal(tx, ctx(), { metricId: id("mrr"), target: 500_000, due: "2026-12-31" }, NOW),
    );
    await check(s, id("mrr"), "month", NOW);
    const risk = (await open()).find((i) => i.kind === "goal_risk");
    expect(risk).toMatchObject({
      title: "Monthly recurring revenue is on course to miss its goal for Dec 31, 2026",
      period: "2026-09-01",
      severity: 1,
      goalRisk: {
        goal: { id: goal.id, target: { value: 500_000, display: "$500k" }, due: "2026-12-31" },
        value: { display: "$412.6k", period: "2026-09-01" },
      },
    });
    // Its forecast comes from the metric's month check.
    expect((await s.tenant((tx) => listGoals(tx, s.orgId)))[0]?.forecast).toMatchObject({ onCourse: false });
    await s.tenant((tx) =>
      saveGoal(tx, ctx(), { id: goal.id, metricId: id("mrr"), target: 450_000, due: "2026-12-31" }, NOW),
    );
    await check(s, id("mrr"), "month", NOW);
    expect((await open()).some((i) => i.kind === "goal_risk")).toBe(false);
    await s.tenant((tx) =>
      saveGoal(tx, ctx(), { id: goal.id, metricId: id("mrr"), target: 500_000, due: "2026-12-31" }, NOW),
    );
    await check(s, id("mrr"), "month", NOW);
    await s.tenant((tx) => deleteGoal(tx, s.orgId, goal.id));
    expect((await open()).some((i) => i.kind === "goal_risk")).toBe(false);
  });

  it("finds it again as the same insight, and a dismissed one stays dismissed", async () => {
    const again = await check(s, id("new_accounts"), "month", NOW);
    const insight = (await open()).find((i) => i.kind === "anomaly" && i.claims?.grain === "month");
    expect([again.filed, insight?.occurrences]).toEqual([[], 2]);
    expect(await s.tenant((tx) => dismissInsight(tx, ctx(), insight?.id as string, "known_issue"))).toBe(true);
    expect(await s.tenant((tx) => dismissInsight(tx, ctx(), insight?.id as string, "known_issue"))).toBe(false);
    expect((await check(s, id("new_accounts"), "month", NOW)).found).toEqual([]);
    expect((await open()).some((i) => i.kind === "anomaly" && i.period === "2026-09-01")).toBe(false);
  });

  it("waits for a period that hasn't landed: one incident for the source, resolved once nothing waits", async () => {
    const before = await s.tenant((tx) => openInsightCount(tx, { orgId: s.orgId, userId: null }));
    // Two months on from the clock's: the demo MRR's months run to the database's own month (now()), so the first
    // month missing is next month.
    const today = new Date();
    const ahead = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 2, 2, 9));
    const missing = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" }).format(
      new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1)),
    );
    expect(await check(s, id("mrr"), "month", ahead)).toMatchObject({ status: "waiting" });
    expect(await check(s, id("new_accounts"), "week", ahead)).toMatchObject({ status: "waiting" });
    const late = (await open()).filter((i) => i.kind === "data_quality");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({
      title: expect.stringMatching(new RegExp(`'s data for ${missing} hasn't arrived$`)),
      occurrences: 2,
      claims: null,
    });
    expect(await s.tenant((tx) => openInsightCount(tx, { orgId: s.orgId, userId: null }))).toBe(before + 1);
    // Back on time for one of them: the other still waits, so the source is still late.
    expect(await check(s, id("mrr"), "month", NOW)).toMatchObject({ status: "ok" });
    expect((await open()).filter((i) => i.kind === "data_quality")).toHaveLength(1);
    expect(await check(s, id("new_accounts"), "week", NOW)).toMatchObject({ status: "ok" });
    expect((await open()).filter((i) => i.kind === "data_quality")).toHaveLength(0);
  });

  it("says it couldn't run when its dead letter gives up, and tries again the next morning where the workspace is", async () => {
    const monthly = (await checkOf(s, id("mrr"), "month")) as string;
    const evening = new Date("2026-10-11T20:00:00Z");
    await checkFailed(s.deps, { orgId: s.orgId, checkId: monthly }, evening);
    const [c] = await s.t.owner<{ state: { lastStatus: string; lastError: string }; next_check_at: Date }[]>`
      select state, next_check_at from app.metric_check where id = ${monthly}`;
    expect(c?.state).toMatchObject({ lastStatus: "error", lastError: "It stopped the worker twice." });
    const [o] = await s.t.owner<{ tz: string }[]>`select tz from app.org where id = ${s.orgId}`;
    expect(c?.next_check_at.toISOString()).toBe(
      checkHourFrom(new Date(evening.getTime() + 1), o?.tz ?? "UTC").toISOString(),
    );
    expect(c?.next_check_at.getTime()).toBeGreaterThan(evening.getTime());
  });

  it("is queued by the dispatcher when due, once, and removed with its last watcher, its traces kept", async () => {
    const queue = (now: Date) =>
      queueDueChecks(
        { withSystem: (fn) => withSystemOn(s.t.system, fn), withTenant: s.deps.withTenant, boss: s.boss },
        now,
      );
    await s.t.owner`update app.metric_check set next_check_at = ${NOW} where org_id = ${s.orgId}`;
    expect(await queue(NOW)).toBe(3);
    expect(await queue(NOW)).toBe(0);
    const jobs = await s.t.owner<{ count: number }[]>`
      select count(*)::int as count from pgboss.job where name = 'metric.check' and data->>'orgId' = ${s.orgId}`;
    expect(jobs[0]?.count).toBe(3);
    const weekly = (await checkOf(s, id("new_accounts"), "week")) as string;
    expect(await s.tenant((tx) => unwatchMetric(tx, actor(s), id("new_accounts"), NOW))).toBe(true);
    expect(await checkOf(s, id("new_accounts"), "week")).toBeNull();
    expect(await checkOf(s, id("new_accounts"), "month")).toBeNull();
    // Its query cells still open: a check nothing watches keeps its traces.
    const [q] = await s.t.owner<{ id: string }[]>`
      select id from app.query_run where org_id = ${s.orgId} and requester_type = 'check' and requester_id = ${weekly}
      limit 1`;
    expect(await getQueryCard(s.deps, { orgId: s.orgId, userId: uuidv7() }, q?.id as string)).not.toBeNull();
    // The last one unwatched, so is Watching itself.
    await s.tenant((tx) => unwatchMetric(tx, actor(s), id("mrr"), NOW));
    expect(await s.tenant((tx) => getWatching(tx, actor(s)))).toBeNull();
    const [left] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.metric_check where org_id = ${s.orgId} and deleted_at is null`;
    expect(left?.n).toBe(0);
  });
});

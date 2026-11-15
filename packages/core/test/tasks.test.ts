// Tasks v0: made from an insight, started and done by their owner (or an admin), and checked once done: the metric's
// horizon months against what its prior trend projected, from query-run cells, with no model involved.
import { uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  checkDefinitions,
  checkOutcome,
  createTask,
  demoPack,
  getQueryCard,
  installDefinitions,
  listDefinitions,
  listInsights,
  listTasks,
  queueDueOutcomeChecks,
  setTaskStatus,
  TaskProblem,
  verifyDefinitions,
  watchMetric,
} from "../src";
import { check } from "./helpers/checks";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
const bob = uuidv7();
let insightId = "";
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const as = (userId: string, canManage = false) => ({ orgId: s.orgId, userId, canManage });
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof TaskProblem) return error.message;
    throw error;
  }
};
const tasks = (status: "open" | "closed" = "open") => s.tenant((tx) => listTasks(tx, ctx(), { status }));
const make = (title: string, horizonMonths = 2, now = NOW) =>
  s.tenant((tx) => createTask(tx, ctx(), { insightId, title, direction: "up", horizonMonths }, now));

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx(),
      list.map((d) => d.id),
    ),
  );
  const metricId = list.find((d) => d.slug === "new_accounts")?.id as string;
  await s.tenant((tx) => watchMetric(tx, { ...ctx(), canManage: true }, metricId, NOW));
  // September's dip in new accounts, judged on its months.
  insightId = (await check(s, metricId, "month", NOW)).filed[0] as string;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("a task", () => {
  it("is made from an insight, owned by whoever made it, and refuses what doesn't fit", async () => {
    const id = await make("Find why September sign-ups dropped");
    const [task] = await tasks();
    expect(task).toMatchObject({
      id,
      title: "Find why September sign-ups dropped",
      status: "accepted",
      insight: {
        id: insightId,
        title: "New accounts fell more than usual in September 2026",
        value: "77",
        note: "expected 84–94",
      },
      metric: { title: "New accounts" },
      direction: "up",
      horizonMonths: 2,
      mine: true,
      outcome: null,
    });
    expect((await s.tenant((tx) => listInsights(tx, { orgId: s.orgId, userId: null })))[0]?.tasks).toBe(1);
    const refused = (input: Partial<Parameters<typeof createTask>[2]>) =>
      problem(
        s.tenant((tx) =>
          createTask(tx, ctx(), { insightId, title: "x", direction: "up", horizonMonths: 2, ...input }, NOW),
        ),
      );
    expect(await refused({ title: "  " })).toBe("Say what the task is.");
    expect(await refused({ horizonMonths: 4 })).toBe("Judge it over 1, 2, 3 or 6 months.");
    expect(await refused({ dueAt: "2026-10-01" })).toBe("Pick a due date from today on.");
    expect(await refused({ insightId: uuidv7() })).toBe("That insight doesn't exist, or has no metric to move.");
  });

  it("is started and done by its owner or an admin, never by someone else, and done is final", async () => {
    const [task] = await tasks();
    const id = task?.id as string;
    expect(await problem(s.tenant((tx) => setTaskStatus(tx, as(bob), id, "in_progress")))).toBe(
      "Only its owner changes this task.",
    );
    await s.tenant((tx) => setTaskStatus(tx, as(bob, true), id, "in_progress", NOW));
    // Done in June: judged over July and August, checked the morning of September 1.
    await s.tenant((tx) => setTaskStatus(tx, as(s.userId), id, "done", new Date("2026-06-15T10:00:00Z")));
    expect(await problem(s.tenant((tx) => setTaskStatus(tx, as(s.userId), id, "dismissed")))).toBe(
      "It's done already.",
    );
    const [done] = await tasks("closed");
    expect(done).toMatchObject({ status: "done", checkAt: "2026-09-01T06:00:00.000Z", outcome: null });
  });

  it("has its outcome checked once due: the horizon's last month against its prior trend, from a query cell", async () => {
    const queue = (now: Date) =>
      queueDueOutcomeChecks(
        { withSystem: (fn) => withSystemOn(s.t.system, fn), withTenant: s.deps.withTenant, boss: s.boss },
        now,
      );
    expect(await queue(new Date("2026-08-31T09:00:00Z"))).toBe(0);
    expect(await queue(new Date("2026-09-01T07:00:00Z"))).toBe(1);
    expect(await queue(new Date("2026-09-01T07:01:00Z"))).toBe(0);
    const [done] = await tasks("closed");
    const result = await checkOutcome(
      s.deps,
      { orgId: s.orgId, todoId: done?.id as string },
      new Date("2026-09-01T07:02:00Z"),
    );
    expect(result.status).toBe("checked");
    const [checked] = await tasks("closed");
    const o = checked?.outcome;
    expect(o).toMatchObject({
      observed: { period: "2026-08-01", value: 88, display: "88", column: "new_accounts" },
      trendMonths: 6,
    });
    expect(["improved", "no_change", "worsened"]).toContain(o?.verdict);
    expect(o?.projected?.display).toMatch(/^\d+$/);
    expect(o?.delta).toBeCloseTo((88 - (o?.projected?.value as number)) / (o?.projected?.value as number), 6);
    // Its cell opens for anyone in the organization; checking again changes nothing.
    const card = await getQueryCard(s.deps, { orgId: s.orgId, userId: bob }, o?.observed?.queryRunId as string);
    expect(card?.preview?.[o?.observed?.row as number]?.map(String)).toContain("88");
    expect((await checkOutcome(s.deps, { orgId: s.orgId, todoId: done?.id as string }, NOW)).status).toBe("skipped");
  });

  it("waits for a horizon month that hasn't landed, then says it's inconclusive", async () => {
    // Done in October, judged over November: the demo company has no November yet.
    const id = await make("Call back the churned trials", 1);
    await s.tenant((tx) => setTaskStatus(tx, as(s.userId), id, "done", NOW));
    expect((await checkOutcome(s.deps, { orgId: s.orgId, todoId: id }, new Date("2026-12-02T07:00:00Z"))).status).toBe(
      "waiting",
    );
    expect(await checkOutcome(s.deps, { orgId: s.orgId, todoId: id }, new Date("2026-12-20T07:00:00Z"))).toMatchObject({
      status: "checked",
      verdict: "inconclusive",
    });
    const task = (await tasks("closed")).find((t) => t.id === id);
    expect(task?.outcome).toMatchObject({
      verdict: "inconclusive",
      reason: "The horizon's last month has no value yet.",
    });
  });

  it("is dismissed, and no longer counts on its insight", async () => {
    const id = await make("A duplicate");
    await s.tenant((tx) => setTaskStatus(tx, as(s.userId), id, "dismissed", NOW));
    expect((await tasks("closed")).find((t) => t.id === id)?.status).toBe("dismissed");
    expect((await s.tenant((tx) => listInsights(tx, { orgId: s.orgId, userId: null })))[0]?.tasks).toBe(2);
    expect(await tasks()).toEqual([]);
  });

  it("is made from a trend too, quoting how the metric changed before and lately", async () => {
    const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
    const mrr = list.find((d) => d.slug === "mrr")?.id as string;
    await s.tenant((tx) => watchMetric(tx, { ...ctx(), canManage: true }, mrr, NOW));
    const [trendId] = (await check(s, mrr, "month", NOW)).filed;
    const id = await s.tenant((tx) =>
      createTask(
        tx,
        ctx(),
        { insightId: trendId as string, title: "Win back growth", direction: "up", horizonMonths: 3 },
        NOW,
      ),
    );
    expect((await tasks()).find((t) => t.id === id)?.insight).toMatchObject({
      title: "Monthly recurring revenue's growth slowed over the last 3 months",
      value: "$412.6k",
      note: "was 7% a month, lately 5.1% a month",
    });
  });
});

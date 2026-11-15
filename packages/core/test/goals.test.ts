// Goals: on a verified metric, its direction taken from the metric, a target and a due day; applied when
// saved; listed with the metric's latest tested value; a deleted metric leaves the goal without one.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ContextProblem, deleteGoal, demoPack, installDefinitions, listGoals, saveGoal } from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const ids: Record<string, string> = {};
const NOW = new Date("2026-10-11T09:00:00Z");
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof ContextProblem) return error.message;
    throw error;
  }
};
const goals = () => s.tenant((tx) => listGoals(tx, s.orgId));

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "verified", source: "pack" }),
  );
  for (const r of await s.t.owner<{ id: string; slug: string }[]>`
    select id, slug from app.context_item where connection_id = ${s.connectionId} and kind = 'metric'`) {
    ids[r.slug] = r.id;
  }
  // What MRR's last test read (the checks job writes it; here it's set).
  await s.t.owner`
    update app.context_item_version v set derived = ${s.t.owner.json({
      status: "passed",
      checkedAt: "2026-10-11T08:00:00Z",
      sample: { label: "Last month", period: "2026-09-01", value: 412600 },
    } as never)}
    from app.context_item i where i.id = v.item_id and v.version = i.released_version and i.id = ${ids.mrr as string}`;
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("goals", () => {
  it("are set on a verified metric, with its direction, and apply when saved", async () => {
    const saved = await s.tenant((tx) =>
      saveGoal(tx, ctx(), { metricId: ids.mrr as string, target: 500_000, due: "2026-12-31" }, NOW),
    );
    expect(saved.version).toBe(1);
    const [g] = await goals();
    expect(g).toMatchObject({
      id: saved.id,
      title: "Monthly recurring revenue to $500k by Dec 31, 2026",
      spec: { metric: ids.mrr, target: 500_000, due: "2026-12-31", direction: "at_least" },
      metric: { id: ids.mrr, title: "Monthly recurring revenue", format: "usd" },
      current: { value: 412_600, period: "2026-09-01", checkedAt: "2026-10-11T08:00:00Z" },
    });
    const [row] = await s.t.owner<{ status: string; released_version: number }[]>`
      select status, released_version from app.context_item where id = ${saved.id}`;
    expect(row).toEqual({ status: "verified", released_version: 1 });
  });

  it("takes a keep-below direction from a metric where lower is better, and refuses what doesn't fit", async () => {
    const churned = await s.tenant((tx) =>
      saveGoal(tx, ctx(), { metricId: ids.churned_mrr as string, target: 8_000, due: "2026-12-31" }, NOW),
    );
    expect((await goals()).find((g) => g.id === churned.id)?.spec.direction).toBe("at_most");
    expect((await goals()).find((g) => g.id === churned.id)?.current).toBeNull();
    const refused = (input: Parameters<typeof saveGoal>[2]) =>
      problem(s.tenant((tx) => saveGoal(tx, ctx(), input, NOW)));
    expect(await refused({ metricId: "01a126d7-0000-7000-8000-000000000000", target: 1, due: "2026-12-31" })).toBe(
      "Pick a verified metric.",
    );
    expect(await refused({ metricId: ids.mrr as string, target: Number.NaN, due: "2026-12-31" })).toBe(
      "The target is a number.",
    );
    expect(await refused({ metricId: ids.mrr as string, target: 1, due: "2026-02-30" })).toBe(
      "The due date is a day: YYYY-MM-DD.",
    );
    expect(await refused({ metricId: ids.mrr as string, target: 1, due: "2026-10-01" })).toBe(
      "Pick a due date from today on.",
    );
  });

  it("edits as a new version that applies at once, and lists a goal whose metric is gone without a value", async () => {
    const mrrGoal = (await goals()).find((g) => g.spec.metric === ids.mrr);
    const edited = await s.tenant((tx) =>
      saveGoal(
        tx,
        ctx(),
        { id: mrrGoal?.id as string, metricId: ids.mrr as string, target: 450_000, due: "2026-12-31" },
        NOW,
      ),
    );
    expect(edited.version).toBe(2);
    expect((await goals()).find((g) => g.id === edited.id)).toMatchObject({ version: 2, spec: { target: 450_000 } });
    await s.t.owner`update app.context_item set deleted_at = now() where id = ${ids.mrr as string}`;
    expect((await goals()).find((g) => g.id === edited.id)).toMatchObject({ metric: null, current: null });
    // deleteGoal removes goals only: a metric's id isn't one.
    expect(await s.tenant((tx) => deleteGoal(tx, s.orgId, ids.paying_customers as string))).toBe(false);
    expect(await s.tenant((tx) => deleteGoal(tx, s.orgId, edited.id))).toBe(true);
    expect((await goals()).map((g) => g.id)).not.toContain(edited.id);
  });
});

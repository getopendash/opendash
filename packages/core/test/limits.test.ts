// Spend limits: the month's and the day's spend against an
// organization's limits, a question refused once one is reached (and not a cent before), evals held to them too,
// questions already running left to finish, and the dispatcher's warning at 80%.
import { type SystemTx, uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BACKGROUND_BUDGET_USD,
  BackgroundBudgetReached,
  BUDGETS,
  checkBackgroundBudget,
  claimRun,
  failRunFromQueue,
  failStaleQueuedRuns,
  RUN_CEILING_USD,
  runCeiling,
  SpendLimitProblem,
  SpendLimitReached,
  setSpendLimits,
  spendView,
  startEvalRun,
  submitQuestion,
  warnSpend,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const ctx = () => ({ orgId: s.orgId, userId: s.userId });
const ask = (text = "MRR?") =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text, channel: "web", model: "m" },
  );
const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
    return "asked";
  } catch (error) {
    if (error instanceof SpendLimitReached || error instanceof SpendLimitProblem) return error.message;
    throw error;
  }
};
/** One priced call, now (or `daysAgo` days back, still this month when the test runs after the 2nd). */
const spend = (usd: number, at: Date = new Date(), background = false) =>
  s.t.system.client`
    insert into app.usage_event (id, org_id, kind, qty, unit, model, provider, key_source, cost_usd, source_type, source_id,
      background)
    values (app.uuidv7_floor(${at.toISOString()}::timestamptz), ${s.orgId}, 'llm_tokens', 100, 'tokens',
      'claude-sonnet-5-5', 'anthropic', 'deployment', ${usd}, 'run', ${uuidv7()}, ${background})`;
const finish = async (runId: string) =>
  s.t.owner`update app.run set status = 'failed', error = 'test', finished_at = now() where id = ${runId}`;

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("spend limits", () => {
  it("are none until an admin sets them, and only positive amounts", async () => {
    const v = await s.tenant((tx) => spendView(tx, s.orgId));
    expect(v.limits).toEqual({
      monthlyUsd: null,
      dailyUsd: null,
      backgroundMonthlyUsd: BACKGROUND_BUDGET_USD,
      runCeilingUsd: RUN_CEILING_USD,
    });
    await finish((await ask()).runId);
    expect(await refusal(s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 0, dailyUsd: null })))).toBe(
      "The monthly limit has to be more than $0 and at most $1,000,000, or empty for none.",
    );
    expect(await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 200.004, dailyUsd: 5 }))).toEqual({
      monthlyUsd: 200,
      dailyUsd: 5,
      backgroundMonthlyUsd: 10,
      runCeilingUsd: RUN_CEILING_USD,
    });
    // A run's ceiling: kept when left out, none when null, only a positive amount.
    expect(
      (await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 200, dailyUsd: 5, runCeilingUsd: null })))
        .runCeilingUsd,
    ).toBeNull();
    expect(
      await refusal(s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 200, dailyUsd: 5, runCeilingUsd: 0 }))),
    ).toBe("A run's ceiling has to be between $0.01 and $10,000, or none.");
    expect(
      (await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 200, dailyUsd: 5, runCeilingUsd: 3 })))
        .runCeilingUsd,
    ).toBe(3);
    expect(await s.tenant((tx) => runCeiling(tx, s.orgId))).toBe(3);
  });

  it("refuse a question once today's spend reaches the daily limit, and not a cent before", async () => {
    await spend(4.99);
    const before = await ask();
    await finish(before.runId);
    expect((await s.tenant((tx) => spendView(tx, s.orgId))).spent.day).toBeCloseTo(4.99, 6);
    await spend(0.01);
    expect(await refusal(ask())).toBe(
      "Acme has reached today's $5.00 limit for AI. Questions start again at 00:00 UTC, or an owner or admin can raise the limit in Settings → Usage. Questions already running finish.",
    );
    // A follow-up is a question too.
    expect(
      await refusal(
        submitQuestion(
          { withTenant: s.deps.withTenant, boss: null },
          {
            orgId: s.orgId,
            userId: s.userId,
            connectionId: s.connectionId,
            threadId: before.threadId,
            text: "And?",
            channel: "web",
            model: "m",
          },
        ),
      ),
    ).toMatch(/today's \$5\.00 limit/);
  });

  it("let a question already queued run, and evals not start", async () => {
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 200, dailyUsd: null }));
    const queued = await ask("Queued before the limit");
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 200, dailyUsd: 5 }));
    // The worker never checks: a run that's in finishes.
    const claimed = await claimRun(s.deps, { orgId: s.orgId, runId: queued.runId }, "t");
    expect(claimed?.id).toBe(queued.runId);
    await finish(queued.runId);
    expect(
      await refusal(startEvalRun({ withTenant: s.deps.withTenant, boss: s.boss }, { ...ctx(), trigger: "manual" })),
    ).toMatch(/today's \$5\.00 limit/);
  });

  it("refuse past the monthly limit with when it starts again", async () => {
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 5, dailyUsd: null }));
    const next = new Date();
    const on = new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 1)).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    });
    expect(await refusal(ask())).toBe(
      `Acme has reached this month's $5.00 limit for AI. Questions start again on ${on}, or an owner or admin can raise the limit in Settings → Usage. Questions already running finish.`,
    );
    // Raised: asking works again.
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: 500, dailyUsd: null }));
    await finish((await ask()).runId);
  });

  it("keep background work to a budget of its own, which the questions' limits never count", async () => {
    // Background work's spend (an investigation's) counts only toward its own budget: the questions' don't move.
    const before = await s.tenant((tx) => spendView(tx, s.orgId));
    await spend(9.99, new Date(), true);
    const after = await s.tenant((tx) => spendView(tx, s.orgId));
    expect(after.spent.month).toBeCloseTo(before.spent.month, 6);
    expect(after.spent.day).toBeCloseTo(before.spent.day, 6);
    expect(after.spent.background).toBeCloseTo(before.spent.background + 9.99, 6);
    const held = async () => {
      try {
        await s.tenant((tx) => checkBackgroundBudget(tx, s.orgId));
        return "runs";
      } catch (error) {
        if (error instanceof BackgroundBudgetReached) return error.message;
        throw error;
      }
    };
    expect(await held()).toBe("runs");
    // A hard stop at the budget, until the month resets or an owner raises it.
    await spend(0.02, new Date(), true);
    expect(await held()).toMatch(/^This month's background budget \(\$10\.00\) is spent\. It starts again on /);
    // Raised, it runs again; setting the questions' limits alone leaves it as it is; $0 turns it off.
    const limits = { monthlyUsd: null, dailyUsd: null };
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: 25 }));
    expect(await held()).toBe("runs");
    expect((await s.tenant((tx) => setSpendLimits(tx, ctx(), limits))).backgroundMonthlyUsd).toBe(25);
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: 0 }));
    expect(await held()).toBe("Background work is off: an owner or admin can give it a budget in Settings → Usage.");
    expect(await refusal(s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: -1 })))).toBe(
      "The background budget has to be between $0 (off) and $1,000,000.",
    );
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: 10 }));
  });

  it("warn at 80% of a limit, once per period, and clear when the limit is raised", async () => {
    const deps = { withSystem: <T>(fn: (tx: SystemTx) => Promise<T>) => withSystemOn(s.t.system, fn) };
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: 6.4 }));
    // $5.00 spent today: 78%.
    await warnSpend(deps);
    const alerts = () =>
      s.t.owner<{ subject: string; message: string; count: number; resolved_at: Date | null }[]>`
        select subject, message, count, resolved_at from app.ops_alert where kind = 'spend' order by first_seen_at`;
    expect(await alerts()).toEqual([]);
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: 6 }));
    await warnSpend(deps);
    await warnSpend(deps);
    const [open] = await alerts();
    expect(open).toMatchObject({ count: 2, resolved_at: null });
    expect(open?.message).toBe(
      "$5.00 spent, 83% of today's $6.00 limit. New questions stop at the limit; an owner or admin can raise it.",
    );
    // Past the limit, it says the questions have stopped.
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: 4 }));
    await warnSpend(deps);
    expect((await alerts())[0]?.message).toBe(
      "$5.00 spent: today's $4.00 limit is reached, and new questions are refused until 00:00 UTC. An owner or admin can raise it.",
    );
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: 100 }));
    expect(await warnSpend(deps)).toBe(1);
    expect((await alerts())[0]?.resolved_at).not.toBeNull();
  });

  // 30 runs started together once each saw the same room and spent 1.5x a $10 budget.
  it("count what unfinished runs may still spend, so work started together can't pass a limit", async () => {
    const analystCap = BUDGETS.agent.runCostCapsUsd.analyst;
    // Background work: a budget with room for two analyst runs' caps on top of what's spent.
    const spent = (await s.tenant((tx) => spendView(tx, s.orgId))).spent.background;
    const limits = { monthlyUsd: null, dailyUsd: null };
    await s.tenant((tx) =>
      setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: spent + 2 * analystCap + 0.5 }),
    );
    const background = async () => {
      const { runId } = await ask("A routine's question");
      await s.t.owner`update app.run set trigger = 'routine' where id = ${runId}`;
      return runId;
    };
    const held = async () => {
      try {
        await s.tenant((tx) => checkBackgroundBudget(tx, s.orgId));
        return "runs";
      } catch (error) {
        if (error instanceof BackgroundBudgetReached) return error.message;
        throw error;
      }
    };
    const first = await background();
    const second = await background();
    expect(await held()).toBe("runs");
    const third = await background();
    expect(await held()).toMatch(/is taken by background work still running\. It goes on when that ends/);
    // What a run has spent no longer holds room; a finished run holds none.
    await s.t
      .owner`update app.run set usage = jsonb_build_object('costUsd', ${analystCap}::numeric) where id = ${third}`;
    expect(await held()).toBe("runs");
    await s.t.owner`update app.run set usage = '{}'::jsonb where id = ${third}`;
    expect(await held()).toMatch(/still running/);
    // A run past an attempt's expiry still holds: pg-boss runs it again. One past every attempt it could have (a worker
    // gone mid-way) doesn't. A queued one holds however long it waits, until it runs or is failed for waiting too long.
    await s.t.owner`update app.run set status = 'running', started_at = now() - interval '30 minutes',
      attempt_started_at = now() - interval '30 minutes' where id = ${third}`;
    expect(await held()).toMatch(/still running/);
    await s.t.owner`update app.run set started_at = now() - interval '3 hours' where id = ${third}`;
    expect(await held()).toBe("runs");
    await s.t.owner`update app.run set status = 'queued', started_at = null, queued_at = now() - interval '13 days'
      where id = ${third}`;
    expect(await held()).toMatch(/still running/);
    await s.t.owner`update app.run set queued_at = now() - interval '15 days' where id = ${third}`;
    expect(await held()).toMatch(/still running/);
    // One a worker took meanwhile stays: the failing update checks it's still queued from before.
    await s.t.owner`update app.run set status = 'running' where id = ${third}`;
    expect(await failRunFromQueue(s.deps, { orgId: s.orgId, runId: third }, "x", new Date().toISOString())).toBe(false);
    await s.t.owner`update app.run set status = 'queued' where id = ${third}`;
    const system = <T>(fn: (tx: SystemTx) => Promise<T>) => withSystemOn(s.t.system, fn);
    expect(await failStaleQueuedRuns({ withTenant: s.deps.withTenant, withSystem: system, boss: null })).toBe(1);
    expect(await held()).toBe("runs");
    for (const id of [first, second, third]) await finish(id);
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: 10 }));

    // Questions: two running questions' caps fill today's limit, so a third waits for them.
    const day = (await s.tenant((tx) => spendView(tx, s.orgId))).spent.day;
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: day + 2 * analystCap }));
    const a = await ask("One");
    const b = await ask("Two");
    expect(await refusal(ask("Three"))).toMatch(/^Questions still running take up the rest of today's \$/);
    await finish(a.runId);
    const c = await ask("Three again");
    for (const id of [b.runId, c.runId]) await finish(id);
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { monthlyUsd: null, dailyUsd: null }));
  });

  it("count a call recorded while an admission waited for its turn", async () => {
    const limits = { monthlyUsd: null, dailyUsd: null };
    const spent = (await s.tenant((tx) => spendView(tx, s.orgId))).spent.background;
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: spent + 1 }));
    // An admission that began a minute ago, before this dollar was recorded: it still counts.
    const began = new Date(Date.now() - 60_000);
    await spend(1, new Date(), true);
    await expect(s.tenant((tx) => checkBackgroundBudget(tx, s.orgId, began))).rejects.toThrow(BackgroundBudgetReached);
    await s.tenant((tx) => setSpendLimits(tx, ctx(), { ...limits, backgroundMonthlyUsd: 10 }));
  });
});

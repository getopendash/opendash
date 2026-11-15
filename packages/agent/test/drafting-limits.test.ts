// draft_tables' limits, offline: the drafter's run itself is stood in for (runAttempt), so what's tested is
// what the lead's tool does around it, on the real ledger: what a drafter spends is the lead's once, however its run
// ends, and all it may have spent when that can't be read; two calls for one drafter run it once; groups handed out
// together share the lead's money fairly, wait for it, and stop waiting at a shutdown; a drafter picked up again keeps
// the time it already worked. And what the harness picks up when a lead resumes: only work that was admitted, each
// report written once.
import { type ClaimedRun, childRun, claimRun, requestSourceDrafts } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CUT_SHORT } from "../src/harness/tool-runner";
import type { ToolContext, ToolResult } from "../src/tools/types";

type Limits = { maxCostUsd: number; wallMs: number; wrapUpAtMs: number };
const child = vi.hoisted(() => ({
  runs: [] as { runId: string; limits: Limits }[],
  act: async (_runId: string): Promise<unknown> => ({ status: "succeeded" }),
}));
vi.mock("../src/harness/run", async (original) => ({
  ...(await original<typeof import("../src/harness/run")>()),
  runAttempt: async (_deps: unknown, job: { runId: string }, options: { limits: Limits }) => {
    child.runs.push({ runId: job.runId, limits: options.limits });
    return child.act(job.runId);
  },
}));
const { draftTables } = await import("../src/tools/delegate");
const { resumeOwed } = await import("../src/harness/resume");

let s: LearnedSource;
const batches: string[] = [];

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterEach(async () => {
  // Each case starts from a source with no batch drafting, and no run of one unfinished: an unfinished lead holds its
  // cap of the background budget (core usage/limits.ts).
  for (const id of batches.splice(0)) await s.t.owner`update app.proposal set status = 'rejected' where id = ${id}`;
  await s.t.owner`
    update app.run set status = 'cancelled', finished_at = now()
    where org_id = ${s.orgId} and profile in ('modeler', 'drafter') and status in ('queued', 'running', 'cancelling')`;
  child.runs = [];
});

afterAll(async () => {
  await s?.close();
});

const BATCH = ["public.plans", "billing.credits", "billing.refunds"];

/** A lead claimed for its first attempt, as the harness would hand its tools: its dollars, and ten minutes left. */
async function leading(maxCostUsd: number): Promise<ToolContext> {
  const { proposalId } = await requestSourceDrafts(
    { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
    { orgId: s.orgId, userId: s.userId },
    { connectionId: s.connectionId, tables: BATCH },
  );
  batches.push(proposalId);
  const [p] = await s.t.owner<{ run_id: string }[]>`select run_id from app.proposal where id = ${proposalId}`;
  const run = (await claimRun(s.deps, { orgId: s.orgId, runId: p?.run_id as string }, "t")) as ClaimedRun;
  return {
    deps: { withTenant: s.deps.withTenant, secrets: s.secrets, edition: "community" },
    run,
    source: { connectionId: s.connectionId, name: "demo" },
    state: { costUsd: 0, failedQueries: 0, queries: 0, toolCalls: 0 },
    attempt: { workerId: "t", maxCostUsd, timeLeftMs: () => 600_000 },
  } as unknown as ToolContext;
}

const hand = (ctx: ToolContext, tables: string[], signal = new AbortController().signal): Promise<ToolResult> =>
  draftTables.execute({ tables }, ctx, { rowId: "row", signal });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a drafter's model calls would add to its run's spend. */
const spend = (runId: string, usd: number) =>
  s.t.owner`update app.run set usage = usage || jsonb_build_object('costUsd',
    coalesce((usage->>'costUsd')::numeric, 0) + ${usd}::numeric) where id = ${runId}`;
const end = (runId: string) =>
  s.t.owner`update app.run set status = 'succeeded', finished_at = now() where id = ${runId}`;

describe("draft_tables", () => {
  it("charges the lead what a drafter spent once, when its run throws as when it ends", async () => {
    const ctx = await leading(2);
    child.act = async (runId) => {
      await spend(runId, 0.3);
      throw new Error("The model call failed: busy (529)");
    };
    await expect(hand(ctx, ["public.plans"])).rejects.toThrow(/busy/);
    expect(ctx.state.costUsd).toBeCloseTo(0.3, 6);
    // Handed out again, the same drafter goes on: only what it spends now is added.
    child.act = async (runId) => {
      await spend(runId, 0.1);
      await end(runId);
      return { status: "succeeded" };
    };
    expect((await hand(ctx, ["public.plans"])).value).toMatchObject({ status: "done" });
    expect(ctx.state.costUsd).toBeCloseTo(0.4, 6);
    // Ended, it's its result: not run again, nothing more charged.
    expect((await hand(ctx, ["public.plans"])).value).toMatchObject({ status: "done" });
    expect(child.runs).toHaveLength(2);
    expect(ctx.state.costUsd).toBeCloseTo(0.4, 6);
  });

  it("runs a drafter once for two calls in one step, however they write its tables", async () => {
    const ctx = await leading(2);
    child.act = async (runId) => {
      await new Promise((r) => setTimeout(r, 300));
      await spend(runId, 0.2);
      await end(runId);
      return { status: "succeeded" };
    };
    const [a, b] = await Promise.all([hand(ctx, ["billing.credits"]), hand(ctx, ["BILLING.CREDITS "])]);
    expect(child.runs).toHaveLength(1);
    expect(a.value).toEqual(b.value);
    expect(ctx.state.costUsd).toBeCloseTo(0.2, 6);
  });

  it("gives groups handed out together a fair share of the batch's dollars, and refuses none", async () => {
    // The batch's own budget for three tables: $2, where each group alone could take $1.
    const ctx = await leading(2);
    child.act = async (runId) => {
      await new Promise((r) => setTimeout(r, 200));
      await end(runId);
      return { status: "succeeded" };
    };
    const results = await Promise.all(BATCH.map((t) => hand(ctx, [t])));
    for (const r of results) expect(r.value).toMatchObject({ status: "done" });
    expect(child.runs).toHaveLength(3);
    const caps = child.runs.map((r) => r.limits.maxCostUsd);
    for (const c of caps) expect(c).toBeCloseTo(2 / 3, 2);
    expect(caps.reduce((n, c) => n + c, 0)).toBeLessThanOrEqual(2 + 1e-9);
  });

  it("gives the last group what's left, not a share kept for groups that won't come", async () => {
    const ctx = await leading(2);
    child.act = async (runId) => {
      await end(runId);
      return { status: "succeeded" };
    };
    await hand(ctx, ["public.plans", "billing.credits"]);
    ctx.state.costUsd = 1.4;
    await hand(ctx, ["billing.refunds"]);
    expect(child.runs.at(-1)?.limits.maxCostUsd).toBeCloseTo(0.6, 6);
  });

  it("keeps the time a drafter worked before it was handed off, and gives it the lead's time left besides", async () => {
    const ctx = await leading(2);
    child.act = async (runId) => {
      // Its first attempt worked a minute, then the worker shut down.
      await s.t.owner`update app.run set attempt = 1 where id = ${runId}`;
      await s.t.owner`
        insert into app.run_event (id, org_id, run_id, attempt, seq, type, data, created_at)
        values (${uuidv7()}, ${s.orgId}, ${runId}, 1, 1, 'step', '{}'::jsonb, now() - interval '90 seconds'),
          (${uuidv7()}, ${s.orgId}, ${runId}, 1, 2, 'attempt_ended', '{"reason": "shutdown"}'::jsonb,
            now() - interval '30 seconds')`;
      return { status: "handed_off" };
    };
    expect((await hand(ctx, ["billing.refunds"])).value).toMatchObject({ status: "unfinished" });
    child.act = async (runId) => {
      await end(runId);
      return { status: "succeeded" };
    };
    await hand(ctx, ["billing.refunds"]);
    const [first, second] = child.runs;
    expect(first?.limits).toMatchObject({ wallMs: 600_000, wrapUpAtMs: 480_000 });
    expect(second?.limits.wallMs).toBeGreaterThanOrEqual(659_000);
    expect(second?.limits.wallMs).toBeLessThanOrEqual(661_000);
    expect((second?.limits.wrapUpAtMs ?? 0) - (second?.limits.wallMs ?? 0)).toBe(-120_000);
  });

  it("counts all a drafter may have spent when its spend can't be read, so nothing more is granted against it", async () => {
    const ctx = await leading(2);
    let failNext = false;
    ctx.deps = {
      ...ctx.deps,
      withTenant: (orgId, fn) => {
        if (failNext) {
          failNext = false;
          return Promise.reject(new Error("connection reset"));
        }
        return s.deps.withTenant(orgId, fn);
      },
    };
    child.act = async (runId) => {
      await spend(runId, 0.3);
      // The read that settles it fails; the ledger works again after.
      failNext = true;
      throw new Error("The model call failed: busy (529)");
    };
    await expect(hand(ctx, ["public.plans"])).rejects.toThrow(/busy/);
    // Its whole cap: a third of $2 (three groups could start), not the $0.30 it spent.
    expect(child.runs[0]?.limits.maxCostUsd).toBeCloseTo(2 / 3, 6);
    expect(ctx.state.costUsd).toBeCloseTo(2 / 3, 6);
    child.act = async (runId) => {
      await end(runId);
      return { status: "succeeded" };
    };
    await hand(ctx, ["billing.credits"]);
    // The next group shares what's left after that cap: ($2 − $0.67) / 3.
    expect(child.runs.at(-1)?.limits.maxCostUsd).toBeCloseTo((2 - 2 / 3) / 3, 6);
  });

  it("gives what's left to one group when nothing runs, and the rest wait for it rather than being refused", async () => {
    // $0.13: a third each would be under the floor.
    const ctx = await leading(0.13);
    const ran: { runId: string; at: number; ended?: number }[] = [];
    child.act = async (runId) => {
      const r: { runId: string; at: number; ended?: number } = { runId, at: Date.now() };
      ran.push(r);
      await pause(150);
      await spend(runId, 0.02);
      await end(runId);
      r.ended = Date.now();
      return { status: "succeeded" };
    };
    const results = await Promise.all(BATCH.map((t) => hand(ctx, [t])));
    for (const r of results) expect(r.value).toMatchObject({ status: "done" });
    const caps = child.runs.map((r) => r.limits.maxCostUsd);
    expect(caps[0]).toBeCloseTo(0.13, 6);
    // The others waited for the first to end, then shared what was left: $0.11 between two.
    expect(Math.min(...ran.slice(1).map((r) => r.at))).toBeGreaterThanOrEqual(ran[0]?.ended ?? Infinity);
    for (const c of caps.slice(1)) expect(c).toBeCloseTo(0.055, 6);
  });

  it("refuses a group only when the batch's money is gone, and lets a waiting call go when it stops", async () => {
    const ctx = await leading(2);
    ctx.state.costUsd = 1.99;
    expect((await hand(ctx, ["public.plans"])).value).toMatchObject({ error: expect.stringMatching(/can't cover/) });
    expect(child.runs).toHaveLength(0);
    // A call waiting for money whose call is stopped leaves the wait, and starts nothing.
    ctx.state.costUsd = 1.9;
    child.act = async (runId) => {
      await pause(300);
      await end(runId);
      return { status: "succeeded" };
    };
    const first = hand(ctx, ["billing.credits"]);
    await pause(50);
    const stop = new AbortController();
    const waiting = hand(ctx, ["billing.refunds"], stop.signal);
    await pause(50);
    stop.abort(new Error("stopped"));
    await expect(waiting).rejects.toThrow(/stopped/);
    await first;
    expect(child.runs).toHaveLength(1);
  });

  it("starts no group still waiting when the worker shuts down: it's unfinished, for the next attempt", async () => {
    const ctx = await leading(0.1);
    const drain = new AbortController();
    ctx.attempt = { ...ctx.attempt, drain: drain.signal };
    child.act = async (runId) => {
      await pause(400);
      await end(runId);
      return { status: "succeeded" };
    };
    const first = hand(ctx, ["public.plans"]);
    // Under way before the next is handed out: its start takes a few queries, which a fixed pause loses to on a busy
    // machine (both then come back unfinished, and nothing runs).
    await vi.waitFor(() => expect(child.runs).toHaveLength(1), { timeout: 10_000, interval: 5 });
    const waiting = hand(ctx, ["billing.credits"]);
    await pause(50);
    const at = Date.now();
    drain.abort();
    expect((await waiting).value).toMatchObject({ status: "unfinished" });
    // Let go at once, not when the drafter under way ended.
    expect(Date.now() - at).toBeLessThan(250);
    await first;
    expect(child.runs).toHaveLength(1);
  });
});

describe("picking up a lead's work when it resumes", () => {
  /** An assistant message of the lead's with these draft_tables calls, and the rows recorded for them. */
  async function made(
    ctx: ToolContext,
    calls: { id: string; tables: string[]; row?: { status: string; error?: string; result?: unknown } }[],
  ) {
    const [t] = await s.t.owner<{ seq: number }[]>`
      update app.thread set msg_seq = msg_seq + 1 where id = ${ctx.run.threadId} returning msg_seq as seq`;
    const messageId = uuidv7();
    await s.t.owner`
      insert into app.message (org_id, id, thread_id, run_id, seq, role, content, status)
      values (${s.orgId}, ${messageId}, ${ctx.run.threadId}, ${ctx.run.id}, ${t?.seq ?? 0}, 'assistant',
        ${s.t.owner.json({
          role: "assistant",
          content: calls.map((c) => ({
            type: "tool-call",
            toolCallId: c.id,
            toolName: "draft_tables",
            input: { tables: c.tables },
          })),
        })}, 'complete')`;
    for (const c of calls.filter((c) => c.row)) {
      await s.t.owner`
        insert into app.tool_call (org_id, id, run_id, message_id, call_id, tool, effect_class, args, attempt, status, error, result)
        values (${s.orgId}, ${uuidv7()}, ${ctx.run.id}, ${messageId}, ${c.id}, 'draft_tables', 'internal',
          ${s.t.owner.json({ tables: c.tables })}, 1, ${c.row?.status ?? "started"}, ${c.row?.error ?? null},
          ${c.row?.result === undefined ? null : s.t.owner.json(c.row.result as never)})`;
    }
  }
  const started = (ctx: ToolContext, tables: string[]) =>
    s.tenant((tx) =>
      childRun(tx, ctx.run, { profile: "drafter", task: { tables }, title: tables.join(", "), brief: async () => "" }),
    );
  const reports = (ctx: ToolContext) =>
    s.t.owner<{ text: string; kind: string }[]>`
      select text, kind from app.message where run_id = ${ctx.run.id} and role = 'system_note' order by seq`;

  it("runs only admitted, unfinished work, and reports each piece once", async () => {
    const ctx = await leading(2);
    child.act = async (runId) => {
      await end(runId);
      return { status: "succeeded" };
    };
    // Cut short (its drafter exists, from an earlier handout): answered, never run again. Interrupted before its
    // drafter was started: nothing was admitted. Interrupted with its drafter started: picked up.
    await started(ctx, ["public.plans"]);
    await started(ctx, ["billing.refunds"]);
    await made(ctx, [
      { id: "cut", tables: ["public.plans"], row: { status: "failed", error: CUT_SHORT } },
      { id: "never", tables: ["billing.credits"] },
      { id: "cutoff", tables: ["billing.refunds"], row: { status: "started" } },
    ]);
    await resumeOwed(ctx.deps, ctx.run, [draftTables as never], ctx, new AbortController().signal);
    expect(child.runs).toHaveLength(1);
    const notes = await reports(ctx);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "report", text: expect.stringContaining('"tables":["billing.refunds"]') });
    // The next attempt finds it reported: neither run nor written again.
    await resumeOwed(ctx.deps, ctx.run, [draftTables as never], ctx, new AbortController().signal);
    expect(child.runs).toHaveLength(1);
    expect(await reports(ctx)).toHaveLength(1);
  });

  it("reports a drafter that ended before its report was written, and never one whose result the model has", async () => {
    const ctx = await leading(2);
    const done = await started(ctx, ["public.plans"]);
    await end(done.runId);
    const answered = await started(ctx, ["billing.credits"]);
    await end(answered.runId);
    await made(ctx, [
      { id: "lost", tables: ["public.plans"], row: { status: "unknown" } },
      { id: "told", tables: ["billing.credits"], row: { status: "succeeded", result: { status: "done" } } },
    ]);
    await resumeOwed(ctx.deps, ctx.run, [draftTables as never], ctx, new AbortController().signal);
    expect(child.runs).toHaveLength(0);
    const notes = await reports(ctx);
    expect(notes.map((n) => n.text.match(/"tables":\["([^"]+)"\]/)?.[1])).toEqual(["public.plans"]);
  });

  it("judges each call on its own: a refused call doesn't hide the same work asked for again and admitted", async () => {
    const ctx = await leading(2);
    child.act = async (runId) => {
      await end(runId);
      return { status: "succeeded" };
    };
    await started(ctx, ["billing.refunds"]);
    // Cut short, then asked for again (written differently) and admitted, then cut off by a crash.
    await made(ctx, [
      { id: "cut", tables: ["billing.refunds"], row: { status: "failed", error: CUT_SHORT } },
      { id: "again", tables: ["BILLING.REFUNDS"], row: { status: "started" } },
      { id: "twice", tables: ["billing.refunds "] },
    ]);
    await resumeOwed(ctx.deps, ctx.run, [draftTables as never], ctx, new AbortController().signal);
    expect(child.runs).toHaveLength(1);
    // One drafter, one report, however its calls wrote its tables.
    expect(await reports(ctx)).toHaveLength(1);
  });
});

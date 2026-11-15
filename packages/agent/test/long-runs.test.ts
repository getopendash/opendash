// Long runs, offline: a tool that outlives its timeout is an error the model sees and the run goes on;
// a run's working time is counted over its attempts and is a hard stop; attempts that kept failing end the run, a
// shutdown hand-off doesn't count; after a nudge only a few steps are left. Limits are passed small, so this runs in
// seconds.
import { claimRun, getRun, recordAttemptEnd, runEvents, submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentDeps, type AgentTool, analyst, defineAgent, runAttempt } from "../src";
import { RUN_ENDED } from "../src/harness/tool-runner";
import { call, scripted, step } from "./helpers/scripted";

let s: LearnedSource;
const viewer = () => ({ orgId: s.orgId, userId: s.userId });

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const deps = (model: MockLanguageModelV4): AgentDeps => ({
  withTenant: s.deps.withTenant,
  secrets: s.secrets,
  edition: "community",
  model: async () => ({
    model,
    provider: "opendash",
    route: "anthropic",
    providerOptions: {},
    keySource: "deployment",
  }),
});

const ask = (text: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text, channel: "eval", model: "mock" },
  );

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

/** A read tool that takes `ms`, stopping when told to only if `listens`. */
const slow = (ms: number, listens: boolean): AgentTool => ({
  name: "slow_probe",
  description: "Takes a while.",
  effect: "read",
  schema: z.object({}),
  execute: async (_input, _ctx, c) => {
    await sleep(ms, listens ? c.signal : undefined);
    return { value: { done: true } };
  },
});

/** The analyst with one more tool, so a run can be slow where the test needs it. */
const withTool = (t: AgentTool) =>
  defineAgent({
    ...analyst,
    tools: [...analyst.tools, t],
    prepare: async (d, r) => {
      const prepared = await analyst.prepare(d, r);
      return { ...prepared, tools: [...prepared.tools, t] };
    },
  });

const clarifies = () => step(call("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] }));
const tools = (quick: number) => ({ tools: { quick, query: 75_000, slow: 240_000, child: 720_000 } });

describe("a tool that outlives its timeout", () => {
  it("is an error the model sees, with what to try instead, and the run goes on in the same attempt", async () => {
    const q = await ask("How did MRR change last month?");
    const { model, prompts } = scripted([step(call("slow_probe", {})), clarifies()]);
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: tools(800) },
      withTool(slow(3_000, false)),
    );
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(JSON.stringify(prompts[1])).toContain("slow_probe took longer than 1 s, so it was stopped. Try it again");
    const run = await getRun(s.deps, viewer(), q.runId);
    expect(run?.attempt).toBe(1);
  });
});

describe("a run's working time", () => {
  it("is a hard stop: what's running is stopped, and the run says it ran out of time", async () => {
    const q = await ask("How did MRR change last month?");
    const { model } = scripted([step(call("slow_probe", {})), clarifies()]);
    // A tool that changes something, stopping through its signal: it's awaited, and recorded before the run ends.
    const writing = { ...slow(5_000, true), effect: "internal" as const };
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { ...tools(20_000), wallMs: 1_000, wrapUpAtMs: 900 } },
      withTool(writing),
    );
    expect(result).toEqual({ status: "failed", outcome: "no_answer" });
    const run = await getRun(s.deps, viewer(), q.runId);
    expect(run?.outcome).toMatchObject({ reason: analyst.ending.stopped.time });
    const events = await runEvents(s.deps, viewer(), q.runId);
    expect(events.find((e) => e.type === "attempt_ended")?.data).toMatchObject({ reason: "out_of_time" });
    const types = events.map((e) => e.type);
    expect(types.indexOf("tool_result")).toBeGreaterThan(-1);
    expect(types.indexOf("tool_result")).toBeLessThan(types.indexOf("run_end"));
    const [row] = await s.t.owner<{ status: string; error: string }[]>`
      select status, error from app.tool_call where run_id = ${q.runId} and tool = 'slow_probe'`;
    expect(row).toEqual({ status: "failed", error: RUN_ENDED });
  });

  it("goes on from earlier attempts': one past its wall doesn't start again", async () => {
    const q = await ask("How did MRR change last month?");
    const first = await claimRun(s.deps, { orgId: s.orgId, runId: q.runId }, "earlier");
    if (!first) throw new Error("not claimed");
    await s.t.owner`update app.run_event set created_at = created_at - interval '10 seconds'
      where run_id = ${q.runId} and attempt = 1`;
    await recordAttemptEnd(s.deps, first, "shutdown");
    const { model, prompts } = scripted([clarifies()]);
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { wallMs: 5_000, wrapUpAtMs: 4_000 } },
    );
    expect(result).toEqual({ status: "failed", outcome: "no_answer" });
    expect(prompts).toHaveLength(0);
  });
});

describe("attempts that kept failing", () => {
  it("end the run without calling the model; hand-offs at a shutdown don't count", async () => {
    const crashed = await ask("How did MRR change last month?");
    for (let i = 0; i < 3; i++) await claimRun(s.deps, { orgId: s.orgId, runId: crashed.runId }, `w${i}`);
    const never = scripted([]);
    const failed = await runAttempt(deps(never.model), { orgId: s.orgId, runId: crashed.runId }, { workerId: "test" });
    expect(failed).toEqual({ status: "failed", outcome: "no_answer" });
    expect(never.prompts).toHaveLength(0);
    expect((await getRun(s.deps, viewer(), crashed.runId))?.outcome).toMatchObject({
      reason: analyst.ending.stopped.failing,
    });

    const handedOff = await ask("How did MRR change last month?");
    for (let i = 0; i < 3; i++) {
      const a = await claimRun(s.deps, { orgId: s.orgId, runId: handedOff.runId }, `w${i}`);
      if (a) await recordAttemptEnd(s.deps, a, "shutdown");
    }
    const { model } = scripted([clarifies()]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: handedOff.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
  });
});

describe("after a nudge", () => {
  it("only a few steps are left, never another full budget", async () => {
    const q = await ask("How did MRR change last month?");
    // Plain text ends the first pass; after the nudge, every call is malformed, so nothing ends the run.
    const { model, prompts } = scripted([
      step({ type: "text", text: "MRR went up." }),
      ...Array.from({ length: 10 }, () => step(call("answer", { status: "answered" }))),
    ]);
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { nudgeSteps: 3 } },
    );
    expect(result).toEqual({ status: "failed", outcome: "no_answer" });
    expect(prompts).toHaveLength(1 + 3);
  });
});

describe("a worker shutting down", () => {
  it("hands its run off at the next step boundary; the next attempt goes on from there, and it isn't a failure", async () => {
    const q = await ask("How did MRR change last month?");
    const drain = new AbortController();
    const { model } = scripted([
      () => {
        // SIGTERM arrives while the model is answering: this call and its tools finish, then the run hands off.
        drain.abort();
        return step(call("value_lookup", { term: "Germany", columns: ["public.accounts.country"] }));
      },
    ]);
    const first = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "old", drain: drain.signal },
    );
    expect(first).toEqual({ status: "handed_off" });
    const [lookup] = await s.t.owner<{ status: string }[]>`
      select status from app.tool_call where run_id = ${q.runId} and tool = 'value_lookup'`;
    expect(lookup?.status).toBe("succeeded");

    const next = scripted([clarifies()]);
    const second = await runAttempt(deps(next.model), { orgId: s.orgId, runId: q.runId }, { workerId: "new" });
    expect(second).toEqual({ status: "succeeded", outcome: "clarify" });
    // The new attempt saw the lookup's result, and the hand-off wasn't counted against the run.
    expect(JSON.stringify(next.prompts[0])).toContain("value_lookup");
    const events = await runEvents(s.deps, viewer(), q.runId);
    expect(events.filter((e) => e.type === "attempt_ended").map((e) => e.data.reason)).toEqual([
      "shutdown",
      "finished",
    ]);
  });
});

describe("a run's steps", () => {
  it("are the run's, across attempts: a retry doesn't start a fresh step budget", async () => {
    const q = await ask("How did MRR change last month?");
    const lookup = () => step(call("value_lookup", { term: "Germany", columns: ["public.accounts.country"] }));
    const first = scripted([
      lookup(),
      lookup(),
      () => {
        throw new APICallError({
          message: "Overloaded",
          url: "https://api.anthropic.com/v1/messages",
          requestBodyValues: {},
          statusCode: 529,
          isRetryable: false,
        });
      },
    ]);
    await expect(
      runAttempt(deps(first.model), { orgId: s.orgId, runId: q.runId }, { workerId: "w1", limits: { maxSteps: 3 } }),
    ).rejects.toThrow(/model call failed/);
    // Two of its three steps are used: one more, then the nudge.
    const second = scripted([lookup(), clarifies()]);
    const result = await runAttempt(
      deps(second.model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "w2", limits: { maxSteps: 3 } },
    );
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(JSON.stringify(second.prompts[1])).toContain(analyst.ending.nudge);
  });
});

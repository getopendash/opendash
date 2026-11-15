// What each run was sent, kept, offline: the prompt's layers stored once by hash, the run's own record of
// them (its memories as a count, never their text), how each attempt ended after its events are gone, and an earlier
// question sent again exactly as it was, so the conversation reads the same and the prompt cache can hold it.
import { claimRun, submitQuestion, traceRun } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { withSystemOn, withTenantOn } from "@opendash/db/testing";
import { MRR_SQL } from "@opendash/evals";
import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { call, type Prompt, scripted, step, systemOf } from "./helpers/scripted";

let s: LearnedSource;

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const deps = (model: MockLanguageModelV4): AgentDeps => ({
  withTenant: s.deps.withTenant,
  withUser: (orgId, userId, fn) => withTenantOn(s.t.app, { orgId, userId }, fn),
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

/** A question, on the eval channel unless named: memories are used only for one asked on the web (or a Slack DM). */
const ask = (text: string, threadId?: string, channel: "eval" | "web" = "eval") =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      text,
      channel,
      model: "mock",
      ...(threadId ? { threadId } : {}),
    },
  );

const said = (markdown: string) =>
  step(call("answer", { status: "answered", markdown, interpretation: [], caveats: [] }));

/** The question as a call sent it: its parts, without the cache points that move each step. */
const sentQuestion = (prompt: Prompt | undefined, text: string) =>
  (prompt ?? []).find((m) => m.role === "user" && JSON.stringify(m.content).includes(text))?.content;

interface Recorded {
  prompt: {
    attempt: number;
    agent?: string;
    source?: string;
    question?: string;
    tools: string[];
    attached: unknown[];
    memories: number;
  } | null;
  attempts: { attempt: number; started: string; ended: string; reason: string }[];
}
const recorded = async (runId: string) => {
  const [row] = await s.t.owner<Recorded[]>`select prompt, attempts from app.run where id = ${runId}`;
  return row as Recorded;
};
const stored = async (hash: string | undefined) => {
  const [row] = await s.t.owner<{ text: string }[]>`
    select text from app.prompt_text where org_id = ${s.orgId} and sha256 = ${hash ?? ""}`;
  return row?.text;
};

describe("what a run was sent", () => {
  const FACT = "By churn I mean churned MRR, not logo churn.";

  it("keeps each layer by its hash, and an earlier question is sent again as it was, memory never among them", async () => {
    const q1 = await ask(`Remember that ${FACT.toLowerCase()}`, undefined, "web");
    const first = scripted([step(call("remember", { fact: FACT })), said("Noted.")]);
    await runAttempt(deps(first.model), { orgId: s.orgId, runId: q1.runId }, { workerId: "t" });

    const q2 = await ask("What was churn last month?", q1.threadId, "web");
    const second = scripted([said("Churn, as you define it.")]);
    await runAttempt(deps(second.model), { orgId: s.orgId, runId: q2.runId }, { workerId: "t" });

    // The follow-up was given the memory, in the conversation layer; the record counts it.
    const { prompt } = await recorded(q2.runId);
    expect(prompt).toMatchObject({ attempt: 1, memories: 1, attached: [] });
    expect(prompt?.tools).toEqual(expect.arrayContaining(["sql_query", "remember", "answer", "clarify"]));
    expect(await stored(prompt?.agent)).toContain("You are the analyst in OpenDash.");
    expect(await stored(prompt?.source)).toContain("The source:");
    expect(await stored(prompt?.question)).toMatch(/^Today is \d{4}-\d{2}-\d{2}/);
    // What a person told OpenDash to remember is never stored with a prompt, though this run was given it.
    expect(systemOf(second.prompts[0])).toContain("logo churn");
    const [leaked] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.prompt_text where org_id = ${s.orgId} and text like ${"%logo churn%"}`;
    expect(leaked?.n).toBe(0);

    // The first question reads the same in the follow-up as when it was answered: its block came back with it.
    const asked = `Remember that ${FACT.toLowerCase()}`;
    const then = sentQuestion(first.prompts.at(-1), asked);
    expect(JSON.stringify(then)).toContain("Today is ");
    expect(sentQuestion(second.prompts[0], asked)).toEqual(then);
  });

  it("stores a layer once however many runs send it", async () => {
    const a = await ask("How many accounts do we have?");
    const b = await ask("How many invoices do we have?");
    for (const q of [a, b]) {
      const { model } = scripted([said("Counted.")]);
      await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    }
    const [ra, rb] = [await recorded(a.runId), await recorded(b.runId)];
    expect(rb.prompt?.agent).toBe(ra.prompt?.agent);
    expect(rb.prompt?.source).toBe(ra.prompt?.source);
    const [rows] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.prompt_text
      where org_id = ${s.orgId} and sha256 in (${ra.prompt?.agent ?? ""}, ${ra.prompt?.source ?? ""})`;
    expect(rows?.n).toBe(2);
  });

  it("keeps how each attempt ended on the run, beside its events", async () => {
    const q = await ask("And how did MRR change?");
    const busy = scripted([
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
      runAttempt(deps(busy.model), { orgId: s.orgId, runId: q.runId }, { workerId: "w1" }),
    ).rejects.toThrow();
    const done = scripted([said("Up a little.")]);
    await runAttempt(deps(done.model), { orgId: s.orgId, runId: q.runId }, { workerId: "w2" });
    const { attempts, prompt } = await recorded(q.runId);
    expect(attempts.map((a) => [a.attempt, a.reason])).toEqual([
      [1, "model_busy"],
      [2, "finished"],
    ]);
    for (const a of attempts) expect(Date.parse(a.ended)).toBeGreaterThanOrEqual(Date.parse(a.started));
    // The run's prompt is its latest attempt's.
    expect(prompt?.attempt).toBe(2);
  });
});

describe("the trace", () => {
  const mrr = (asOf: string, title: string) =>
    call("sql_query", { title, sql: MRR_SQL, params: [{ name: "as_of", value: asOf }] });
  const check = call("sql_query", {
    title: "MRR, summed another way",
    sql: `select sum(mrr) as mrr from (${MRR_SQL}) x`,
    params: [{ name: "as_of", value: "2026-10-01T00:00:00Z" }],
  });
  const answer = (markdown: string) =>
    call("answer", {
      status: "answered",
      markdown,
      interpretation: [],
      caveats: [],
      cross_checks: [{ headline: "q1:0:mrr", check: "q2:0:mrr" }],
    });

  it("shows how each attempt ended, what it was sent, and each model call with its tool calls and the gate's verdict", async () => {
    const q = await ask("What was MRR at the end of September?");
    const { model } = scripted([
      step(mrr("2026-10-01T00:00:00Z", "MRR end of September"), check),
      step(answer("MRR was $1,234.")),
      step(answer("MRR was ⟦q1:0:mrr|currency:USD⟧.")),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const trace = await withSystemOn(s.t.system, (tx) => traceRun(tx, q.runId));
    expect(trace?.run).toMatchObject({ status: "succeeded", outcome: "answer", profile: "analyst", attempt: 1 });
    expect(trace?.attempts).toEqual([expect.objectContaining({ attempt: 1, reason: "finished" })]);
    expect(trace?.prompt?.sizes).toEqual({
      agent: expect.any(Number),
      source: expect.any(Number),
      question: expect.any(Number),
    });
    // Aliases are handed out as queries finish, so two in one step may swap on a faster or slower machine.
    expect(trace?.steps.map((st) => st.calls.map((c) => c.alias ?? c.tool).sort())).toEqual([
      ["q1", "q2"],
      ["answer"],
      ["answer"],
    ]);
    const [sentBack, accepted] = [trace?.steps[1]?.calls[0], trace?.steps[2]?.calls[0]];
    expect(sentBack).toMatchObject({ accepted: false, problems: [expect.stringMatching(/typed/i)] });
    expect(accepted).toMatchObject({ accepted: true });
    expect(trace?.steps[0]?.calls[0]).toMatchObject({ title: "MRR end of September", rows: 1, status: "succeeded" });
  });

  it("shows a query's own error, though its call succeeded", async () => {
    const q = await ask("What was MRR, by a column that isn't there?");
    const { model } = scripted([
      step(call("sql_query", { title: "MRR", sql: "select sum(no_such_column) as mrr from billing.invoices" })),
      step(call("clarify", { questions: [{ question: "Which month?", options: ["September", "October"] }] })),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const trace = await withSystemOn(s.t.system, (tx) => traceRun(tx, q.runId));
    expect(trace?.steps[0]?.calls[0]).toMatchObject({
      tool: "sql_query",
      status: "succeeded",
      error: expect.stringMatching(/^undefined_column: There's no column no_such_column/),
    });
  });

  it("names an attempt that recorded no end", async () => {
    const q = await ask("What was MRR, once more?");
    await claimRun(s.deps, { orgId: s.orgId, runId: q.runId }, "gone");
    const { model } = scripted([
      step(call("clarify", { questions: [{ question: "Which month?", options: ["September", "October"] }] })),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    const trace = await withSystemOn(s.t.system, (tx) => traceRun(tx, q.runId));
    expect(trace?.attempts.map((a) => a.reason)).toEqual(["no end recorded (the worker stopped)", "finished"]);
  });
});

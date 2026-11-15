// Follow-ups, offline: AI SDK's mock plays the model, everything else is real. A message the asker sends
// while the answer is worked on is read before the run's next model call, after the step it came in, as theirs; the
// thread and the trace show it read. While the run wraps up, it isn't: it waits, and is the next run's question.
import { getThread, submitQuestion, traceRun } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { withSystemOn } from "@opendash/db/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { call, scripted, step } from "./helpers/scripted";

let s: LearnedSource;

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
const ask = (text: string, threadId?: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      text,
      channel: "web",
      model: "mock",
      ...(threadId ? { threadId } : {}),
    },
  );
const clarifies = () =>
  step(call("clarify", { questions: [{ question: "Which month?", options: ["September", "October"] }] }));
const asker = () => ({ orgId: s.orgId, userId: s.userId });

describe("a follow-up sent while the answer is worked on", () => {
  it("is read before the next model call, after the step it came in, as the asker's", async () => {
    const q = await ask("How many invoices are there?");
    const { model, prompts } = scripted([
      async () => {
        // Sent while the first call works.
        expect((await ask("And how many are paid?", q.threadId)).queued).toBe(true);
        return step(call("sql_query", { title: "Invoices", sql: "select count(*) as n from billing.invoices" }));
      },
      clarifies(),
    ]);
    expect(await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" })).toEqual({
      status: "succeeded",
      outcome: "clarify",
    });
    const second = prompts[1] ?? [];
    expect(second.at(-2)?.role).toBe("tool");
    expect(second.at(-1)).toMatchObject({ role: "user", content: [{ type: "text", text: "And how many are paid?" }] });
    // The question stays the question: its block is still on it, and it's the first call's last message.
    expect(JSON.stringify(prompts[0]?.at(-1))).toContain("How many invoices are there?");

    const thread = await getThread(s.deps, asker(), q.threadId);
    expect(thread?.turns.map((x) => x.followUps.map((f) => [f.text, f.state]))).toEqual([
      [["And how many are paid?", "read"]],
    ]);
    const trace = await withSystemOn(s.t.system, (tx) => traceRun(tx, q.runId));
    const [read] = trace?.followUps ?? [];
    expect(read?.text).toBe("And how many are paid?");
    expect(read && trace?.steps.map((x) => x.seq < read.seq)).toEqual([true, false]);
  });

  it("is the asker's words: the answer may repeat a number they typed in it", async () => {
    const q = await ask("How many accounts have a subscription?");
    const over = (title: string, sql: string) => call("sql_query", { title, sql });
    const { model, prompts } = scripted([
      async () => {
        await ask("Only those with more than 50 seats", q.threadId);
        return step(
          over(
            "Accounts over 50 seats",
            "select count(distinct account_id) as n from public.subscriptions where seats > 50",
          ),
          over(
            "Accounts over 50 seats, counted another way",
            "select count(*) as n from (select distinct account_id from public.subscriptions where seats > 50) x",
          ),
        );
      },
      step(
        call("answer", {
          status: "answered",
          markdown: "⟦q1:0:n⟧ accounts have a subscription with more than 50 seats.",
          interpretation: [],
          caveats: [],
          cross_checks: [{ headline: "q1:0:n", check: "q2:0:n" }],
        }),
      ),
    ]);
    expect(await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" })).toEqual({
      status: "succeeded",
      outcome: "answer",
    });
    // Accepted the first time: 50 is the asker's, from the follow-up.
    expect(prompts).toHaveLength(2);
    const [run] = await s.t.owner<
      { outcome: { verified: boolean } }[]
    >`select outcome from app.run where id = ${q.runId}`;
    expect(run?.outcome.verified).toBe(true);
  });

  // Wrapping up for its failed queries (a person's run is never wrapped up for its time or calls: it pauses).
  it("waits while the run wraps up, and is the next run's question", async () => {
    const q = await ask("How many invoices are there?");
    let followUp = "";
    const { model, prompts } = scripted([
      async () => {
        followUp = (await ask("And how many are paid?", q.threadId)).messageId;
        return clarifies();
      },
    ]);
    expect(
      await runAttempt(
        deps(model),
        { orgId: s.orgId, runId: q.runId },
        { workerId: "t", limits: { maxFailedQueries: 0 } },
      ),
    ).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(JSON.stringify(prompts)).not.toContain("And how many are paid?");
    const thread = await getThread(s.deps, asker(), q.threadId);
    expect(thread?.turns.map((x) => [x.message.id === followUp, x.run?.status])).toEqual([
      [false, "succeeded"],
      [true, "queued"],
    ]);
  });
});

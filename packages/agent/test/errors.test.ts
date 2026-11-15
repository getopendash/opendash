// What the loop does with what goes wrong, offline: a model error by its kind (a refused key ends the
// run at once, a prompt too long is folded and sent once more, a busy provider is the job's to retry); a response cut
// off at its output limit runs none of its calls; a call failing again unchanged is called out; an exception a tool
// didn't expect reaches the model as "it failed", never its message; and malformed calls in a row wrap the run up.
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { getRun, runEvents, submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentDeps, type AgentTool, analyst, defineAgent, runAttempt } from "../src";
import { MODEL_REFUSED } from "../src/harness/model-errors";
import { CUT_SHORT, UNEXPECTED } from "../src/harness/tool-runner";
import { call, scripted, step, usage } from "./helpers/scripted";

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

const failing = (statusCode: number, message: string) => () => {
  throw new APICallError({
    message,
    url: "https://api.anthropic.com/v1/messages",
    requestBodyValues: { secret: "the whole prompt" },
    statusCode,
    isRetryable: false,
  });
};
const clarifies = () => step(call("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] }));
/** A read tool whose result is large: what fills a long turn. */
const bigProbe: AgentTool = {
  name: "big_probe",
  description: "Reads a lot.",
  effect: "read",
  schema: z.object({ n: z.number() }),
  execute: async (input) => ({
    value: { alias: `q${(input as { n: number }).n}`, title: "Lots", rows: "x".repeat(80_000) },
  }),
};
const withBig = defineAgent({
  ...analyst,
  tools: [...analyst.tools, bigProbe],
  prepare: async (d, r) => {
    const prepared = await analyst.prepare(d, r);
    return { ...prepared, tools: [...prepared.tools, bigProbe] };
  },
});
const endedWith = async (runId: string) =>
  (await runEvents(s.deps, viewer(), runId)).filter((e) => e.type === "attempt_ended").map((e) => e.data.reason);

describe("a call over the run's budget", () => {
  const probe: AgentTool = {
    name: "probe",
    description: "Reads a little.",
    effect: "read",
    schema: z.object({ n: z.number() }),
    execute: async (input) => ({ value: { n: (input as { n: number }).n } }),
  };
  const withProbe = defineAgent({
    ...analyst,
    tools: [...analyst.tools, probe],
    prepare: async (d, r) => {
      const prepared = await analyst.prepare(d, r);
      return { ...prepared, tools: [...prepared.tools, probe] };
    },
  });

  it("is recorded as refused, so a later attempt never takes it for interrupted work", async () => {
    const q = await ask("How did MRR change last month?");
    // Three calls allowed (it wraps up two before that, so the step starts with room): the fourth is over.
    const { model } = scripted([step(...[1, 2, 3, 4].map((n) => call("probe", { n }))), clarifies()]);
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { maxToolCalls: 3 } },
      withProbe,
    );
    expect(result).toMatchObject({ status: "succeeded" });
    const rows = await s.t.owner<{ status: string; error: string | null }[]>`
      select status, error from app.tool_call where run_id = ${q.runId} and tool = 'probe' order by status`;
    expect(rows).toEqual([
      { status: "failed", error: "This run's budget for that is spent: finish with what you have." },
      ...Array(3).fill({ status: "succeeded", error: null }),
    ]);
  });
});

describe("a model error", () => {
  it("that retrying can't fix ends the run at once, saying what to do", async () => {
    const q = await ask("How did MRR change last month?");
    const { model } = scripted([failing(401, "invalid x-api-key")]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "failed", outcome: "no_answer" });
    expect((await getRun(s.deps, viewer(), q.runId))?.outcome).toMatchObject({ reason: MODEL_REFUSED.key });
    expect(await endedWith(q.runId)).toEqual(["model_refused"]);
  });

  it("that says the prompt is too long folds this turn's earlier results and sends it once more", async () => {
    const q = await ask("How did MRR change last month?");
    const { model, prompts } = scripted([
      step(call("big_probe", { n: 1 })),
      step(call("big_probe", { n: 2 })),
      failing(400, "prompt is too long: 230000 tokens > 200000 maximum"),
      clarifies(),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" }, withBig);
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(prompts).toHaveLength(4);
    // The first result gave way; the latest, the one the model is working from, stayed whole.
    const sent = JSON.stringify(prompts[3]);
    expect(sent).toContain("Its rows were folded to fit");
    expect(sent.length).toBeLessThan(JSON.stringify(prompts[2]).length - 50_000);
  });

  it("that says the prompt is too long, with nothing left to fold, ends at once rather than resend it", async () => {
    const q = await ask("How did MRR change last month?");
    const { model, prompts } = scripted([failing(400, "prompt is too long")]);
    expect(await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" })).toEqual({
      status: "failed",
      outcome: "no_answer",
    });
    expect(prompts).toHaveLength(1);
    expect((await getRun(s.deps, viewer(), q.runId))?.outcome).toMatchObject({ reason: MODEL_REFUSED.too_long });
  });

  it("from a busy provider is waited out in the attempt, then the job's to retry, and the attempt says why it ended", async () => {
    const q = await ask("How did MRR change last month?");
    // Busy on every call: the attempt waits twice (shortened here), then hands the run back.
    const { model, prompts } = scripted([
      failing(529, "Overloaded"),
      failing(529, "Overloaded"),
      failing(529, "Overloaded"),
    ]);
    await expect(
      runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test", busyWaitsMs: [5, 5] }),
    ).rejects.toThrow(/^The model call failed: AI_APICallError \(529\)$/);
    expect(prompts.length).toBeGreaterThanOrEqual(3);
    expect(await endedWith(q.runId)).toEqual(["model_busy"]);
  });

  it("from a provider busy for a moment goes on in the same attempt, and answers", async () => {
    const q = await ask("How did MRR change last month?");
    const { model } = scripted([failing(429, "Rate limited"), clarifies()]);
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", busyWaitsMs: [5, 5] },
    );
    expect(result).toMatchObject({ status: "succeeded" });
    expect(await endedWith(q.runId)).toEqual(["finished"]);
  });
});

describe("a run past its model's window", () => {
  it("shrinks its own earlier results as it goes, the latest whole, so no call crosses it", async () => {
    const q = await ask("How did MRR change last month?");
    const { model, prompts } = scripted([
      step(call("big_probe", { n: 1 })),
      step(call("big_probe", { n: 2 })),
      step(call("big_probe", { n: 3 })),
      clarifies(),
    ]);
    // Each result is about 32k tokens: two of them, with the prompt and tools, pass this window.
    const window = { limit: 60_000, target: 50_000, keepRecent: 10_000 };
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { window } },
      withBig,
    );
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    const folded = (i: number) => JSON.stringify(prompts[i]).split("Its rows were folded to fit").length - 1;
    expect([0, 1, 2, 3].map(folded)).toEqual([0, 0, 1, 2]);
    // The latest result is always whole.
    expect(JSON.stringify(prompts[3]?.at(-1))).toContain("x".repeat(80_000));
    // Each call fits: what it sends, counted the same way, stays near the window.
    for (const p of prompts) expect(JSON.stringify(p).length / 2.5).toBeLessThan(window.limit + 10_000);
  });
});

describe("an error of ours", () => {
  it("is the attempt's, never read as the model's (a database refusal isn't a refused key)", async () => {
    const q = await ask("How did MRR change last month?");
    let broken = false;
    const { model } = scripted([
      () => {
        broken = true;
        return step(call("value_lookup", { term: "Germany", columns: ["public.accounts.country"] }));
      },
    ]);
    const failingDb: AgentDeps = {
      ...deps(model),
      withTenant: (orgId, fn) => {
        if (broken) throw new Error("permission denied for table run");
        return s.deps.withTenant(orgId, fn);
      },
    };
    await expect(runAttempt(failingDb, { orgId: s.orgId, runId: q.runId }, { workerId: "test" })).rejects.toThrow(
      /^The attempt failed: Error$/,
    );
  });
});

describe("a response cut off at its output limit", () => {
  it("runs none of its calls, and tells the model to send them whole", async () => {
    const q = await ask("How did MRR change last month?");
    const cut = {
      content: [call("value_lookup", { term: "Germany", columns: ["public.accounts.country"] })],
      finishReason: { unified: "length" as const, raw: undefined },
      usage,
      warnings: [],
    };
    const { model, prompts } = scripted([cut, clarifies()]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(JSON.stringify(prompts[1])).toContain(CUT_SHORT);
    const [row] = await s.t.owner<{ status: string }[]>`
      select status from app.tool_call where run_id = ${q.runId} and tool = 'value_lookup'`;
    expect(row?.status).toBe("failed");
  });
});

describe("a tool", () => {
  const broken: AgentTool = {
    name: "broken_probe",
    description: "Fails.",
    effect: "read",
    schema: z.object({}),
    execute: async () => {
      throw new Error("connection to 10.0.0.7 refused for user analytics_ro with token abc123");
    },
  };
  const withBroken = defineAgent({
    ...analyst,
    tools: [...analyst.tools, broken],
    prepare: async (d, r) => {
      const prepared = await analyst.prepare(d, r);
      return { ...prepared, tools: [...prepared.tools, broken] };
    },
  });

  it("that throws reaches the model as 'it failed', never its message; called again unchanged, it's called out", async () => {
    const q = await ask("How did MRR change last month?");
    const { model, prompts } = scripted([step(call("broken_probe", {})), step(call("broken_probe", {})), clarifies()]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" }, withBroken);
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    const seen = JSON.stringify(prompts[2]);
    expect(seen).toContain(UNEXPECTED);
    expect(seen).not.toContain("abc123");
    expect(seen).toContain("This exact call has failed 2 times with the same input");
  });

  it("whose every call is malformed, three times in a row, wraps the run up", async () => {
    const q = await ask("How did MRR change last month?");
    const malformed = (): LanguageModelV4Content => call("value_lookup", { nope: true });
    const { model, prompts } = scripted([step(malformed()), step(malformed()), step(malformed()), clarifies()]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(JSON.stringify(prompts[3]?.at(-1))).toContain(JSON.stringify(analyst.ending.wrapUp).slice(1, -1));
    expect(JSON.stringify(prompts[2])).not.toContain("Wrap up now");
  });
});

describe("A query the model writes", () => {
  it("is held to its database's advice through sql_query and sql_check, and the warning reaches the model", async () => {
    const q = await ask("What share of invoices is paid?");
    const share = "select count(*) filter (where status = 'paid') / count(*) as share from billing.invoices";
    const { model, prompts } = scripted([
      step(call("sql_check", { sql: share }), call("sql_query", { title: "Paid share", sql: share })),
      clarifies(),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    const results = (prompts[1] ?? []).flatMap((m) =>
      m.role === "tool" ? m.content.filter((p) => p.type === "tool-result") : [],
    );
    expect(results.map((r) => r.toolName).sort()).toEqual(["sql_check", "sql_query"]);
    for (const r of results) {
      expect(JSON.stringify(r.output), r.toolName).toContain("divides integers, so Postgres rounds it down");
    }
  });
});

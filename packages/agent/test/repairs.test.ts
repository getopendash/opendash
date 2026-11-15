// Mistakes code repairs instead of sending them back: a string where a list of strings belongs, and a
// list the tool lets the model leave out. Each saves a model call. Anything else still goes back to the model, and
// input cut off mid-JSON is never repaired.
import { getRun, runEvents, submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { MRR_SQL } from "@opendash/evals";
import { InvalidToolInputError, zodSchema } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import type { AttemptScope } from "../src/harness/attempt";
import { repairCalls } from "../src/harness/repair";
import { CUT_SHORT } from "../src/harness/tool-runner";
import { answer } from "../src/tools/endings";
import { aliasOf, call, type Prompt, scripted, step, usage } from "./helpers/scripted";

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

const queries = () =>
  step(
    call("sql_query", {
      title: "MRR end of September",
      sql: MRR_SQL,
      params: [{ name: "as_of", value: "2026-10-01T00:00:00Z" }],
    }),
    call("sql_query", {
      title: "MRR, summed another way",
      sql: `select sum(mrr) as mrr from (${MRR_SQL}) x`,
      params: [{ name: "as_of", value: "2026-10-01T00:00:00Z" }],
    }),
  );
/** An answer on the two queries, with what the test changes in it. */
const answerWith = (prompt: Prompt, fields: Record<string, unknown>) => {
  const sep = aliasOf(prompt, "MRR end of September");
  const check = aliasOf(prompt, "MRR, summed another way");
  return step(
    call("answer", {
      status: "answered",
      markdown: `MRR was ⟦${sep}:0:mrr|currency:USD,compact⟧ in September 2026.`,
      cross_checks: [{ headline: `${sep}:0:mrr`, check: `${check}:0:mrr` }],
      ...fields,
    }),
  );
};
const answerEvent = async (runId: string) =>
  (await runEvents(s.deps, viewer(), runId)).filter((e) => e.type === "tool_result" && e.data.tool === "answer");

describe("an answer with a mistake code can repair", () => {
  it("is accepted on that call: a text interpretation becomes a list, missing caveats none", async () => {
    const q = await ask("What was MRR last month?");
    const { model, prompts } = scripted([
      queries(),
      (prompt) => answerWith(prompt, { interpretation: "Last month = September 2026" }),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "answer" });
    // No call was spent sending it back.
    expect(prompts).toHaveLength(2);
    const run = await getRun(s.deps, viewer(), q.runId);
    expect(run?.outcome).toMatchObject({ kind: "answer", interpretation: ["Last month = September 2026"] });
    const [event] = await answerEvent(q.runId);
    expect(event?.data.repaired).toEqual(["interpretation", "caveats"]);
  });

  it("but missing what it must say still goes back to the model", async () => {
    const q = await ask("What was MRR last month?");
    const { model, prompts } = scripted([
      queries(),
      (prompt) => answerWith(prompt, { caveats: [] }),
      (prompt) => answerWith(prompt, { interpretation: ["Last month = September 2026"], caveats: [] }),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "answer" });
    expect(prompts).toHaveLength(3);
    expect(JSON.stringify(prompts[2])).toContain("didn't match its schema");
  });
});

describe("input cut off at the output limit", () => {
  it("is never repaired: the call doesn't run, and the model is told it was cut off", async () => {
    const q = await ask("What was MRR last month?");
    const cut = {
      content: [
        {
          type: "tool-call" as const,
          toolCallId: "cut-1",
          toolName: "answer",
          input: '{"status":"answered","markdown":"MRR was',
        },
      ],
      finishReason: { unified: "length" as const, raw: undefined },
      usage,
      warnings: [],
    };
    const { model, prompts } = scripted([
      cut,
      step(call("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] })),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(JSON.stringify(prompts[1])).toContain(CUT_SHORT);
  });
});

describe("the repair, on its own", () => {
  const scope = () => ({ prepared: { tools: [answer] }, repaired: new Map() }) as unknown as AttemptScope;
  const repair = async (input: unknown, sc = scope()) =>
    await repairCalls(sc)({
      toolCall: { type: "tool-call", toolCallId: "c1", toolName: "answer", input: JSON.stringify(input) },
      tools: {},
      inputSchema: async () => (await zodSchema(answer.schema).jsonSchema) as never,
      error: new InvalidToolInputError({ toolName: "answer", toolInput: "", cause: new Error("invalid") }),
      instructions: undefined,
      system: undefined,
      messages: [],
    });

  it("lists text wherever the schema wants a list of strings, nested too, and records what it fixed", async () => {
    const sc = scope();
    const fixed = await repair(
      {
        status: "answered",
        markdown: "x",
        interpretation: ["a"],
        caveats: "one caveat",
        charts: [{ type: "bar", title: "t", query: "q1", x: "plan", y: "mrr" }],
      },
      sc,
    );
    expect(JSON.parse(fixed?.input ?? "{}")).toMatchObject({ caveats: ["one caveat"], charts: [{ y: ["mrr"] }] });
    expect(sc.repaired.get("c1")).toEqual([
      { field: "caveats", how: "listed" },
      { field: "charts[0].y", how: "listed" },
    ]);
  });

  it("leaves alone what it can't fix without guessing", async () => {
    // Nothing to fix: the SDK keeps the call invalid, with its own error.
    expect(await repair({ status: "maybe", markdown: "x", interpretation: [], caveats: [] })).toBeNull();
    // Not JSON at all.
    const sc = scope();
    const cut = await repairCalls(sc)({
      toolCall: { type: "tool-call", toolCallId: "c2", toolName: "answer", input: '{"status":"ans' },
      tools: {},
      inputSchema: async () => (await zodSchema(answer.schema).jsonSchema) as never,
      error: new InvalidToolInputError({ toolName: "answer", toolInput: "", cause: new Error("invalid") }),
      instructions: undefined,
      system: undefined,
      messages: [],
    });
    expect(cut).toBeNull();
    expect(sc.repaired.size).toBe(0);
  });
});

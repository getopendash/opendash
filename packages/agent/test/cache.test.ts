// Where the prompt cache holds: the agent layer, the source layer, and two points on the conversation
// that move forward each step, four at most; nothing that changes during a run moves the cache. Wrapping up keeps the
// tools and the system text as they are: the model is told in a message, and only the ending tools run.
import type { LanguageModelV4Prompt } from "@ai-sdk/provider";
import { submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import type { ModelMessage } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { analyst } from "../src/agents/analyst";
import { WRAP_UP } from "../src/agents/analyst/prompt";
import { CACHED, withCachePoints } from "../src/harness/cache";
import { wrappingUp } from "../src/harness/tool-runner";
import { call, scripted, step } from "./helpers/scripted";

let s: LearnedSource;
const NOW = new Date("2026-10-10T12:00:00Z");

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
  now: () => NOW,
});

const ask = (text: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text, channel: "eval", model: "mock" },
  );

const pointed = (o: unknown) => JSON.stringify(o ?? {}).includes('"cacheControl"');
/** Where a call's cache points are: its system blocks', and its messages' by index. */
const points = (prompt: LanguageModelV4Prompt) => ({
  system: prompt.filter((m) => m.role === "system").map((m) => pointed(m.providerOptions)),
  messages: prompt
    .filter((m) => m.role !== "system")
    .flatMap((m, i) => (pointed(m.providerOptions) || m.content.some?.((p) => pointed(p.providerOptions)) ? [i] : [])),
});
const systemText = (prompt: LanguageModelV4Prompt) =>
  prompt
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
const lookup = (term: string) => call("value_lookup", { term, columns: ["public.accounts.country"] });
const clarifies = () => step(call("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] }));

describe("the cache points", () => {
  it("move to the last message and the one before the model's latest turn, clearing older ones", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Q1", providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } } },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2", providerOptions: { openai: { store: false } } },
      { role: "assistant", content: [{ type: "text", text: "looking" }] },
      { role: "tool", content: [] },
    ];
    const out = withCachePoints(messages);
    expect(out.map((m) => pointed(m.providerOptions))).toEqual([false, false, true, false, true]);
    // What else a message carries for a provider stays.
    expect(out[2]?.providerOptions).toEqual({ openai: { store: false }, ...CACHED });
  });

  it("are four at most on every call of a run, on the same system text, which never holds the date", async () => {
    const q = await ask("Which countries do we sell in?");
    const { model, prompts, tools } = scripted([
      step(lookup("Germany"), lookup("France"), lookup("Spain")),
      step(lookup("Italy")),
      clarifies(),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "test" });
    expect(prompts).toHaveLength(3);
    for (const [i, prompt] of prompts.entries()) {
      const p = points(prompt);
      expect(p.system).toEqual([true, true]);
      expect(p.system.length + p.messages.length).toBeLessThanOrEqual(4);
      // The last message is always a point; after the first step, so is where the previous step put its own.
      const count = prompt.filter((m) => m.role !== "system").length;
      expect(p.messages.at(-1)).toBe(count - 1);
      if (i > 0) expect(p.messages).toHaveLength(2);
      expect(systemText(prompt)).toBe(systemText(prompts[0] ?? []));
      expect(tools[i]).toEqual(tools[0]);
    }
    expect(systemText(prompts[0] ?? [])).not.toContain("2026-10-10");
    const question = prompts[0]?.find((m) => m.role === "user");
    expect(JSON.stringify(question)).toContain("Today is 2026-10-10; times are UTC.");
  });
});

describe("wrapping up", () => {
  it("keeps the tools and the system text: the model is told in a message, and only the endings run", async () => {
    const q = await ask("Which countries do we sell in?");
    const { model, prompts, tools } = scripted([step(lookup("Germany")), clarifies()]);
    // Its working time is up at once: it wraps up before its first step.
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { wrapUpAtMs: 0 } },
    );
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(tools[0]).toEqual(tools[1]);
    expect(tools[0]).toContain("value_lookup");
    expect(tools[0]?.length).toBeGreaterThan(analyst.ending.tools.length);
    expect(systemText(prompts[1] ?? [])).toBe(systemText(prompts[0] ?? []));
    // Told once, as the latest message, and still there on the next step.
    const said = (prompt: LanguageModelV4Prompt) => JSON.stringify(prompt).split(JSON.stringify(WRAP_UP)).length - 1;
    expect(prompts[0]?.at(-1)?.role).toBe("user");
    expect(JSON.stringify(prompts[0]?.at(-1))).toContain("Wrap up now");
    expect(said(prompts[1] ?? [])).toBe(1);
    // The lookup it made anyway didn't run.
    // Named from the endings this run has: a conversation that isn't about an App has no App tools.
    expect(JSON.stringify(prompts[1])).toContain(wrappingUp(["answer", "clarify"]));
    const [row] = await s.t.owner<{ status: string }[]>`
      select status from app.tool_call where run_id = ${q.runId} and tool = 'value_lookup'`;
    expect(row?.status).toBe("failed");
  });

  it("whose steps run out is nudged, and the nudge gets its own steps, said once", async () => {
    const q = await ask("Which countries do we sell in?");
    const { model, prompts } = scripted([
      step(lookup("Germany")),
      step(lookup("France")),
      step(lookup("Spain")),
      step(lookup("Italy")),
      step(lookup("Austria")),
      clarifies(),
    ]);
    // Too many failed queries from the start: it wraps up at once, and its three steps go on lookups.
    const result = await runAttempt(
      deps(model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "test", limits: { maxFailedQueries: 0 } },
    );
    expect(result).toEqual({ status: "succeeded", outcome: "clarify" });
    expect(prompts).toHaveLength(6);
    // The nudge is the latest message, with no wrap-up note after it.
    expect(JSON.stringify(prompts[3]?.at(-1))).toContain("needs to end with the answer tool");
    expect(JSON.stringify(prompts[3])).not.toContain("Wrap up now");
  });
});

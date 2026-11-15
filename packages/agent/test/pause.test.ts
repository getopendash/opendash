// A person's run pauses instead of failing: at the workspace's dollar ceiling (Settings → Usage)
// it ends at a step boundary as paused, saying what it spent, and "Continue" is the next turn, which sees what was done.
// With no ceiling, the same spend goes on. Runs that aren't a person's in OpenDash keep the analyst's own budget.
import type { LanguageModelV4Content } from "@ai-sdk/provider";
import { getRun, reserveForRun, runEvents, spendView, submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, DEFAULT_MODEL, runAttempt } from "../src";
import { call, scripted } from "./helpers/scripted";

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
const ask = (text: string, threadId?: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    {
      orgId: s.orgId,
      userId: s.userId,
      connectionId: s.connectionId,
      text,
      channel: "web",
      model: DEFAULT_MODEL,
      ...(threadId ? { threadId } : {}),
    },
  );
/** A step that costs about $0.60 on the default model: 200k fresh input tokens. */
const costly = (...content: LanguageModelV4Content[]) => ({
  content,
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: {
    inputTokens: { total: 200_000, noCache: 200_000, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 100, text: 100, reasoning: 0 },
  },
  warnings: [],
});
const ceiling = (usd: number | null) =>
  s.t.owner`
    insert into app.spend_limit (org_id, run_ceiling_usd) values (${s.orgId}, ${usd})
    on conflict (org_id) do update set run_ceiling_usd = excluded.run_ceiling_usd`;
const endedWith = async (runId: string) =>
  (await runEvents(s.deps, viewer(), runId)).filter((e) => e.type === "attempt_ended").map((e) => e.data.reason);

describe("a person's run at its ceiling", () => {
  it("pauses, saying what it spent, and Continue sees what it did", async () => {
    await ceiling(0.5);
    const q = await ask("List what OpenDash knows here.");
    const { model } = scripted([costly(call("ls", { path: "/" })), costly(call("ls", { path: "/skills" }))]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    expect(result).toMatchObject({ status: "succeeded" });
    const run = await getRun(s.deps, viewer(), q.runId);
    expect(run?.outcome).toMatchObject({ kind: "paused", reason: "ceiling", ceilingUsd: 0.5 });
    expect(((run?.outcome ?? {}) as { spentUsd: number }).spentUsd).toBeGreaterThanOrEqual(0.5);
    expect(await endedWith(q.runId)).toEqual(["paused"]);

    // Continue: the next turn, which sees the first one's work (its ls result) and does nothing twice.
    const next = await ask("Continue", q.threadId);
    const { model: m2, prompts } = scripted([
      {
        ...costly(call("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] })),
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
      },
    ]);
    await runAttempt(deps(m2), { orgId: s.orgId, runId: next.runId }, { workerId: "t" });
    expect(JSON.stringify(prompts[0])).toContain("README.md");
  });

  it("goes on past the same spend when the workspace has no ceiling", async () => {
    await ceiling(null);
    const q = await ask("List what OpenDash knows here, again.");
    const { model } = scripted([
      costly(call("ls", { path: "/" })),
      costly(call("ls", { path: "/skills" })),
      costly(call("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] })),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    expect(result).toMatchObject({ status: "succeeded" });
    expect((await getRun(s.deps, viewer(), q.runId))?.outcome).toMatchObject({ kind: "clarify" });
  });

  it("with no ceiling, still pauses at what's left of the workspace's daily limit", async () => {
    const today = (await s.tenant((tx) => spendView(tx, s.orgId))).spent.day;
    await s.t.owner`
      insert into app.spend_limit (org_id, daily_usd, run_ceiling_usd) values (${s.orgId}, ${today + 0.5}, ${null})
      on conflict (org_id) do update set daily_usd = excluded.daily_usd, run_ceiling_usd = excluded.run_ceiling_usd`;
    const q = await ask("List what OpenDash knows here, once more.");
    const { model } = scripted([costly(call("ls", { path: "/" })), costly(call("ls", { path: "/skills" }))]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    expect((await getRun(s.deps, viewer(), q.runId))?.outcome).toMatchObject({ kind: "paused", reason: "limit" });
    await s.t.owner`update app.spend_limit set daily_usd = null where org_id = ${s.orgId}`;
  });

  it("reserves its ceiling while it runs, and pauses when its last call crosses it with no step after", async () => {
    await ceiling(0.5);
    const q = await ask("Tell me about OpenDash.");
    const text = (t: string) => ({
      ...costly(),
      content: [{ type: "text" as const, text: t }],
      finishReason: { unified: "stop" as const, raw: undefined },
    });
    // Two answers in plain words (no tool): the first is nudged; the second crosses the ceiling and the SDK stops.
    const { model } = scripted([text("It's a data product."), text("It answers questions about your data.")]);
    await runAttempt(deps(model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" });
    expect((await getRun(s.deps, viewer(), q.runId))?.outcome).toMatchObject({ kind: "paused", reason: "ceiling" });
    const [held] = await s.t.owner<
      { hold: string }[]
    >`select hold_usd::text as hold from app.run where id = ${q.runId}`;
    expect(Number(held?.hold)).toBe(0.5);
  });

  it("shares what the limits leave between runs going on together, and a stale attempt can't change a hold", async () => {
    await ceiling(1.5);
    const { spent } = await s.deps.withTenant(s.orgId, (tx) => spendView(tx, s.orgId));
    await s.t.owner`update app.spend_limit set daily_usd = ${spent.day + 2} where org_id = ${s.orgId}`;
    const a = await ask("The first of two at once.");
    const b = await ask("The second of two at once.");
    await s.t.owner`update app.run set status = 'running', attempt = 1 where id in (${a.runId}, ${b.runId})`;
    const reserve = (runId: string, attempt: number) =>
      s.deps.withTenant(s.orgId, (tx) => reserveForRun(tx, s.orgId, { id: runId, attempt }));
    // The second, not reserved yet, counts at its profile's cap ($1.50): the first gets what's left of the $2 day.
    const first = await reserve(a.runId, 1);
    expect(first).toMatchObject({ byLimit: true });
    expect(first.spendable).toBeCloseTo(0.5, 2);
    // The second then gets what the first's hold leaves, up to its ceiling: the two never pass the day's $2.
    const second = await reserve(b.runId, 1);
    expect(second.spendable).toBeCloseTo(1.5, 2);
    expect(first.spendable + second.spendable).toBeLessThanOrEqual(2.001);
    // An attempt that isn't the run's live one writes nothing.
    await reserve(a.runId, 0);
    const [held] = await s.t.owner<
      { hold: string }[]
    >`select hold_usd::text as hold from app.run where id = ${a.runId}`;
    expect(Number(held?.hold)).toBeCloseTo(0.5, 2);
    await s.t.owner`update app.run set status = 'cancelled', finished_at = now() where id in (${a.runId}, ${b.runId})`;
    await s.t.owner`update app.spend_limit set daily_usd = null where org_id = ${s.orgId}`;
  });
});

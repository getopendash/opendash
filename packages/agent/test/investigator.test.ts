// The Investigator offline: AI SDK's mock plays the model, everything else is real (the demo
// source, the gateway, the ledger, the gate). A run rechecks an insight by two independent queries and writes it up
// through the gate; past its query budget only its write-up is offered; past its dollars it stops.
import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import {
  checkDefinitions,
  demoPack,
  installDefinitions,
  investigationsFor,
  listDefinitions,
  settleInvestigation,
  startInvestigation,
  verifyDefinitions,
} from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, analyst, INVESTIGATOR_BUDGET, investigator, runAttempt } from "../src";
import { aliasOf, call, messagesOf, scripted, step, systemOf } from "./helpers/scripted";

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
const ids: Record<string, string> = {};
const ctx = () => ({ orgId: s.orgId, userId: s.userId });

beforeAll(async () => {
  s = await learnedSource();
  await s.tenant((tx) =>
    installDefinitions(tx, ctx(), s.connectionId, demoPack("postgres"), { status: "proposed", source: "pack" }),
  );
  await checkDefinitions(s.deps, { orgId: s.orgId, connectionId: s.connectionId }, { now: NOW });
  const list = await s.tenant((tx) => listDefinitions(tx, s.orgId, { connectionId: s.connectionId }));
  await s.tenant((tx) =>
    verifyDefinitions(
      tx,
      ctx(),
      list.map((d) => d.id),
    ),
  );
  for (const d of list) ids[d.slug] = d.id;
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

/** An insight about New accounts in September, investigated: its run's id. */
async function investigated(): Promise<{ insightId: string; runId: string }> {
  const insightId = uuidv7();
  await s.t.owner`insert into app.insight (org_id, id, connection_id, kind, metric_id, direction, period, title,
      summary, severity, dedupe_key)
    values (${s.orgId}, ${insightId}, ${s.connectionId}, 'anomaly', ${ids.new_accounts as string}, 'down', '2026-09-01',
      'New accounts fell more than usual in September 2026', 'They fell.', 2, ${`anomaly:${insightId}`})`;
  const started = await startInvestigation(
    { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
    { orgId: s.orgId, insightId },
  );
  expect(started).toEqual({ status: "queued" });
  const [v] = await s.t.owner<
    { run_id: string }[]
  >`select run_id from app.investigation where insight_id = ${insightId}`;
  return { insightId, runId: v?.run_id as string };
}

const SEPT = `select count(*)::int as accounts from public.accounts
  where created_at >= '2026-09-01' and created_at < '2026-10-01' and not is_test`;
const BY_DAY = `select sum(n)::int as accounts from (select date_trunc('day', created_at) as d, count(*) as n
  from public.accounts where created_at >= '2026-09-01' and created_at < '2026-10-01' and not is_test group by 1) x`;
const AUG = SEPT.replace("2026-09-01", "2026-08-01").replace("2026-10-01", "2026-09-01");

describe("the Investigator", () => {
  it("rechecks an insight by two independent queries and writes it up, every figure a traced cell", async () => {
    const { insightId, runId } = await investigated();
    const { model, prompts, tools } = scripted([
      step(call("sql_query", { title: "New accounts in September", sql: SEPT })),
      step(call("sql_query", { title: "September's new accounts, by day", sql: BY_DAY })),
      step(call("sql_query", { title: "New accounts in August", sql: AUG })),
      (prompt) => {
        const sept = aliasOf(prompt, "New accounts in September");
        const byDay = aliasOf(prompt, "September's new accounts, by day");
        const aug = aliasOf(prompt, "New accounts in August");
        return step(
          call("investigation", {
            confirmed: true,
            moved: `Counted again, September 2026 had ⟦${sept}:0:accounts⟧ new accounts, ⟦delta(${sept}:0:accounts, ${aug}:0:accounts)⟧ against August's ⟦${aug}:0:accounts⟧.`,
            reasons: [],
            unchecked: ["Ad spend and campaigns aren't in the data."],
            cross_checks: [{ headline: `${sept}:0:accounts`, check: `${byDay}:0:accounts` }],
          }),
        );
      },
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId }, { workerId: "t" }, investigator);
    expect(result).toEqual({ status: "succeeded", outcome: "investigation" });
    // Its prompt names the insight and its rules; it's offered the tools to read and query, and its write-up only.
    expect(systemOf(prompts[0])).toContain("You are the Investigator in OpenDash");
    // The insight is this run's alone: it goes with the brief, after the cache.
    expect(messagesOf(prompts[0])).toContain("New accounts fell more than usual in September 2026");
    expect(systemOf(prompts[0])).not.toContain("New accounts fell more than usual");
    expect(tools[0]).toEqual(expect.arrayContaining(["metric_query", "sql_query", "investigation"]));
    expect(tools[0]).not.toEqual(expect.arrayContaining(["answer"]));
    for (const t of ["answer", "clarify", "remember"]) expect(tools[0]).not.toContain(t);

    expect(await settleInvestigation(s.deps, s.orgId, runId)).toBe("confirmed");
    const view = (await s.tenant((tx) => investigationsFor(tx, s.orgId, [insightId]))).get(insightId);
    expect(view).toMatchObject({ status: "confirmed", queries: 3 });
    const moved = view?.outcome?.moved;
    expect(moved?.rendered).toMatch(/^Counted again, September 2026 had \d+ new accounts/);
    expect(moved?.segments.filter((x) => "ref" in x && x.kind === "number")).toHaveLength(3);
    expect(view?.outcome?.unchecked.map((u) => u.rendered)).toEqual(["Ad spend and campaigns aren't in the data."]);
  });

  it("past its query budget, is told to write up, its tools kept so the cache holds", async () => {
    const { runId } = await investigated();
    const queries = Array.from({ length: INVESTIGATOR_BUDGET.maxQueries }, (_, i) =>
      step(call("sql_query", { title: `Probe ${i}`, sql: "select 1 as one" })),
    );
    const { model, tools, prompts } = scripted([
      ...queries,
      step(
        call("investigation", {
          confirmed: false,
          moved: "It couldn't be counted again within its budget.",
          reasons: [],
          unchecked: [],
        }),
      ),
    ]);
    await runAttempt(deps(model), { orgId: s.orgId, runId }, { workerId: "t" }, investigator);
    expect(tools[INVESTIGATOR_BUDGET.maxQueries - 1]).toContain("sql_query");
    expect(tools[INVESTIGATOR_BUDGET.maxQueries]).toEqual(tools[0]);
    expect(JSON.stringify(prompts[INVESTIGATOR_BUDGET.maxQueries]?.at(-1))).toContain(
      "Wrap up now: call investigation",
    );
    expect(JSON.stringify(prompts[INVESTIGATOR_BUDGET.maxQueries - 1])).not.toContain("Wrap up now");
  });

  it("stops at its dollar budget", async () => {
    const { runId } = await investigated();
    // One model call priced past $2 (a million uncached input tokens).
    const costly: LanguageModelV4GenerateResult = {
      ...step(call("sql_query", { title: "Probe", sql: "select 1 as one" })),
      usage: {
        inputTokens: { total: 1_000_000, noCache: 1_000_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      },
    };
    const { model } = scripted([costly, step(call("sql_query", { title: "More", sql: "select 1 as one" }))]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId }, { workerId: "t" }, investigator);
    expect(result).toEqual({ status: "failed", outcome: "no_answer" });
    const [run] = await s.t.owner<{ outcome: { reason: string } }[]>`select outcome from app.run where id = ${runId}`;
    expect(run?.outcome.reason).toBe("The investigation reached its $2 budget before its write-up.");
    expect(await settleInvestigation(s.deps, s.orgId, runId)).toBe("failed");
  });

  it("keeps its budget across attempts: a retry starts from what the run already spent", async () => {
    const { runId } = await investigated();
    // Most of its $2 on one call, then the provider fails and the job is retried.
    const costly: LanguageModelV4GenerateResult = {
      ...step(call("sql_query", { title: "Probe", sql: "select 1 as one" })),
      usage: {
        inputTokens: { total: 850_000, noCache: 850_000, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 100, text: 100, reasoning: 0 },
      },
    };
    const first = scripted([
      costly,
      () => {
        throw new Error("overloaded");
      },
    ]);
    await expect(
      runAttempt(deps(first.model), { orgId: s.orgId, runId }, { workerId: "t" }, investigator),
    ).rejects.toThrow(/model call failed/);
    const retry = scripted([
      step(call("investigation", { confirmed: false, moved: "It ran out of budget.", reasons: [], unchecked: [] })),
    ]);
    await runAttempt(deps(retry.model), { orgId: s.orgId, runId }, { workerId: "t" }, investigator);
    // The retry is past 80% of the run's dollars from its first call: it's told to write up at once.
    expect(JSON.stringify(retry.prompts[0]?.at(-1))).toContain("Wrap up now: call investigation");
  });

  it("runs only as its own job: another job's definition doesn't take an investigation's run", async () => {
    const { runId } = await investigated();
    const { model } = scripted([]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId }, { workerId: "t" }, analyst);
    expect(result).toEqual({ status: "failed", outcome: "no_answer" });
  });

  it("is the investigation job without being named: the run's profile picks it", async () => {
    const { runId } = await investigated();
    const { model } = scripted([
      step(call("investigation", { confirmed: false, moved: "Nothing moved.", reasons: [], unchecked: [] })),
    ]);
    const result = await runAttempt(deps(model), { orgId: s.orgId, runId }, { workerId: "t" });
    expect(result?.status).toBe("succeeded");
  });
});

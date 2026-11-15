// Query history v0 as the analyst sees it: the catalog in the prompt leads with the tables the team queries most, says
// how often, and how often both sides of a join are read together; a table's file gives its most-run queries,
// fenced as data.
import type { LanguageModelV4CallOptions } from "@ai-sdk/provider";
import { dialectFor } from "@opendash/connectors";
import { catalogModel, DEFAULT_MODEL, effortOf, mineHistory, submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, callOptions, runAttempt } from "../src";
import { catalogForPrompt, loadCatalog, tablesFolder } from "../src/instructions/catalog";
import { streaming } from "./helpers/scripted";

let s: LearnedSource;
const BY_PLAN =
  "select p.name, sum(s.amount_cents) from public.subscriptions s join public.plans p on p.id = s.plan_id where s.status = $1 group by 1";

beforeAll(async () => {
  s = await learnedSource();
  const postgres = dialectFor("postgres");
  await mineHistory(
    s.deps,
    { orgId: s.orgId, connectionId: s.connectionId },
    {
      ...postgres,
      queryHistory: async () => ({
        available: true,
        statements: [
          { fingerprint: "1", sql: BY_PLAN, calls: 120, totalMs: 900 },
          { fingerprint: "2", sql: "select count(*) from public.accounts where country = $1", calls: 30, totalMs: 4 },
        ],
      }),
    },
    { close: async () => {} },
  );
}, 300_000);

afterAll(async () => {
  await s?.close();
});

const step = (toolName: string, input: unknown, n: number) => ({
  content: [{ type: "tool-call" as const, toolCallId: `${toolName}-${n}`, toolName, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: undefined },
  usage: {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  },
  warnings: [],
});

describe("query history, for the analyst", () => {
  it("orders the catalog by use, and says how often tables and joins are read", async () => {
    const tables = await s.tenant((tx) => loadCatalog(tx, s.orgId, s.connectionId));
    expect(tables.slice(0, 3).map((t) => `${t.schema}.${t.name}`)).toEqual([
      "public.plans",
      "public.subscriptions",
      "public.accounts",
    ]);
    const subscriptions = tables.find((t) => t.name === "subscriptions");
    expect(subscriptions?.queries).toBe(120);
    expect(subscriptions?.columns.find((c) => c.name === "plan_id")?.references).toMatchObject({
      table: "plans",
      queries: 120,
    });
    // accounts and subscriptions are never read together.
    expect(subscriptions?.columns.find((c) => c.name === "account_id")?.references?.queries).toBe(0);
    const prompt = catalogForPrompt(tables);
    expect(prompt).toContain("public.subscriptions (");
    expect(prompt).toMatch(/public\.subscriptions \([^)]*read by 120 of the team's query runs\)/);
    expect(prompt).toContain("→ public.plans.id (declared; read together in 120 of the team's query runs)");
  });

  it("lists a table that isn't learned in one line, its columns left to the table's file", async () => {
    // A table its admin didn't pick is known by its columns, and the gateway profiles it before it's read.
    await s.t.owner`
      update app.catalog_object set profile = jsonb_build_object('rows', 50)
      where connection_id = ${s.connectionId} and fq_name = 'support.tickets'`;
    try {
      const prompt = catalogForPrompt(await s.tenant((tx) => loadCatalog(tx, s.orgId, s.connectionId)));
      const known = prompt.slice(prompt.indexOf("Known, not learned yet"));
      expect(known).toMatch(/its first query checks it for personal data/);
      expect(known).toMatch(/^support\.tickets \(about 50 rows/m);
      // Its columns aren't in the prompt; a learned table's still are.
      expect(prompt).not.toMatch(/^ {2}csat /m);
      expect(prompt).toMatch(/^public\.accounts \(/m);
      expect(known).not.toMatch(/public\.accounts/);
    } finally {
      // The next sync of a learned table profiles it again; the rest of this file reads it as profiled.
      await s.t.owner`
        update app.catalog_object set profile = profile || jsonb_build_object('method', 'statistics')
        where connection_id = ${s.connectionId} and fq_name = 'support.tickets'`;
    }
  });

  it("gives a table's file the team's most-run queries of it, fenced as data", async () => {
    const [source] = await s.t.owner<{ name: string }[]>`select name from app.connection where id = ${s.connectionId}`;
    const path = `${tablesFolder(source?.name ?? "")}/public.subscriptions.md`;
    const calls: LanguageModelV4CallOptions[] = [];
    const model = new MockLanguageModelV4(
      streaming(async (options) => {
        calls.push(options);
        return calls.length === 1
          ? step("read", { path }, 1)
          : step("clarify", { questions: [{ question: "Which one?", options: ["A", "B"] }] }, 2);
      }),
    );
    const deps: AgentDeps = {
      withTenant: s.deps.withTenant,
      secrets: s.secrets,
      edition: "community",
      model: async () => ({
        model,
        provider: "opendash",
        route: "anthropic",
        ...callOptions("anthropic", catalogModel(DEFAULT_MODEL) as never, effortOf(DEFAULT_MODEL, "high")),
        keySource: "deployment",
      }),
      now: () => new Date("2026-10-11T12:00:00Z"),
    };
    const { runId } = await submitQuestion(
      { withTenant: s.deps.withTenant, boss: null },
      {
        orgId: s.orgId,
        userId: s.userId,
        connectionId: s.connectionId,
        text: "Revenue by plan?",
        channel: "eval",
        model: "mock",
      },
    );
    await runAttempt(deps, { orgId: s.orgId, runId }, { workerId: "history" });
    const result = JSON.stringify(calls[1]?.prompt.filter((m) => m.role === "tool"));
    expect(result).toContain("how_your_team_queries_it");
    expect(result).toContain('<context source=\\"query history: public.subscriptions\\" trust=\\"data\\">');
    expect(result).toContain("-- run 120 times");
    expect(result).toContain("where s.status = $1");
    expect(result).toContain('"teamQueryRuns":120');
    expect(result).toContain('"teamQueryRunsTogether":120');
    // The step the person sees counts the queries; the SQL stays with the model.
    const [event] = await s.t.owner<{ data: Record<string, unknown> }[]>`
      select data from app.run_event where run_id = ${runId} and type = 'tool_result'`;
    expect(event?.data).toMatchObject({ tool: "read", table: "public.subscriptions", patterns: 1 });
    expect(JSON.stringify(event?.data)).not.toContain("status = $1");
  });
});

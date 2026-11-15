// The Analyst on ClickHouse and MySQL, offline: AI SDK's mock plays the model, everything else is
// real (the demo company in each database, learned the way the product does it). A query the database would get wrong
// or can't parse comes back with its fix; the model writes it the database's way, and the gate accepts the answer.
// Skipped for a database that isn't running.
import { submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { clickhouseAvailable, mysqlAvailable } from "@opendash/evals/testing";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, runAttempt } from "../src";
import { aliasOf, call, type Prompt, scripted, step } from "./helpers/scripted";

const deps = (s: LearnedSource, model: MockLanguageModelV4): AgentDeps => ({
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
const ask = (s: LearnedSource, text: string) =>
  submitQuestion(
    { withTenant: s.deps.withTenant, boss: null },
    { orgId: s.orgId, userId: s.userId, connectionId: s.connectionId, text, channel: "eval", model: "mock" },
  );
/** The last result of a tool, as the model was sent it. */
const lastResult = (prompt: Prompt, tool: string) =>
  JSON.stringify(
    prompt
      .flatMap((m) => (m.role === "tool" ? m.content : []))
      .filter((p) => p.type === "tool-result" && p.toolName === tool)
      .at(-1),
  );
/** The answer, citing the query titled `title` and checked against the one titled `check`, by their aliases. */
const answer = (text: (alias: string) => string, title: string, check: string) => (prompt: Prompt) => {
  const [a, b] = [aliasOf(prompt, title), aliasOf(prompt, check)];
  return step(
    call("answer", {
      status: "answered",
      markdown: text(a),
      interpretation: [],
      caveats: [],
      cross_checks: [{ headline: `${a}:0:n`, check: `${b}:0:n` }],
    }),
  );
};
/** The run ended with an answer the gate accepted, in how many model calls. */
async function answered(s: LearnedSource, runId: string, calls: number, prompts: Prompt[]) {
  const [run] = await s.t.owner<{ outcome: { kind: string; verified: boolean } }[]>`
    select outcome from app.run where id = ${runId}`;
  expect(run?.outcome).toMatchObject({ kind: "answer", verified: true });
  expect(prompts).toHaveLength(calls);
}

const onClickHouse = await clickhouseAvailable();
describe.skipIf(!onClickHouse)("the Analyst on ClickHouse", () => {
  let s: LearnedSource;
  beforeAll(async () => {
    s = await learnedSource({ dialect: "clickhouse" });
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it("is refused a ReplacingMergeTree read without FINAL, told how to read it, and answers once it does", async () => {
    const p = s.clickhouse?.prefix ?? "";
    const q = await ask(s, "How many support tickets are open right now?");
    const open = (final: string) => `select count() as n from ${p}support.tickets${final} where status = 'open'`;
    const { model, prompts } = scripted([
      step(call("sql_query", { title: "Open tickets, a first try", sql: open("") })),
      (prompt) => {
        expect(lastResult(prompt, "sql_query")).toContain("Read it with FINAL to count each key once");
        return step(
          call("sql_query", { title: "Open tickets", sql: open(" final") }),
          call("sql_query", {
            title: "Open tickets, counted another way",
            sql: `select countIf(status = 'open') as n from ${p}support.tickets final`,
          }),
        );
      },
      answer(
        (q1) => `⟦${q1}:0:n⟧ support tickets are open right now.`,
        "Open tickets",
        "Open tickets, counted another way",
      ),
    ]);
    expect(await runAttempt(deps(s, model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" })).toEqual({
      status: "succeeded",
      outcome: "answer",
    });
    await answered(s, q.runId, 3, prompts);
  });
});

const onMySql = await mysqlAvailable();
describe.skipIf(!onMySql)("the Analyst on MySQL", () => {
  let s: LearnedSource;
  beforeAll(async () => {
    s = await learnedSource({ dialect: "mysql" });
  }, 300_000);
  afterAll(async () => {
    await s?.close();
  });

  it("is told MySQL has no FILTER when its query doesn't parse, and answers with a CASE", async () => {
    const q = await ask(s, "How many invoices issued in September 2026 were paid?");
    const invoices = `${s.mysql?.prefix ?? ""}billing.invoices`;
    const range = "x.issued_at >= '2026-09-01' and x.issued_at < '2026-10-01'";
    const { model, prompts } = scripted([
      step(
        call("sql_query", {
          title: "Paid invoices, a first try",
          sql: `select count(*) filter (where x.status = 'paid') as n from ${invoices} x where ${range}`,
        }),
      ),
      (prompt) => {
        expect(lastResult(prompt, "sql_query")).toContain("MySQL has no FILTER (WHERE …)");
        return step(
          call("sql_query", {
            title: "Paid invoices, September 2026",
            sql: `select sum(case when x.status = 'paid' then 1 else 0 end) as n from ${invoices} x where ${range}`,
          }),
          call("sql_query", {
            title: "Paid invoices, September 2026, counted another way",
            sql: `select count(*) as n from ${invoices} x where ${range} and x.status = 'paid'`,
          }),
        );
      },
      answer(
        (q1) => `⟦${q1}:0:n⟧ invoices issued in September 2026 were paid.`,
        "Paid invoices, September 2026",
        "Paid invoices, September 2026, counted another way",
      ),
    ]);
    expect(await runAttempt(deps(s, model), { orgId: s.orgId, runId: q.runId }, { workerId: "t" })).toEqual({
      status: "succeeded",
      outcome: "answer",
    });
    await answered(s, q.runId, 3, prompts);
  });
});

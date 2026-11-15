// The crash matrix (the chaos suite), offline. One scripted run (two queries,
// a memory, a follow-up sent before it started, an answer the gate accepts) dies at every transaction it makes, just
// before it commits and just after, and a second attempt takes it from there, as a retried job would on another worker.
// Each time:
//   - the run ends, answered, by the second attempt at the latest;
//   - no query ran twice for one call, the memory was kept once, and the follow-up was read once;
//   - every tool call in the transcript has exactly one result;
// and an attempt that lost the run while a tool worked (a zombie) writes nothing when it wakes.
//
// Dying is done in this process: from the transaction it dies at, nothing more reaches the database, and every
// transaction still open then rolls back (the one it dies in, a heartbeat, a tool's), as a killed process's would.
// Postgres makes each transaction atomic, so a real kill adds only the dropped socket, which isn't the harness's to
// test; what is, is that every boundary between transactions resumes.
import { submitQuestion } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import type { TenantTx } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import { MRR_SQL } from "@opendash/evals";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { type AgentDeps, type AgentTool, analyst, defineAgent, runAttempt } from "../src";
import { call, type Prompt, scripted, step } from "./helpers/scripted";

let s: LearnedSource;

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

class Killed extends Error {
  override name = "Killed";
}

type Open = <T>(fn: (tx: TenantTx) => Promise<T>) => Promise<T>;

/** The run's database access, as a process that dies at its `at`th transaction: just before it commits, or just after. */
function dyingAt(at: number, when: "before" | "after") {
  let n = 0;
  let dead = false;
  const through = async <T>(open: Open, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
    if (dead) throw new Killed();
    n += 1;
    const here = n === at;
    const result = await open(async (tx) => {
      const r = await fn(tx);
      if (here && when === "before") dead = true;
      // Dead by now (here, or in another transaction meanwhile), it never commits.
      if (dead) throw new Killed();
      return r;
    });
    if (here) dead = true;
    return result;
  };
  return {
    withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => through((f) => s.deps.withTenant(orgId, f), fn),
    withUser: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) =>
      through((f) => withTenantOn(s.t.app, { orgId, userId }, f), fn),
    died: () => dead,
  };
}

const alive = {
  withTenant: <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>) => s.deps.withTenant(orgId, fn),
  withUser: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenantOn(s.t.app, { orgId, userId }, fn),
};

const deps = (model: MockLanguageModelV4, db: Pick<AgentDeps, "withTenant" | "withUser"> = alive): AgentDeps => ({
  ...db,
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

const SEPTEMBER = "MRR end of September";
const CHECK = "MRR, summed another way";

type ToolPart = { type: string; toolName?: string; output?: { type: string; value?: Record<string, unknown> } };
const results = (prompt: Prompt) =>
  prompt.flatMap((m) => (m.role === "tool" ? (m.content as ToolPart[]) : [])).filter((p) => p.type === "tool-result");
const aliasIn = (prompt: Prompt, title: string) =>
  results(prompt).find((p) => p.output?.type === "json" && p.output.value?.title === title)?.output?.value?.alias as
    | string
    | undefined;
const remembered = (prompt: Prompt) =>
  results(prompt).some((p) => p.toolName === "remember" && p.output?.type === "json" && p.output.value?.remembered);

/** A careful model: it runs what it hasn't got yet (the work a crash cut short), then answers from both queries. */
const careful = (fact: string) => (prompt: Prompt) => {
  const sep = aliasIn(prompt, SEPTEMBER);
  const check = aliasIn(prompt, CHECK);
  const kept = remembered(prompt);
  if (sep && check && kept) {
    return step(
      call("answer", {
        status: "answered",
        markdown: `MRR was ⟦${sep}:0:mrr|currency:USD,compact⟧ at the end of September 2026.`,
        interpretation: [],
        caveats: [],
        cross_checks: [{ headline: `${sep}:0:mrr`, check: `${check}:0:mrr` }],
      }),
    );
  }
  const asOf = [{ name: "as_of", value: "2026-10-01T00:00:00Z" }];
  return step(
    ...[
      !sep && call("sql_query", { title: SEPTEMBER, sql: MRR_SQL, params: asOf }),
      !check && call("sql_query", { title: CHECK, sql: `select sum(mrr) as mrr from (${MRR_SQL}) x`, params: asOf }),
      !kept && call("remember", { fact }),
    ].filter((c) => c !== false),
  );
};
const model = (fact: string) => scripted(Array.from({ length: 6 }, () => careful(fact))).model;

const FOLLOW_UP = "In dollars, please.";

const ask = async (fact: string) => {
  const submit = (text: string, threadId?: string) =>
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
  const q = await submit(`What was MRR at the end of September? And remember that ${fact.toLowerCase()}`);
  // Sent before the run starts: it's read at the first step boundary.
  await submit(FOLLOW_UP, q.threadId);
  return q;
};

/** What must hold however the first attempt died. */
async function expectWhole(runId: string, threadId: string, fact: string, where: string) {
  const [run] = await s.t.owner<
    {
      status: string;
      attempt: number;
      outcome: { kind: string; verified?: boolean };
      attempts: { attempt: number; reason: string }[];
      prompt: { attempt: number } | null;
    }[]
  >`select status, attempt, outcome, attempts, prompt from app.run where id = ${runId}`;
  expect(run, where).toMatchObject({ status: "succeeded", outcome: { kind: "answer", verified: true } });
  expect(run?.attempt, where).toBeLessThanOrEqual(2);
  // How its attempts ended, once each: the one that ended the run says it finished; one that died says nothing.
  const ends = run?.attempts ?? [];
  expect(new Set(ends.map((e) => e.attempt)).size, `${where}: an attempt's end twice`).toBe(ends.length);
  expect(ends.at(-1), `${where}: the run's end`).toMatchObject({ attempt: run?.attempt, reason: "finished" });
  // What it was sent is an attempt's that got that far.
  expect(run?.prompt?.attempt, `${where}: its prompt`).toBeLessThanOrEqual(run?.attempt ?? 0);
  const twice = await s.t.owner<{ n: number }[]>`
    select count(*)::int as n from app.query_run
    where requester_id = ${runId} and mode = 'execute' and tool_call_id is not null
    group by tool_call_id having count(*) > 1`;
  expect(twice, `${where}: a call's query ran twice`).toEqual([]);
  const [kept] = await s.t.owner<{ n: number }[]>`
    select count(*)::int as n from app.context_item
    where org_id = ${s.orgId} and kind = 'memory' and title = ${fact}`;
  expect(kept?.n, `${where}: the memory`).toBe(1);
  const [followUp] = await s.t.owner<{ read: boolean; joins: number }[]>`
    select m.seq is not null and m.status = 'complete' as read,
      (select count(*)::int from app.run_event e
        where e.run_id = ${runId} and e.type = 'input_joined' and e.data->>'messageId' = m.id::text) as joins
    from app.message m where m.thread_id = ${threadId} and m.text = ${FOLLOW_UP}`;
  expect(followUp, `${where}: the follow-up`).toEqual({ read: true, joins: 1 });
  const parts = await s.t.owner<{ role: string; part: { type: string; toolCallId?: string } }[]>`
    select m.role, p as part from app.message m, jsonb_array_elements(
      case when jsonb_typeof(m.content->'content') = 'array' then m.content->'content' else '[]'::jsonb end) p
    where m.org_id = ${s.orgId} and m.thread_id = ${threadId} and m.status = 'complete'`;
  const calls = parts.filter((p) => p.part.type === "tool-call").map((p) => p.part.toolCallId);
  const answered = parts.filter((p) => p.part.type === "tool-result").map((p) => p.part.toolCallId);
  expect(answered.sort(), `${where}: each call has one result`).toEqual(calls.sort());
}

describe("the crash matrix", () => {
  it("resumes from every transaction of a run, dying just before it commits and just after", async () => {
    const boundaries: string[] = [];
    for (const when of ["before", "after"] as const) {
      for (let at = 1; ; at += 1) {
        const fact = `By churn I mean churned MRR (case ${when} ${at}).`;
        const q = await ask(fact);
        const db = dyingAt(at, when);
        await runAttempt(deps(model(fact), db), { orgId: s.orgId, runId: q.runId }, { workerId: "w1" }).catch(
          (error: unknown) => {
            if (!(error instanceof Killed) && !db.died()) throw error;
          },
        );
        if (!db.died()) break;
        boundaries.push(`${when} ${at}`);
        await runAttempt(deps(model(fact)), { orgId: s.orgId, runId: q.runId }, { workerId: "w2" });
        await expectWhole(q.runId, q.threadId, fact, `died ${when} transaction ${at}`);
      }
    }
    // Every transaction a run makes, from its claim to its finish (about 47, its streamed pieces among them), was a
    // place to die, on both sides of its commit. The streamed pieces flush on a timer, so a slower run makes a few
    // more: the two sides needn't count the same.
    for (const side of ["before", "after"]) {
      expect(boundaries.filter((b) => b.startsWith(side)).length, side).toBeGreaterThan(30);
    }
  }, 600_000);

  it("writes nothing from an attempt that lost the run while one of its tools worked", async () => {
    let release = () => {};
    const parked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const inTool = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const probe: AgentTool = {
      name: "slow_probe",
      description: "Takes a while.",
      effect: "read",
      schema: z.object({}),
      execute: async () => {
        entered();
        await parked;
        return { value: { done: true } };
      },
    };
    const withProbe = defineAgent({
      ...analyst,
      tools: [...analyst.tools, probe],
      prepare: async (d, r) => {
        const prepared = await analyst.prepare(d, r);
        return { ...prepared, tools: [...prepared.tools, probe] };
      },
    });
    const fact = "By churn I mean churned MRR (the zombie case).";
    const q = await ask(fact);
    const zombie = runAttempt(
      deps(scripted([step(call("slow_probe", {}))]).model),
      { orgId: s.orgId, runId: q.runId },
      { workerId: "w1", limits: { tools: { quick: 60_000, query: 75_000, slow: 240_000, child: 720_000 } } },
      withProbe,
    );
    await inTool;
    // The job is retried elsewhere while the first attempt's tool still works: the second takes the run and ends it.
    await runAttempt(deps(model(fact)), { orgId: s.orgId, runId: q.runId }, { workerId: "w2" }, withProbe);
    const count = () =>
      s.t.owner<{ n: string }[]>`
        select concat_ws(' ',
          (select count(*) from app.message where thread_id = ${q.threadId}),
          (select count(*) from app.run_event where run_id = ${q.runId}),
          (select count(*) from app.tool_call where run_id = ${q.runId} and status <> 'unknown'),
          (select jsonb_array_length(attempts) || ':' || (prompt->>'attempt') from app.run where id = ${q.runId}),
          (select count(*) from app.prompt_text where org_id = ${s.orgId})) as n`;
    const [before] = await count();
    release();
    await zombie.catch(() => {});
    const [after] = await count();
    expect(after?.n).toBe(before?.n);
    await expectWhole(q.runId, q.threadId, fact, "the zombie");
    const [probeRow] = await s.t.owner<{ status: string; attempt: number }[]>`
      select status, attempt from app.tool_call where run_id = ${q.runId} and tool = 'slow_probe'`;
    // Its call stays as the second attempt left it: interrupted, never finished by the zombie.
    expect(probeRow).toMatchObject({ status: "unknown" });
  }, 120_000);
});

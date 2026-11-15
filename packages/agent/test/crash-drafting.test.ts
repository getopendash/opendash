// The crash matrix for a lead and its drafters, offline. A Modeler leading three
// tables, its drafters running at once, dies at every transaction any of them makes, just before it commits and just
// after, and a second attempt of the lead takes it from there, as a retried job would. The lead hands out a table
// again only when nothing says it's done (no result, no report): a drafter the crash cut off is the harness's to pick
// up when the lead resumes (resume.ts), and its report says so; one never started (the call cut off before it got
// that far) is the model's to ask for again, as a model would. Each time:
//   - the lead ends, its proposal holding each table's dataset once;
//   - no drafter is left queued or running, and each table had one drafter, resumed rather than started again;
//   - every tool call in each transcript has exactly one result.
// Dying is done in this process, as in crash.test.ts: from the transaction it dies at, nothing more reaches the
// database (the drafters' included, since they share the lead's process), and every transaction still open then rolls
// back. The drafters' transactions interleave, so where a number lands differs from run to run: what must hold, holds
// anywhere.
import { requestSourceDrafts } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import type { TenantTx } from "@opendash/db";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, modeler, runAttempt } from "../src";
import { DATASETS, tableIn } from "./helpers/drafting";
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

const BATCH = ["public.plans", "billing.credits", "billing.refunds"];

/** The database, as a process that dies at its `at`th transaction: just before it commits, or just after. */
function dyingAt(at: number, when: "before" | "after") {
  let n = 0;
  let dead = false;
  return {
    withTenant: async <T>(orgId: string, fn: (tx: TenantTx) => Promise<T>): Promise<T> => {
      if (dead) throw new Killed();
      n += 1;
      const here = n === at;
      const result = await s.deps.withTenant(orgId, async (tx) => {
        const r = await fn(tx);
        if (here && when === "before") dead = true;
        // Dead by now (here, or in another transaction meanwhile: a sibling drafter's), it never commits.
        if (dead) throw new Killed();
        return r;
      });
      if (here) dead = true;
      return result;
    },
    died: () => dead,
  };
}

type Part = {
  type: string;
  toolName?: string;
  output?: { type: string; value?: Record<string, unknown> };
};
const results = (prompt: Prompt) =>
  prompt.flatMap((m) => (m.role === "tool" ? (m.content as Part[]) : [])).filter((p) => p.type === "tool-result");
/** The lead's prompts that came after a restart picked a drafter up: the harness's report was there. */
let pickedUp = 0;

/**
 * A lead that hands out the tables nothing reports done yet (a call's result, or the harness's report of a drafter it
 * picked up), then finishes.
 */
const lead = (prompt: Prompt) => {
  const text = JSON.stringify(prompt);
  if (text.includes("Work under way when the run restarted")) pickedUp += 1;
  const done = new Set([
    ...results(prompt)
      .filter((r) => r.toolName === "draft_tables" && r.output?.value?.status === "done")
      .flatMap((r) => (r.output?.value?.tables as string[]) ?? []),
    ...BATCH.filter((t) => text.includes(`{\\"tables\\":[\\"${t}\\"],\\"status\\":\\"done\\"`)),
  ]);
  const left = BATCH.filter((t) => !done.has(t));
  return left.length
    ? step(...left.map((t) => call("draft_tables", { tables: [t] })))
    : step(call("finish_drafting", { left_out: [] }));
};

/** A careful drafter: it proposes its table's dataset unless a proposal of its own says it's kept, then briefs. */
const drafterStep = (prompt: Prompt) => {
  const mine = results(prompt).some(
    (r) => r.toolName === "propose_definitions" && ((r.output?.value?.yours as string[]) ?? []).length > 0,
  );
  return mine
    ? step(call("brief", { left_out: [] }))
    : step(call("propose_definitions", { datasets: [{ yaml: DATASETS[tableIn(prompt)], why: "One row each." }] }));
};

function depsFor(leadId: string, db: { withTenant: AgentDeps["withTenant"] }): AgentDeps {
  const models = new Map<string, MockLanguageModelV4>();
  return {
    withTenant: db.withTenant,
    secrets: s.secrets,
    edition: "community",
    model: async ({ runId }) => {
      if (!models.has(runId)) {
        models.set(runId, scripted(Array.from({ length: 8 }, () => (runId === leadId ? lead : drafterStep))).model);
      }
      return {
        model: models.get(runId) as MockLanguageModelV4,
        provider: "opendash",
        route: "anthropic",
        providerOptions: {},
        keySource: "deployment",
      };
    },
  };
}

async function batch() {
  const { proposalId } = await requestSourceDrafts(
    { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
    { orgId: s.orgId, userId: s.userId },
    { connectionId: s.connectionId, tables: BATCH },
  );
  const [p] = await s.t.owner<{ run_id: string }[]>`select run_id from app.proposal where id = ${proposalId}`;
  return { proposalId, leadId: p?.run_id as string };
}

/** What must hold however the first attempt died. */
async function expectWhole(leadId: string, proposalId: string, where: string) {
  const [run] = await s.t.owner<{ status: string; outcome: { kind: string; status: string } }[]>`
    select status, outcome from app.run where id = ${leadId}`;
  expect(run, where).toMatchObject({ status: "succeeded", outcome: { kind: "modeler", status: "proposed" } });
  const children = await s.t.owner<{ status: string; tables: string }[]>`
    select status, task->>'tables' as tables from app.run where parent_run_id = ${leadId}`;
  expect(
    children.filter((c) => ["queued", "running", "cancelling"].includes(c.status)),
    `${where}: left running`,
  ).toEqual([]);
  expect(new Set(children.map((c) => c.tables)).size, `${where}: one drafter per table`).toBe(children.length);
  const items = await s.t.owner<{ slug: string }[]>`
    select i.slug from app.proposal p join app.context_item i on i.org_id = p.org_id and i.id = any(p.items)
    where p.id = ${proposalId} and i.deleted_at is null`;
  expect(items.map((i) => i.slug).sort(), `${where}: each table's dataset once`).toEqual([
    "credits",
    "plans",
    "refunds",
  ]);
  const parts = await s.t.owner<{ part: { type: string; toolCallId?: string } }[]>`
    select p as part from app.run r join app.message m on m.org_id = r.org_id and m.thread_id = r.thread_id,
      jsonb_array_elements(case when jsonb_typeof(m.content->'content') = 'array' then m.content->'content' else '[]'::jsonb end) p
    where (r.id = ${leadId} or r.parent_run_id = ${leadId}) and m.status = 'complete'`;
  const calls = parts.filter((p) => p.part.type === "tool-call").map((p) => p.part.toolCallId);
  const answered = parts.filter((p) => p.part.type === "tool-result").map((p) => p.part.toolCallId);
  expect(answered.sort(), `${where}: each call has one result`).toEqual(calls.sort());
  // The lead's word on its drafters: each end follows a start of the same attempt, and every drafter that
  // ran was said to start.
  const said = await s.t.owner<{ attempt: number; type: string; child: string }[]>`
    select attempt, type, data->>'runId' as child from app.run_event
    where run_id = ${leadId} and type in ('child_started', 'child_ended') order by seq`;
  const open = new Set<string>();
  for (const e of said) {
    const key = `${e.attempt}:${e.child}`;
    if (e.type === "child_started") open.add(key);
    else expect(open.has(key), `${where}: ${e.child} ended in attempt ${e.attempt} without a start`).toBe(true);
  }
  const started = new Set(said.filter((e) => e.type === "child_started").map((e) => e.child));
  const ran = await s.t.owner<{ id: string }[]>`
    select id from app.run where parent_run_id = ${leadId} and attempt > 0`;
  for (const r of ran) expect(started.has(r.id), `${where}: ${r.id} ran unsaid`).toBe(true);
}

/** The source's drafts and proposals cleared, so each case starts from a source with no definitions. */
async function clear(proposalId: string) {
  await s.t
    .owner`update app.context_item set deleted_at = now() where connection_id = ${s.connectionId} and deleted_at is null`;
  await s.t.owner`update app.proposal set status = 'rejected' where id = ${proposalId}`;
}

describe("the crash matrix, leading drafters", () => {
  it("resumes from every transaction of a lead and its drafters, dying just before it commits and just after", async () => {
    const boundaries: string[] = [];
    for (const when of ["before", "after"] as const) {
      for (let at = 1; ; at += 1) {
        const { proposalId, leadId } = await batch();
        const db = dyingAt(at, when);
        await runAttempt(depsFor(leadId, db), { orgId: s.orgId, runId: leadId }, { workerId: "w1" }, modeler).catch(
          (error: unknown) => {
            if (!(error instanceof Killed) && !db.died()) throw error;
          },
        );
        if (!db.died()) {
          await clear(proposalId);
          break;
        }
        boundaries.push(`${when} ${at}`);
        await runAttempt(depsFor(leadId, s.deps), { orgId: s.orgId, runId: leadId }, { workerId: "w2" }, modeler);
        await expectWhole(leadId, proposalId, `died ${when} transaction ${at}`);
        await clear(proposalId);
      }
    }
    // Every transaction a batch makes, the lead's and its drafters', was a place to die, on both sides of its commit.
    for (const side of ["before", "after"]) {
      expect(boundaries.filter((b) => b.startsWith(side)).length, side).toBeGreaterThan(30);
    }
    // Drafters cut off mid-draft were picked up by the harness, and reported, rather than handed out again.
    expect(pickedUp).toBeGreaterThan(10);
  }, 900_000);
});

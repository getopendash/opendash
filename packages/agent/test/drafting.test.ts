// The Modeler leading a batch, offline: AI SDK's mock plays the lead and its drafters, everything else is
// real (the demo source, the gateway, the ledger, the drafts' tests). The lead hands four tables out in one step: the
// drafters run at the same time, three at most, each in its own run, each proposing into the lead's proposal and
// ending with its brief. A group handed out again is that drafter's result, not a second drafter. The proposal opens
// with every table's dataset, the lead's spend counts its drafters', and the trace nests each under its call, once.
// Then the lead's attempts ending under it: a shutdown hands the drafters off with the lead, and its next attempt
// finishes them before its model goes on, reporting each once (never read as a nudge to end, however many times it
// resumes); a drafter failing as it's picked up fails the attempt, saying so, after the others' reports are written;
// and a Stop on the lead stops its drafters.
import { getProposal, requestSourceDrafts, runSpent, settleProposal, traceFor, traceRun } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import { withSystemOn } from "@opendash/db/testing";
import { APICallError } from "ai";
import type { MockLanguageModelV4 } from "ai/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type AgentDeps, modeler, runAttempt } from "../src";
import { DATASETS, TABLES, tableIn } from "./helpers/drafting";
import { call, type Prompt, scripted, step } from "./helpers/scripted";

/** What the model was told in a call: its messages' text, the harness's notes among them. */
const told = (prompt: Prompt | undefined) =>
  (prompt ?? [])
    .flatMap((m) => (m.role !== "user" ? [] : m.content.flatMap((part) => (part.type === "text" ? [part.text] : []))))
    .join("\n");

let s: LearnedSource;
const as = () => ({ orgId: s.orgId, userId: s.userId });

beforeAll(async () => {
  s = await learnedSource();
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("the Modeler leading a batch", () => {
  it("hands tables to drafters running at once, three at most, and opens the proposal with every table's draft", async () => {
    const { proposalId } = await requestSourceDrafts(
      { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
      as(),
      { connectionId: s.connectionId, tables: TABLES },
    );
    const [p] = await s.t.owner<{ run_id: string }[]>`select run_id from app.proposal where id = ${proposalId}`;
    const leadId = p?.run_id as string;

    // Each drafter: proposes its table's dataset after a moment (so they overlap), then gives its brief.
    let active = 0;
    let most = 0;
    const drafters = new Map<string, MockLanguageModelV4>();
    const drafterModel = () =>
      scripted([
        async (prompt) => {
          active += 1;
          most = Math.max(most, active);
          await new Promise((r) => setTimeout(r, 400));
          const table = tableIn(prompt);
          return step(call("propose_definitions", { datasets: [{ yaml: DATASETS[table], why: "One row each." }] }));
        },
        (prompt) => {
          active -= 1;
          expect(JSON.stringify(prompt)).toContain('"yours"');
          return step(call("brief", { left_out: [] }));
        },
      ]).model;
    const lead = scripted([
      step(...TABLES.map((t) => call("draft_tables", { tables: [t] }))),
      (prompt) => {
        const results = prompt.flatMap((m) => (m.role === "tool" ? m.content : []));
        expect(results).toHaveLength(4);
        for (const r of results) expect(JSON.stringify(r)).toContain('"status":"done"');
        // Handed out again, a group is its drafter's result: no second drafter.
        return step(call("draft_tables", { tables: ["public.plans"] }));
      },
      (prompt) => {
        expect(JSON.stringify(prompt.at(-1))).toContain('"kept":["dataset plans"]');
        return step(call("finish_drafting", { left_out: [] }));
      },
    ]);
    const deps: AgentDeps = {
      withTenant: s.deps.withTenant,
      secrets: s.secrets,
      edition: "community",
      model: async ({ runId }) => {
        const model =
          runId === leadId ? lead.model : (drafters.get(runId) ?? drafters.set(runId, drafterModel()).get(runId));
        return {
          model: model as MockLanguageModelV4,
          provider: "opendash",
          route: "anthropic",
          providerOptions: {},
          keySource: "deployment",
        };
      },
    };

    expect(await runAttempt(deps, { orgId: s.orgId, runId: leadId }, { workerId: "t" }, modeler)).toEqual({
      status: "succeeded",
      outcome: "modeler",
    });
    // Three at once, and they did run together.
    expect(most).toBe(3);
    // The lead's instructions are the lead's: it hands out, the drafters propose.
    expect(lead.tools[0]).toContain("draft_tables");
    expect(lead.tools[0]).not.toContain("propose_definitions");

    const children = await s.t.owner<{ id: string; profile: string; status: string; task: { tables: string[] } }[]>`
      select id, profile, status, task from app.run where parent_run_id = ${leadId} order by queued_at`;
    expect(children).toHaveLength(4);
    for (const c of children) expect(c).toMatchObject({ profile: "drafter", status: "succeeded" });
    expect(children.map((c) => c.task.tables[0]).sort()).toEqual([...TABLES].sort());
    // The lead says when each drafter starts and ends, on its own stream: what the drafting card follows.
    // A group handed out again (its drafter done) starts nothing, so says nothing.
    const followed = await s.t.owner<{ type: string; data: { runId: string; status?: string; tables: string[] } }[]>`
      select type, data from app.run_event
      where run_id = ${leadId} and type in ('child_started', 'child_ended') order by seq`;
    for (const c of children) {
      expect(followed.filter((e) => e.data.runId === c.id).map((e) => e.type)).toEqual([
        "child_started",
        "child_ended",
      ]);
    }
    expect(followed.filter((e) => e.type === "child_ended").map((e) => e.data.status)).toEqual(
      Array(4).fill("succeeded"),
    );
    // A member sees the batch as its thread is seen: whoever asked for it, and the workspace's owners and admins. A
    // drafter is seen as its lead is.
    const asked = await traceFor(s.deps, { ...as(), manages: false }, leadId);
    expect(asked?.totals).toMatchObject({ helpers: 4 });
    expect(asked?.totals.modelCalls).toBeGreaterThan(4);
    const someone = { orgId: s.orgId, userId: uuidv7() };
    expect(await traceFor(s.deps, { ...someone, manages: false }, children[0]?.id as string)).toBeNull();
    expect((await traceFor(s.deps, { ...someone, manages: true }, children[0]?.id as string))?.trace.run).toMatchObject(
      { profile: "drafter" },
    );

    expect(await settleProposal(s.deps, s.orgId, leadId)).toBe("open");
    const view = await s.tenant((tx) => getProposal(tx, as(), proposalId));
    expect(view?.items.map((i) => i.slug).sort()).toEqual(["credits", "fx_rates", "plans", "refunds"]);

    // Its drafters' spend is the lead's (runs are priced 0 by the mock: give one a cost).
    await s.t
      .owner`update app.run set usage = usage || '{"costUsd": 0.25}'::jsonb where id = ${children[0]?.id as string}`;
    expect((await runSpent(s.deps, { orgId: s.orgId, id: leadId, attempt: 1 })).costUsd).toBeGreaterThanOrEqual(0.25);

    // The trace nests each drafter under the call that gave it its tables, read from the call's message: a call cut
    // off before its row was written has none of its input there.
    await s.t.owner`
      update app.tool_call set args = '{}'::jsonb
      where run_id = ${leadId} and tool = 'draft_tables' and args->'tables' = '["billing.refunds"]'::jsonb`;
    const trace = await withSystemOn(s.t.system, (tx) => traceRun(tx, leadId));
    const handed = trace?.steps[0]?.calls ?? [];
    expect(handed.map((c) => c.tool)).toEqual(Array(4).fill("draft_tables"));
    for (const c of handed) {
      expect(c.child?.run).toMatchObject({ profile: "drafter", status: "succeeded" });
      expect(c.child?.steps.flatMap((st) => st.calls.map((x) => x.tool))).toEqual(["propose_definitions", "brief"]);
    }
    // Handed out again, the same drafter is named, not traced (and counted) a second time.
    const again = trace?.steps[1]?.calls[0];
    const plans = children.find((c) => c.task.tables[0] === "public.plans")?.id;
    expect(again).toMatchObject({ tool: "draft_tables", reusedChild: plans });
    expect(again?.child).toBeUndefined();
    await s.t.owner`update app.proposal set status = 'rejected' where id = ${proposalId}`;
    await s.t.owner`
      update app.context_item set deleted_at = now() where connection_id = ${s.connectionId} and deleted_at is null`;
  });

  /** A batch of these tables, drafting from a source with no definitions: its proposal and its lead. */
  async function batchOf(tables: string[]) {
    await s.t.owner`
      update app.context_item set deleted_at = now() where connection_id = ${s.connectionId} and deleted_at is null`;
    const { proposalId } = await requestSourceDrafts(
      { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
      as(),
      { connectionId: s.connectionId, tables },
    );
    const [p] = await s.t.owner<{ run_id: string }[]>`select run_id from app.proposal where id = ${proposalId}`;
    return { proposalId, leadId: p?.run_id as string, job: { orgId: s.orgId, runId: p?.run_id as string } };
  }

  /** The lead's scripted model, and each drafter's, made from its table the first time its model is asked for. */
  function scriptedDeps(leadId: string, lead: MockLanguageModelV4, drafterFor: (table: string) => MockLanguageModelV4) {
    const drafters = new Map<string, MockLanguageModelV4>();
    const modelOf = async (runId: string) => {
      const found = drafters.get(runId);
      if (found) return found;
      const [b] = await s.t.owner<{ text: string }[]>`
        select m.text from app.run r join app.message m on m.id = r.input_message_id where r.id = ${runId}`;
      const model = drafterFor(tableIn([{ role: "user", content: [{ type: "text", text: b?.text ?? "" }] }]));
      drafters.set(runId, model);
      return model;
    };
    const deps: AgentDeps = {
      withTenant: s.deps.withTenant,
      secrets: s.secrets,
      edition: "community",
      // A busy model here stands for an attempt that ends: no waiting it out.
      busyWaitsMs: [],
      model: async ({ runId }) => ({
        model: runId === leadId ? lead : await modelOf(runId),
        provider: "opendash",
        route: "anthropic",
        providerOptions: {},
        keySource: "deployment",
      }),
    };
    return deps;
  }

  const proposes = (prompt: Prompt) =>
    step(call("propose_definitions", { datasets: [{ yaml: DATASETS[tableIn(prompt)], why: "One row each." }] }));
  const briefs =
    (leftOut: { name: string; reason: string }[] = []) =>
    () =>
      step(call("brief", { left_out: leftOut }));
  /** The lead's notes from OpenDash that report picked-up work, in order. */
  const reports = (leadId: string) =>
    s.t.owner<{ text: string }[]>`
      select text from app.message where run_id = ${leadId} and role = 'system_note' and kind = 'report' order by seq`;
  const tablesIn = (notes: { text: string }[]) => notes.map((n) => n.text.match(/"tables":\["([^"]+)"\]/)?.[1]);

  it("hands its drafters off with it when the worker shuts down, and finishes them before its model goes on", async () => {
    const batch = ["public.plans", "billing.credits", "billing.refunds"];
    const { proposalId, leadId, job } = await batchOf(batch);
    const drain = new AbortController();
    // Each drafter proposes its table's dataset as the worker starts shutting down, then gives its brief.
    const lead = scripted([
      step(...batch.map((t) => call("draft_tables", { tables: [t] }))),
      step(call("finish_drafting", { left_out: [] })),
    ]);
    const deps = scriptedDeps(
      leadId,
      lead.model,
      () =>
        scripted([
          (prompt) => {
            drain.abort();
            return proposes(prompt);
          },
          briefs(),
        ]).model,
    );
    expect(await runAttempt(deps, job, { workerId: "w1", drain: drain.signal }, modeler)).toEqual({
      status: "handed_off",
    });
    const handedOff = await s.t.owner<{ status: string }[]>`
      select c.result->>'status' as status from app.tool_call c where c.run_id = ${leadId} and c.tool = 'draft_tables'`;
    expect(handedOff.map((c) => c.status)).toEqual(["unfinished", "unfinished", "unfinished"]);

    // Its next attempt: the harness finishes each drafter first, and the model reads how each ended in a report.
    expect(await runAttempt(deps, job, { workerId: "w2" }, modeler)).toEqual({
      status: "succeeded",
      outcome: "modeler",
    });
    const note = told(lead.prompts[1]);
    expect(note).toContain("Work under way when the run restarted");
    for (const t of batch) expect(note).toContain(`{"tables":["${t}"],"status":"done"`);
    // The model was called once per attempt: it never handed a table out again.
    expect(lead.prompts).toHaveLength(2);
    const children = await s.t.owner<{ status: string; attempt: number }[]>`
      select status, attempt from app.run where parent_run_id = ${leadId}`;
    expect(children).toEqual(Array(3).fill({ status: "succeeded", attempt: 2 }));
    expect(await settleProposal(s.deps, s.orgId, leadId)).toBe("open");
    const view = await s.tenant((tx) => getProposal(tx, as(), proposalId));
    expect(view?.items.map((i) => i.slug).sort()).toEqual(["credits", "plans", "refunds"]);
  });

  it("goes on handing tables out however many times it resumes: a report of picked-up work never ends it", async () => {
    const batch = ["public.plans", "billing.credits", "billing.refunds"];
    const { proposalId, leadId, job } = await batchOf(batch);
    let drain = new AbortController();
    // The first two drafters each start the worker shutting down as they propose; the third drafts in peace.
    const lead = scripted([
      ...batch.map((t) => step(call("draft_tables", { tables: [t] }))),
      step(call("finish_drafting", { left_out: [] })),
    ]);
    const deps = scriptedDeps(
      leadId,
      lead.model,
      (table) =>
        scripted([
          (prompt) => {
            if (table !== "billing.refunds") drain.abort();
            return proposes(prompt);
          },
          briefs(),
        ]).model,
    );
    expect(await runAttempt(deps, job, { workerId: "w1", drain: drain.signal }, modeler)).toEqual({
      status: "handed_off",
    });
    drain = new AbortController();
    expect(await runAttempt(deps, job, { workerId: "w2", drain: drain.signal }, modeler)).toEqual({
      status: "handed_off",
    });
    // Its third attempt, after a report: it isn't wrapping up, so the last table is handed out and drafted.
    expect(await runAttempt(deps, job, { workerId: "w3" }, modeler)).toEqual({
      status: "succeeded",
      outcome: "modeler",
    });
    const [last] = await s.t.owner<{ status: string }[]>`
      select result->>'status' as status from app.tool_call
      where run_id = ${leadId} and tool = 'draft_tables' and args->'tables' = '["billing.refunds"]'::jsonb`;
    expect(last?.status).toBe("done");
    expect(tablesIn(await reports(leadId))).toEqual(["public.plans", "billing.credits"]);
    const nudges = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.message where run_id = ${leadId} and role = 'system_note' and kind <> 'report'`;
    expect(nudges[0]?.n).toBe(0);
    expect(await settleProposal(s.deps, s.orgId, leadId)).toBe("open");
    const view = await s.tenant((tx) => getProposal(tx, as(), proposalId));
    expect(view?.items.map((i) => i.slug).sort()).toEqual(["credits", "plans", "refunds"]);
  });

  it("fails the lead's attempt, saying so, when a drafter it picks up fails, after the others' reports", async () => {
    const batch = ["public.plans", "billing.credits", "billing.refunds"];
    const { proposalId, leadId, job } = await batchOf(batch);
    const drain = new AbortController();
    const proposing = (prompt: Prompt) => {
      drain.abort();
      return proposes(prompt);
    };
    // The refunds drafter's model is busy the first time the lead picks it up; the credits drafter leaves a column out.
    const busy = () => {
      throw new APICallError({
        message: "Overloaded",
        url: "https://api.anthropic.com/v1/messages",
        requestBodyValues: {},
        statusCode: 529,
        isRetryable: false,
      });
    };
    const skipped = { name: "billing.credits.note", reason: "Free text, not something to group by." };
    const lead = scripted([
      step(...batch.map((t) => call("draft_tables", { tables: [t] }))),
      step(call("finish_drafting", { left_out: [] })),
    ]);
    const deps = scriptedDeps(
      leadId,
      lead.model,
      (table) =>
        scripted(
          table === "billing.refunds"
            ? [proposing, busy, briefs()]
            : [proposing, briefs(table === "billing.credits" ? [skipped] : [])],
        ).model,
    );
    expect(await runAttempt(deps, job, { workerId: "w1", drain: drain.signal }, modeler)).toEqual({
      status: "handed_off",
    });
    await expect(runAttempt(deps, job, { workerId: "w2" }, modeler)).rejects.toThrow(/picking up its work/);
    const [end] = await s.t.owner<{ reason: string }[]>`
      select data->>'reason' as reason from app.run_event
      where run_id = ${leadId} and attempt = 2 and type = 'attempt_ended'`;
    expect(end?.reason).toBe("error");
    // The two that finished were reported as each ended, before the attempt failed; the model wasn't asked meanwhile.
    expect(tablesIn(await reports(leadId)).sort()).toEqual(["billing.credits", "public.plans"]);
    expect(lead.prompts).toHaveLength(1);
    // The next attempt picks up only what's still owed, reports it, and goes on: each report written once.
    expect(await runAttempt(deps, job, { workerId: "w3" }, modeler)).toEqual({
      status: "succeeded",
      outcome: "modeler",
    });
    expect(told(lead.prompts[1])).toContain(`{"tables":["billing.refunds"],"status":"done"`);
    expect(tablesIn(await reports(leadId)).sort()).toEqual(["billing.credits", "billing.refunds", "public.plans"]);
    const children = await s.t.owner<{ tables: string; status: string; attempt: number }[]>`
      select task->>'tables' as tables, status, attempt from app.run where parent_run_id = ${leadId} order by 1`;
    expect(children).toEqual([
      { tables: '["billing.credits"]', status: "succeeded", attempt: 2 },
      { tables: '["billing.refunds"]', status: "succeeded", attempt: 3 },
      { tables: '["public.plans"]', status: "succeeded", attempt: 2 },
    ]);
    // What a drafter left out is the batch's, though the lead named nothing.
    const [run] = await s.t.owner<
      { left: { name: string }[] }[]
    >`select outcome->'leftOut' as left from app.run where id = ${leadId}`;
    expect(run?.left.map((l) => l.name)).toEqual([skipped.name]);
    expect(await settleProposal(s.deps, s.orgId, leadId)).toBe("open");
    await s.t.owner`update app.proposal set status = 'rejected' where id = ${proposalId}`;
  });

  it("stops its drafters when it's stopped: each at its next step", async () => {
    const { proposalId, leadId, job } = await batchOf(["public.plans", "billing.credits", "billing.refunds"]);
    const lead = scripted([step(call("draft_tables", { tables: ["public.plans"] }))]);
    const drafter = scripted([
      async (prompt) => {
        // Someone presses Stop on the batch while its drafter works.
        await s.t.owner`update app.run set status = 'cancelling', cancel_requested_at = now() where id = ${leadId}`;
        return proposes(prompt);
      },
      briefs(),
    ]);
    const deps = scriptedDeps(leadId, lead.model, () => drafter.model);
    expect(await runAttempt(deps, job, { workerId: "w1" }, modeler)).toMatchObject({ status: "cancelled" });
    const [child] = await s.t.owner<{ status: string }[]>`select status from app.run where parent_run_id = ${leadId}`;
    expect(child?.status).toBe("cancelled");
    expect(drafter.prompts).toHaveLength(1);
    await s.t.owner`update app.proposal set status = 'rejected' where id = ${proposalId}`;
  });
});

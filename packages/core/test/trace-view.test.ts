// The run trace in the product: a run is seen as its conversation is, a run given its asker's memory shows
// another reader its structure only, background work is its owners' and admins', and Activity lists background work
// and the conversations its reader can read, never someone else's private one.
import { type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { recentRuns, shareThread, submitQuestion, traceFor, traceTotals } from "../src";

let t: TestDatabase;
const orgId = uuidv7();
const connectionId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const deps = {
  withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
  boss: null,
};
const ask = (userId: string, text: string) =>
  submitQuestion(deps, { orgId, userId, connectionId, text, channel: "web", model: "claude-haiku-4-5" });
const member = (userId: string, manages = false) => ({ orgId, userId, manages });

/** An answered run: one model call that ran one query, with its usage and times. */
async function answered(runId: string, threadId: string) {
  const callId = `call-${uuidv7()}`;
  await t.owner`update app.run set status = 'succeeded', finished_at = now(),
    attempts = ${t.owner.json([{ attempt: 1, started: new Date(Date.now() - 9_000).toISOString(), ended: new Date().toISOString(), reason: "succeeded" }])},
    attempt = 1 where id = ${runId}`;
  await t.owner`insert into app.message (org_id, id, thread_id, run_id, seq, role, model, usage, content, text)
    values (${orgId}, ${uuidv7()}, ${threadId}, ${runId}, 50, 'assistant', 'claude-haiku-4-5',
      ${t.owner.json({ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 600 })},
      ${t.owner.json({ content: [{ type: "tool-call", toolCallId: callId, toolName: "sql_query", input: { title: "Churn by plan" } }] })},
      '')`;
  await t.owner`insert into app.tool_call (org_id, id, run_id, attempt, call_id, tool, status, args, result, started_at, finished_at)
    values (${orgId}, ${uuidv7()}, ${runId}, 1, ${callId}, 'sql_query', 'succeeded', ${t.owner.json({ title: "Churn by plan" })},
      ${t.owner.json({ error: "a private detail" })}, now() - interval '5 seconds', now() - interval '4 seconds')`;
}

let mine: { threadId: string; runId: string };
let shared: { threadId: string; runId: string };
let batch: { threadId: string; runId: string };

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Traces");
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connectionId}, 'src', 'postgres')`;
  mine = await ask(alice, "Why did churn drop?");
  await answered(mine.runId, mine.threadId);
  shared = await ask(alice, "MRR by plan");
  await answered(shared.runId, shared.threadId);
  await shareThread(deps, { orgId, userId: alice }, shared.threadId, "org");
  // Background work: a drafting batch nobody asked for by hand.
  batch = { threadId: uuidv7(), runId: uuidv7() };
  await t.owner`insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${orgId}, ${batch.threadId}, ${connectionId}, null, 'Drafting 8 tables', 'modeler', 'private')`;
  await t.owner`insert into app.run (org_id, id, thread_id, connection_id, profile, model, status, trigger)
    values (${orgId}, ${batch.runId}, ${batch.threadId}, ${connectionId}, 'modeler', 'claude-haiku-4-5', 'running', 'user')`;
});

afterAll(async () => {
  await t?.drop();
});

describe("a run's trace", () => {
  it("is its asker's, with its totals; not another member's while the conversation is private", async () => {
    const view = await traceFor(deps, member(alice), mine.runId);
    expect(view).toMatchObject({ title: "Why did churn drop?", redacted: false });
    expect(view?.totals).toMatchObject({ modelCalls: 1, inputTokens: 1200, cachedInputTokens: 600, outputTokens: 80 });
    expect(view?.totals.ms).toBeGreaterThanOrEqual(8_000);
    const call = view?.trace.steps[0]?.calls[0];
    expect(call).toMatchObject({ tool: "sql_query", error: "a private detail" });
    expect(call?.startedAt && call.finishedAt && Date.parse(call.finishedAt) > Date.parse(call.startedAt)).toBe(true);
    expect(await traceFor(deps, member(bob), mine.runId)).toBeNull();
    // Running the workspace isn't reading someone's private conversation.
    expect(await traceFor(deps, member(bob, true), mine.runId)).toBeNull();
  });

  it("is a shared conversation's readers', in full, or its structure only when it was given its asker's memory", async () => {
    // Recorded as given none of its asker's memory: in full.
    await t.owner`update app.run set prompt = ${t.owner.json({ memories: 0 })} where id = ${shared.runId}`;
    expect((await traceFor(deps, member(bob), shared.runId))?.redacted).toBe(false);
    await t.owner`update app.run set prompt = ${t.owner.json({ memories: 2 })} where id = ${shared.runId}`;
    const read = await traceFor(deps, member(bob), shared.runId);
    expect(read?.redacted).toBe(true);
    expect(read?.trace.steps[0]?.calls[0]).toEqual(expect.not.objectContaining({ error: expect.anything() }));
    expect(read?.trace.prompt).toBeNull();
    // Its asker still sees it all.
    expect((await traceFor(deps, member(alice), shared.runId))?.redacted).toBe(false);
  });

  it("is background work's for its owners and admins only", async () => {
    expect(await traceFor(deps, member(bob), batch.runId)).toBeNull();
    expect((await traceFor(deps, member(bob, true), batch.runId))?.trace.run).toMatchObject({ profile: "modeler" });
    expect(await traceFor(deps, member(alice, true), "not-a-run")).toBeNull();
  });

  it("names the attempt under way, with its start, and gives every time as ISO text", async () => {
    await t.owner`update app.run set attempt = 1, attempt_started_at = now() - interval '3 seconds' where id = ${batch.runId}`;
    const view = await traceFor(deps, member(bob, true), batch.runId);
    expect(view?.trace.attempts).toEqual([{ attempt: 1, started: expect.any(String), reason: "under way" }]);
    expect(view?.trace.run.queuedAt).toMatch(/\.\d{3}Z$/);
    const step = (await traceFor(deps, member(alice), mine.runId))?.trace.steps[0];
    expect(step?.at).toMatch(/\.\d{3}Z$/);
  });

  it("shows another reader structure only when nothing says whether its asker's memory went in", async () => {
    await t.owner`update app.run set prompt = null where id = ${shared.runId}`;
    expect((await traceFor(deps, member(bob), shared.runId))?.redacted).toBe(true);
    await t.owner`update app.run set prompt = ${t.owner.json({ memories: 0 })} where id = ${shared.runId}`;
    expect((await traceFor(deps, member(bob), shared.runId))?.redacted).toBe(false);
  });

  it("adds up a run while it works from its first attempt to now", () => {
    const now = Date.parse("2026-10-16T10:00:10.000Z");
    const totals = traceTotals(
      {
        run: { queuedAt: "2026-10-16T10:00:00.000Z", finishedAt: null } as never,
        attempts: [{ attempt: 1, started: "2026-10-16T10:00:02.000Z", reason: "" }],
        prompt: null,
        steps: [],
        followUps: [],
      },
      now,
    );
    expect(totals.ms).toBe(8_000);
  });
});

describe("Activity", () => {
  it("lists background work and the conversations its reader can read, never someone else's private one", async () => {
    const runs = await recentRuns(deps, member(bob, true));
    expect(runs.map((r) => [r.title, r.background])).toEqual([
      ["Drafting 8 tables", true],
      ["MRR by plan", false],
    ]);
    expect(runs[1]).toMatchObject({ askedBy: alice, status: "succeeded", helpers: 0 });
    expect(await recentRuns(deps, member(bob, false))).toEqual([]);
    expect((await recentRuns(deps, member(alice, true), { background: true })).map((r) => r.title)).toEqual([
      "Drafting 8 tables",
    ]);
  });
});

// Background work one person owns is theirs alone.
describe("someone's private background work", () => {
  /** A run in a background thread of its own, owned as the product makes it: by its person, or nobody's. */
  async function backgroundRun(channel: "routine" | "insight", owner: string | null, title: string) {
    const threadId = uuidv7();
    const runId = uuidv7();
    await t.owner`insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
      values (${orgId}, ${threadId}, ${connectionId}, ${owner}, ${title}, ${channel}, 'private')`;
    await t.owner`insert into app.run (org_id, id, thread_id, connection_id, profile, model, status, trigger)
      values (${orgId}, ${runId}, ${threadId}, ${connectionId}, 'analyst', 'claude-haiku-4-5', 'succeeded', 'routine')`;
    return runId;
  }

  it("is read by its owner only: not owners and admins, nor an org API key", async () => {
    // Bob's private routine's question, his private finding's investigation, his Describe it draft.
    const routined = await backgroundRun("routine", bob, "Bob's private question");
    const investigated = await backgroundRun("insight", bob, "Why did Bob's metric move?");
    const described = await backgroundRun("routine", bob, "Describe it");
    // The workspace's own: a shared routine's run, nobody's.
    const shared = await backgroundRun("routine", null, "The team's question");

    for (const runId of [routined, investigated, described]) {
      expect(await traceFor(deps, member(bob), runId)).not.toBeNull();
      expect(await traceFor(deps, member(alice, true), runId)).toBeNull();
      expect(await traceFor(deps, { orgId, userId: null, manages: false }, runId)).toBeNull();
    }
    expect(await traceFor(deps, member(alice, true), shared)).not.toBeNull();
    const listed = (await recentRuns(deps, member(alice, true))).map((r) => r.runId);
    expect(listed).not.toContain(routined);
    expect(listed).not.toContain(investigated);
    expect(listed).not.toContain(described);
    expect(listed).toContain(shared);
    expect(listed).toContain(batch.runId);
  });
});

// The run ledger against a real database: submit, one active run per thread, claim and takeover fencing, the
// tool-call ledger (exactly once), transcript rebuild with an interrupted call, aliases, finalize and dead letters.
import { createListener, type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  answerAbout,
  appendNote,
  assignAlias,
  childRun,
  claimRun,
  commitAssistantMessage,
  createBoss,
  dropUnusedPrompts,
  FenceLost,
  failRunFromQueue,
  finalizeRun,
  finishToolCall,
  getQueryCard,
  getRun,
  getThread,
  hasAsked,
  installQueues,
  listThreads,
  NotFound,
  NotYours,
  RUN_EVENTS_CHANNEL,
  RunActive,
  rebuildTranscript,
  recordAttemptEnd,
  recordContext,
  recordPrompt,
  requestStop,
  runEvents,
  runSpent,
  shareThread,
  startToolCall,
  stopRequested,
  submitQuestion,
  usageSummary,
} from "../src";

let t: TestDatabase;
const orgId = uuidv7();
const connectionId = uuidv7();
const deps = {
  withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
  boss: null,
};
const ask = (text: string, extra: { threadId?: string; clientMsgId?: string } = {}) =>
  submitQuestion(deps, { orgId, userId: null, connectionId, text, channel: "eval", model: "test-model", ...extra });

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Ledger");
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connectionId}, 'src', 'postgres')`;
});

afterAll(async () => {
  await t?.drop();
});

/** Makes someone a member of the ledger's org, as Better Auth does: only a member's question is answered. */
async function joins(userId: string, role = "member"): Promise<void> {
  await t.auth.client`insert into auth.user (id, name, email, email_verified)
    values (${userId}, 'Asker', ${`asker-${userId}@acme.test`}, true)`;
  await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${userId}, ${role}, now())`;
}

const toolCallPart = (id: string, tool = "value_lookup") => ({
  type: "tool-call",
  toolCallId: id,
  toolName: tool,
  input: { term: "x" },
});
const usage = { inputTokens: 100, outputTokens: 20 };

describe("a follow-up from another source", () => {
  it("starts from the source it names, goes on from there, and refuses one that's gone without changing anything", async () => {
    const other = uuidv7();
    await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${other}, 'support', 'clickhouse')`;
    const first = await ask("On the first source?");
    await t.owner`update app.run set status = 'succeeded' where id = ${first.runId}`;
    const switched = await submitQuestion(deps, {
      orgId,
      userId: null,
      threadId: first.threadId,
      connectionId: other,
      text: "And tickets?",
      channel: "eval",
      model: "test-model",
    });
    const sources = async () =>
      t.owner<{ thread: string; run: string | null; id: string }[]>`
        select t.connection_id as thread, r.connection_id as run, r.id from app.run r
        join app.thread t on t.org_id = r.org_id and t.id = r.thread_id
        where r.thread_id = ${first.threadId} order by r.queued_at`;
    expect((await sources()).map((x) => [x.thread, x.run])).toEqual([
      [other, connectionId],
      [other, other],
    ]);
    // An answer's PDF names the source it was answered from, not where the conversation went since.
    const answeredFrom = async (runId: string) =>
      (await deps.withTenant(orgId, (tx) => answerAbout(tx, orgId, runId)))?.sourceName;
    expect(await answeredFrom(first.runId)).toBe("src");
    expect(await answeredFrom(switched.runId)).toBe("support");
    const claimed = await claimRun(deps, { orgId, runId: switched.runId }, "w1");
    expect(claimed?.connectionId).toBe(other);
    await t.owner`update app.run set status = 'succeeded' where id = ${switched.runId}`;
    // Naming none, it goes on from where the conversation is.
    const next = await submitQuestion(deps, {
      orgId,
      userId: null,
      threadId: first.threadId,
      text: "And last week?",
      channel: "eval",
      model: "test-model",
    });
    expect((await claimRun(deps, { orgId, runId: next.runId }, "w1"))?.connectionId).toBe(other);
    await t.owner`update app.run set status = 'succeeded' where id = ${next.runId}`;
    // A run from before runs had their own source starts from its thread's.
    await t.owner`update app.run set connection_id = null, status = 'queued' where id = ${next.runId}`;
    expect((await claimRun(deps, { orgId, runId: next.runId }, "w2"))?.connectionId).toBe(other);
    await t.owner`update app.run set status = 'succeeded' where id = ${next.runId}`;
    // A source that's gone is refused, and the conversation stays where it was.
    await expect(
      submitQuestion(deps, {
        orgId,
        userId: null,
        threadId: first.threadId,
        connectionId: uuidv7(),
        text: "Elsewhere?",
        channel: "eval",
        model: "test-model",
      }),
    ).rejects.toThrow(/doesn't exist, was removed/);
    expect((await sources()).map((x) => x.thread)).toEqual([other, other, other]);
    // One that failed its last check, or across the line between sample data and the organization's own, too.
    const failing = uuidv7();
    const sample = uuidv7();
    await t.owner`insert into app.connection (org_id, id, name, dialect, status) values (${orgId}, ${failing}, 'failing', 'postgres', 'error')`;
    await t.owner`insert into app.connection (org_id, id, name, dialect, config) values (${orgId}, ${sample}, 'demo', 'postgres', ${t.owner.json({ sample: true })})`;
    const follow = (id: string) =>
      submitQuestion(deps, {
        orgId,
        userId: null,
        threadId: first.threadId,
        connectionId: id,
        text: "Elsewhere?",
        channel: "eval",
        model: "test-model",
      });
    await expect(follow(failing)).rejects.toThrow(/failed its last check/);
    await expect(follow(sample)).rejects.toThrow(/sample data in a new conversation/);
    expect((await sources()).map((x) => x.thread)).toEqual([other, other, other]);
  });
});

describe("submit", () => {
  it("writes the thread, the user message and a queued run together", async () => {
    const r = await ask("How did MRR change last month?");
    const [run] = await t.owner<{ status: string; attempt: number; input_message_id: string }[]>`
      select status, attempt, input_message_id from app.run where id = ${r.runId}`;
    expect(run).toEqual({ status: "queued", attempt: 0, input_message_id: r.messageId });
    const [msg] = await t.owner<{ seq: number; role: string; text: string }[]>`
      select seq, role, text from app.message where id = ${r.messageId}`;
    expect(msg).toEqual({ seq: 1, role: "user", text: "How did MRR change last month?" });
  });

  it("allows one active run per thread, and a repeated client message id is the same submit", async () => {
    const first = await ask("First?", { clientMsgId: "c-1" });
    await expect(ask("Second?", { threadId: first.threadId })).rejects.toBeInstanceOf(RunActive);
    const again = await ask("First?", { threadId: first.threadId, clientMsgId: "c-1" });
    expect(again.runId).toBe(first.runId);
  });
});

describe("who can see a conversation", () => {
  it("lets only the creator read a private thread; once shared, anyone in the org reads it, still only the creator continues", async () => {
    const alice = uuidv7();
    const bob = uuidv7();
    const mine = await submitQuestion(deps, {
      orgId,
      userId: alice,
      connectionId,
      text: "Private?",
      channel: "web",
      model: "m",
    });
    const asBob = { orgId, userId: bob };
    expect(await getRun(deps, asBob, mine.runId)).toBeNull();
    expect(await runEvents(deps, asBob, mine.runId)).toEqual([]);
    expect(await getRun(deps, { orgId, userId: alice }, mine.runId)).not.toBeNull();
    await t.owner`update app.run set status = 'succeeded' where id = ${mine.runId}`;
    const follow = {
      orgId,
      userId: bob,
      connectionId,
      threadId: mine.threadId,
      text: "Me too?",
      channel: "web",
      model: "m",
    } as const;
    await expect(submitQuestion(deps, follow)).rejects.toBeInstanceOf(NotFound);
    await t.owner`update app.thread set visibility = 'org' where id = ${mine.threadId}`;
    expect(await getRun(deps, asBob, mine.runId)).not.toBeNull();
    await expect(submitQuestion(deps, follow)).rejects.toBeInstanceOf(NotYours);
  });

  it("won't start a conversation about a removed source", async () => {
    const gone = uuidv7();
    await t.owner`
      insert into app.connection (org_id, id, name, dialect, deleted_at) values (${orgId}, ${gone}, 'gone', 'postgres', now())`;
    await expect(
      submitQuestion(deps, { orgId, userId: null, connectionId: gone, text: "Hi?", channel: "eval", model: "m" }),
    ).rejects.toBeInstanceOf(NotFound);
  });
});

describe("reading conversations (Ask)", () => {
  const carol = uuidv7();
  const dave = uuidv7();
  const askAs = (userId: string, text: string, threadId?: string) =>
    submitQuestion(deps, {
      orgId,
      userId,
      connectionId,
      text,
      channel: "web",
      model: "m",
      ...(threadId ? { threadId } : {}),
    });

  it("lists the viewer's threads and shared ones, newest first, with how each stands", async () => {
    const first = await askAs(carol, "Carol's first?");
    await t.owner`update app.run set status = 'succeeded', outcome = ${t.owner.json({ kind: "answer", status: "answered" })} where id = ${first.runId}`;
    const second = await askAs(carol, "Carol's second?");
    const theirs = await askAs(dave, "Dave's?");
    const list = await listThreads(deps, { orgId, userId: carol });
    const ids = list.map((x) => x.id);
    expect(ids.indexOf(second.threadId)).toBeLessThan(ids.indexOf(first.threadId));
    expect(ids).not.toContain(theirs.threadId);
    expect(list.find((x) => x.id === first.threadId)).toMatchObject({
      sourceName: "src",
      sourceUsable: true,
      mine: true,
      latest: { status: "succeeded", outcome: "answer", answer: "answered" },
    });
    expect(list.find((x) => x.id === second.threadId)?.latest).toMatchObject({ status: "queued", outcome: null });
  });

  it("knows whether someone has asked a question here yet", async () => {
    const erin = uuidv7();
    const asked = (userId: string) => deps.withTenant(orgId, (tx) => hasAsked(tx, { orgId, userId }));
    expect(await asked(erin)).toBe(false);
    await askAs(erin, "Erin's first?");
    expect(await asked(erin)).toBe(true);
    // Asking in one org says nothing about another.
    expect(await deps.withTenant(orgId, (tx) => hasAsked(tx, { orgId: uuidv7(), userId: erin }))).toBe(false);
  });

  it("shares a conversation with the org for reading; only its author adds to it, stops it or unshares it", async () => {
    const q = await askAs(carol, "Shared?");
    const list = async (who: string) => (await listThreads(deps, { orgId, userId: who })).map((x) => x.id);
    expect(await list(dave)).not.toContain(q.threadId);
    expect(await shareThread(deps, { orgId, userId: dave }, q.threadId, "org")).toBe(false);
    expect(await shareThread(deps, { orgId, userId: carol }, q.threadId, "org")).toBe(true);
    expect(await list(dave)).toContain(q.threadId);
    expect((await listThreads(deps, { orgId, userId: dave })).find((x) => x.id === q.threadId)).toMatchObject({
      visibility: "org",
      mine: false,
    });
    expect(await getThread(deps, { orgId, userId: dave }, q.threadId)).not.toBeNull();
    // Dave reads; he doesn't drive it.
    expect(await requestStop(deps, { orgId, userId: dave }, q.runId)).toBe(false);
    await t.owner`update app.run set status = 'succeeded' where id = ${q.runId}`;
    await expect(askAs(dave, "Can I add?", q.threadId)).rejects.toBeInstanceOf(NotYours);
    expect(await shareThread(deps, { orgId, userId: carol }, q.threadId, "private")).toBe(true);
    expect(await list(dave)).not.toContain(q.threadId);
  });

  it("reads a thread's turns, each question with the run that answered it", async () => {
    const q = await askAs(carol, "Turns?");
    await t.owner`update app.run set status = 'succeeded' where id = ${q.runId}`;
    const follow = await askAs(carol, "And then?", q.threadId);
    const thread = await getThread(deps, { orgId, userId: carol }, q.threadId);
    expect(thread?.turns.map((x) => [x.message.text, x.run?.id])).toEqual([
      ["Turns?", q.runId],
      ["And then?", follow.runId],
    ]);
    expect(await getThread(deps, { orgId, userId: dave }, q.threadId)).toBeNull();
    expect(await getThread(deps, { orgId, userId: carol }, "nope")).toBeNull();
  });

  it("shows a query card only to someone who can see the run that asked for it", async () => {
    const q = await askAs(carol, "Card?");
    const queryRunId = uuidv7();
    await t.owner`
      insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, alias, mode, path, engine,
        title, compiled_sql, sql_hash, status, rows, truncated, sanity, result_schema, preview, created_at)
      values (${queryRunId}, ${orgId}, ${connectionId}, 'run', ${q.runId}, 'q1', 'execute', 'raw_sql', 'agent_sql',
        'MRR', 'select 1', 'h', 'succeeded', 1, false,
        ${t.owner.json([
          { check: "zero_rows", status: "pass" },
          { check: "partial_period", status: "warn", message: "October isn't over yet." },
          { check: "truncated", status: "warn", message: "Only the first 1,000 rows." },
        ])},
        ${t.owner.json([{ name: "mrr", type: "number" }])}, ${t.owner.json([[412600]])}, now())`;
    // Its checks' warnings come with it, but a truncated result says so on its own line.
    expect(await getQueryCard(deps, { orgId, userId: carol }, queryRunId)).toMatchObject({
      alias: "q1",
      title: "MRR",
      sql: "select 1",
      columns: [{ name: "mrr", type: "number" }],
      preview: [[412600]],
      warnings: ["October isn't over yet."],
    });
    expect(await getQueryCard(deps, { orgId, userId: dave }, queryRunId)).toBeNull();
  });

  it("stops a run: a queued one is cancelled at once, a running one is asked to stop at its next step", async () => {
    await joins(carol);
    const queued = await askAs(carol, "Stop me?");
    expect(await requestStop(deps, { orgId, userId: dave }, queued.runId)).toBe(false);
    expect(await requestStop(deps, { orgId, userId: carol }, queued.runId)).toBe(true);
    expect(await getRun(deps, { orgId, userId: carol }, queued.runId)).toMatchObject({
      status: "cancelled",
      outcome: { kind: "no_answer", reason: "Stopped." },
    });
    const running = await askAs(carol, "Stop me later?");
    const claimed = await claimRun(deps, { orgId, runId: running.runId }, "w");
    if (!claimed) throw new Error("not claimed");
    expect(await stopRequested(deps, claimed)).toBe(false);
    expect(await requestStop(deps, { orgId, userId: carol }, running.runId)).toBe(true);
    expect(await stopRequested(deps, claimed)).toBe(true);
    expect((await getRun(deps, { orgId, userId: carol }, running.runId))?.status).toBe("cancelling");
    expect(await requestStop(deps, { orgId, userId: carol }, running.runId)).toBe(false);
  });

  it("won't follow up on a thread whose source was disabled", async () => {
    const q = await askAs(carol, "Before disabling?");
    await t.owner`update app.run set status = 'succeeded' where id = ${q.runId}`;
    await t.owner`update app.connection set status = 'disabled' where id = ${connectionId}`;
    await expect(askAs(carol, "After?", q.threadId)).rejects.toThrow(/removed or disabled/);
    await t.owner`update app.connection set status = 'ok' where id = ${connectionId}`;
  });
});

describe("a question whose asker may no longer ask", () => {
  async function memberOf(role: string): Promise<string> {
    const userId = uuidv7();
    await joins(userId, role);
    return userId;
  }
  const asks = (userId: string, channel: "web" | "slack", canTryDrafts = false) =>
    submitQuestion(deps, { orgId, userId, connectionId, text: "MRR?", channel, model: "test-model", canTryDrafts });
  const outcome = async (runId: string) =>
    (
      await t.owner<{ status: string; reason: string | null }[]>`
      select status, outcome->>'reason' as reason from app.run where id = ${runId}`
    )[0];

  it("ends unanswered once its asker left, or can only read, and answers one who still may", async () => {
    const stays = await memberOf("member");
    const kept = await asks(stays, "web");
    expect((await claimRun(deps, { orgId, runId: kept.runId }, "w"))?.askedBy).toBe(stays);

    const leaves = await memberOf("member");
    const fromSlack = await asks(leaves, "slack");
    await t.auth.client`delete from auth.member where organization_id = ${orgId} and user_id = ${leaves}`;
    expect(await claimRun(deps, { orgId, runId: fromSlack.runId }, "w")).toBeNull();
    expect(await outcome(fromSlack.runId)).toEqual({
      status: "failed",
      reason: "Its asker is no longer a member of this workspace, so it wasn't answered.",
    });

    const reads = await memberOf("member");
    const demoted = await asks(reads, "web");
    await t.auth.client`update auth.member set role = 'viewer' where organization_id = ${orgId} and user_id = ${reads}`;
    expect(await claimRun(deps, { orgId, runId: demoted.runId }, "w")).toBeNull();
    expect((await outcome(demoted.runId))?.reason).toBe(
      "Its asker can only read in this workspace now, so it wasn't answered.",
    );
  });

  it("ends the drafters an earlier attempt started when it's refused, so none is left queued", async () => {
    const leaves = await memberOf("admin");
    const lead = await asks(leaves, "web");
    const drafter = await withTenantOn(t.app, { orgId }, (tx) =>
      childRun(
        tx,
        { orgId, id: lead.runId },
        { profile: "drafter", task: { tables: [] }, title: "a", brief: async () => "" },
      ),
    );
    await t.auth.client`delete from auth.member where organization_id = ${orgId} and user_id = ${leaves}`;
    expect(await claimRun(deps, { orgId, runId: lead.runId }, "w")).toBeNull();
    expect((await outcome(drafter.runId))?.status).toBe("failed");
  });

  it("tries drafts only while its asker is still an owner or admin", async () => {
    const admin = await memberOf("admin");
    const first = await asks(admin, "web", true);
    expect((await claimRun(deps, { orgId, runId: first.runId }, "w"))?.canTryDrafts).toBe(true);
    await t.owner`update app.run set status = 'succeeded', finished_at = now() where id = ${first.runId}`;
    const second = await asks(admin, "web", true);
    await t.auth.client`update auth.member set role = 'member' where organization_id = ${orgId} and user_id = ${admin}`;
    expect((await claimRun(deps, { orgId, runId: second.runId }, "w"))?.canTryDrafts).toBe(false);
  });
});

describe("claim and fence", () => {
  it("a takeover bumps the attempt, and the old attempt can't write anything", async () => {
    const r = await ask("Fence?");
    const a1 = await claimRun(deps, { orgId, runId: r.runId }, "w1");
    expect(a1?.attempt).toBe(1);
    expect(a1?.question).toBe("Fence?");
    const a2 = await claimRun(deps, { orgId, runId: r.runId }, "w2");
    expect(a2?.attempt).toBe(2);
    await expect(
      commitAssistantMessage(deps, a1 as NonNullable<typeof a1>, {
        content: [{ type: "text", text: "zombie" }],
        text: "zombie",
        reasoning: "",
        usage,
        finishReason: "stop",
        provider: "anthropic",
        keySource: "deployment" as const,
      }),
    ).rejects.toBeInstanceOf(FenceLost);
    const zombie = await t.owner`select 1 from app.message where text = 'zombie'`;
    expect(zombie).toHaveLength(0);
    const events = await runEvents(deps, { orgId, userId: null }, r.runId);
    expect(events.map((e) => [e.type, e.data.discardAfterSeq])).toEqual([
      ["attempt_started", 0],
      ["attempt_started", 1],
    ]);
  });

  it("an ended run can't be claimed again", async () => {
    const r = await ask("Done?");
    const a = await claimRun(deps, { orgId, runId: r.runId }, "w1");
    await finalizeRun(deps, a as NonNullable<typeof a>, "succeeded", { kind: "no_answer", reason: "test" });
    expect(await claimRun(deps, { orgId, runId: r.runId }, "w2")).toBeNull();
  });
});

describe("tool calls and the transcript", () => {
  it("runs a tool call once: a call delivered again gets the stored result", async () => {
    const r = await ask("Ledger?");
    const run = (await claimRun(deps, { orgId, runId: r.runId }, "w1")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const messageId = await commitAssistantMessage(deps, run, {
      content: [{ type: "text", text: "Looking." }, toolCallPart("call-1")],
      text: "Looking.",
      reasoning: "",
      usage,
      finishReason: "tool-calls",
      provider: "anthropic",
      keySource: "deployment" as const,
    });
    const first = await startToolCall(deps, run, { callId: "call-1", tool: "value_lookup", args: {}, messageId });
    expect(first.status).toBe("started");
    await finishToolCall(deps, run, {
      callId: "call-1",
      tool: "value_lookup",
      outcome: { ok: true, value: { hits: 2 } },
    });
    const again = await startToolCall(deps, run, { callId: "call-1", tool: "value_lookup", args: {}, messageId });
    expect(again).toMatchObject({ status: "succeeded", result: { hits: 2 } });
    const [u] = await t.owner<{ usage: Record<string, number> }[]>`select usage from app.run where id = ${r.runId}`;
    expect(u?.usage).toMatchObject({ inputTokens: 100, outputTokens: 20, modelCalls: 1 });
    const [billed] = await t.owner<{ n: number }[]>`
      select count(*)::int as n from app.usage_event where source_id = ${r.runId}`;
    expect(billed?.n).toBe(1);
  });

  it("rebuilds the transcript, resolving a call the dead attempt never finished, and merging tool results", async () => {
    const r = await ask("Rebuild?");
    const a1 = (await claimRun(deps, { orgId, runId: r.runId }, "w1")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const messageId = await commitAssistantMessage(deps, a1, {
      content: [toolCallPart("c-a"), toolCallPart("c-b")],
      text: "",
      reasoning: "",
      usage,
      finishReason: "tool-calls",
      provider: "anthropic",
      keySource: "deployment" as const,
    });
    await startToolCall(deps, a1, { callId: "c-a", tool: "value_lookup", args: {}, messageId });
    await finishToolCall(deps, a1, { callId: "c-a", tool: "value_lookup", outcome: { ok: true, value: { ok: 1 } } });
    // c-b never ran: the worker died. The next attempt resolves it before calling the model.
    const a2 = (await claimRun(deps, { orgId, runId: r.runId }, "w2")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const messages = await rebuildTranscript(deps, a2);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const results = messages[2]?.content as { toolCallId: string; output: { type: string; value: unknown } }[];
    expect(results.map((p) => [p.toolCallId, p.output.type])).toEqual([
      ["c-a", "json"],
      ["c-b", "error-text"],
    ]);
    expect(String(results[1]?.output.value)).toMatch(/interrupted/);
    const [row] = await t.owner<{ status: string }[]>`
      select status from app.tool_call where run_id = ${r.runId} and call_id = 'c-b'`;
    expect(row?.status).toBe("unknown");
    // A second rebuild is stable: nothing new to resolve.
    expect(await rebuildTranscript(deps, a2)).toEqual(messages);
  });

  it("puts a call's result right after it, even one resolved after a note from OpenDash", async () => {
    const q = await ask("Note in the middle");
    const a1 = await claimRun(deps, { orgId, runId: q.runId }, "w1");
    if (!a1) throw new Error("not claimed");
    await commitAssistantMessage(deps, a1, {
      content: [toolCallPart("c-note")],
      text: "",
      reasoning: "",
      usage,
      finishReason: "length",
      provider: "anthropic",
      keySource: "deployment" as const,
    });
    // The call never ran (its response was cut off), and OpenDash added a note before anything answered it.
    await appendNote(deps, a1, "(OpenDash) Call one of them now.");
    const a2 = await claimRun(deps, { orgId, runId: q.runId }, "w2");
    if (!a2) throw new Error("not claimed");
    const messages = (await rebuildTranscript(deps, a2)) as { role: string; content: unknown }[];
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    expect(JSON.stringify(messages[2]?.content)).toContain("c-note");
  });

  it("resolves a call an earlier run left open when it ended, in the transcript only", async () => {
    const r = await ask("Stopped mid-call?");
    const a1 = (await claimRun(deps, { orgId, runId: r.runId }, "w1")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const messageId = await commitAssistantMessage(deps, a1, {
      content: [toolCallPart("c-open")],
      text: "",
      reasoning: "",
      usage,
      finishReason: "tool-calls",
      provider: "anthropic",
      keySource: "deployment" as const,
    });
    await startToolCall(deps, a1, { callId: "c-open", tool: "sql_query", args: {}, messageId });
    // The run ends with the call open (stopped while it ran, or dead-lettered).
    await t.owner`update app.run set status = 'cancelled', finished_at = now() where id = ${r.runId}`;
    const next = await ask("And now?", { threadId: r.threadId });
    const b = (await claimRun(deps, { orgId, runId: next.runId }, "w2")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const messages = await rebuildTranscript(deps, b);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user"]);
    const [result] = (messages[2]?.content ?? []) as {
      toolCallId: string;
      output: { type: string; value: unknown };
    }[];
    expect(result).toMatchObject({ toolCallId: "c-open", output: { type: "error-text" } });
    expect(String(result?.output.value)).toMatch(/ended first/);
    // The ended run's record stays as it ended.
    const [row] = await t.owner<{ status: string }[]>`
      select status from app.tool_call where run_id = ${r.runId} and call_id = 'c-open'`;
    expect(row?.status).toBe("started");
  });

  it("hands out query aliases per conversation, across runs", async () => {
    const r = await ask("Aliases?");
    const run = (await claimRun(deps, { orgId, runId: r.runId }, "w1")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const ids = [uuidv7(), uuidv7()];
    for (const id of ids) {
      await t.owner`
        insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, compiled_sql, sql_hash, status)
        values (${id}, ${orgId}, ${connectionId}, 'run', ${r.runId}, 'execute', 'select 1', 'h', 'succeeded')`;
    }
    expect(await assignAlias(deps, run, ids[0] as string)).toBe("q1");
    expect(await assignAlias(deps, run, ids[1] as string)).toBe("q2");
    await finalizeRun(deps, run, "succeeded", { kind: "no_answer", reason: "test" });
    const next = await ask("And then?", { threadId: run.threadId });
    const run2 = (await claimRun(deps, { orgId, runId: next.runId }, "w1")) as NonNullable<
      Awaited<ReturnType<typeof claimRun>>
    >;
    const id = uuidv7();
    await t.owner`
      insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, compiled_sql, sql_hash, status)
      values (${id}, ${orgId}, ${connectionId}, 'run', ${next.runId}, 'execute', 'select 1', 'h', 'succeeded')`;
    expect(await assignAlias(deps, run2, id)).toBe("q3");
  });
});

describe("with the queue", () => {
  it("enqueues one agent.interactive job per run, in the submit transaction", async () => {
    const boss = createBoss(t.url("opendash_queue"), "worker", { supervise: false, schedule: false });
    await boss.start();
    try {
      await installQueues(boss);
      const queued = { withTenant: deps.withTenant, boss };
      const a = await submitQuestion(queued, {
        orgId,
        userId: null,
        connectionId,
        text: "Queued?",
        channel: "eval",
        model: "m",
      });
      const b = await submitQuestion(queued, {
        orgId,
        userId: null,
        connectionId,
        text: "Also?",
        channel: "eval",
        model: "m",
      });
      const jobs = await t.owner<{ singleton_key: string; data: { orgId: string; runId: string } }[]>`
        select singleton_key, data from pgboss.job where name = 'agent.interactive' order by created_on`;
      expect(jobs.map((j) => j.singleton_key)).toEqual([a.runId, b.runId]);
      expect(jobs[0]?.data).toEqual({ orgId, runId: a.runId });
      // A submit that fails (an active run on the thread) leaves no job behind.
      await expect(
        submitQuestion(queued, {
          orgId,
          userId: null,
          connectionId,
          threadId: a.threadId,
          text: "Again?",
          channel: "eval",
          model: "m",
        }),
      ).rejects.toBeInstanceOf(RunActive);
      const after = await t.owner<
        { n: number }[]
      >`select count(*)::int as n from pgboss.job where name = 'agent.interactive'`;
      expect(after[0]?.n).toBe(2);
    } finally {
      await boss.stop({ graceful: false });
    }
  });
});

describe("usage and cost", () => {
  const call = (usage: Record<string, number>) => ({
    content: [{ type: "text", text: "x" }],
    text: "x",
    reasoning: "",
    usage,
    finishReason: "stop",
    provider: "anthropic",
    keySource: "deployment" as const,
  });

  it("prices each call once, and a run's total reconciles exactly with its usage events", async () => {
    const r = await submitQuestion(deps, {
      orgId,
      userId: null,
      connectionId,
      text: "Priced?",
      channel: "eval",
      model: "claude-sonnet-5-5",
    });
    const run = await claimRun(deps, { orgId, runId: r.runId }, "w-cost");
    if (!run) throw new Error("not claimed");
    // $2 in, $0.10 read, $2.50 written, $10 out per million: 0.004 + 0.0009 + 0.0025 + 0.008 = $0.0154.
    await commitAssistantMessage(
      deps,
      run,
      call({
        inputTokens: 12_000,
        noCacheTokens: 2_000,
        cachedInputTokens: 9_000,
        cacheWriteTokens: 1_000,
        outputTokens: 800,
      }),
    );
    // No uncached count from the provider: input less read and written (1,000), so $0.002 + $0.0014 + $0.003.
    await commitAssistantMessage(
      deps,
      run,
      call({ inputTokens: 15_000, cachedInputTokens: 14_000, outputTokens: 300 }),
    );
    const [row] = await t.owner<{ usage: Record<string, number> }[]>`select usage from app.run where id = ${r.runId}`;
    expect(row?.usage).toMatchObject({ costUsd: 0.0218, unpricedCalls: 0, cacheWriteTokens: 1_000, modelCalls: 2 });
    const [events] = await t.owner<{ qty: string; cost: string; n: number }[]>`
      select sum(qty)::text as qty, sum(cost_usd)::text as cost, count(*)::int as n from app.usage_event
      where source_id = ${r.runId}`;
    expect(Number(events?.cost)).toBe(row?.usage.costUsd);
    expect(Number(events?.qty)).toBe((row?.usage.inputTokens ?? 0) + (row?.usage.outputTokens ?? 0));
    expect(events?.n).toBe(row?.usage.modelCalls);

    const summary = await deps.withTenant(orgId, (tx) => usageSummary(tx, orgId));
    expect(summary.byModel.find((m) => m.model === "claude-sonnet-5-5")).toEqual({
      model: "claude-sonnet-5-5",
      keySource: "deployment",
      questions: 1,
      calls: 2,
      tokens: 28_100,
      costUsd: 0.0218,
      unpriced: 0,
    });
    expect(summary.byDay.reduce((s, d) => s + d.calls, 0)).toBe(summary.totals.calls);
  });

  it("leaves a model without a price unpriced, never $0", async () => {
    const r = await ask("Unpriced?");
    const run = await claimRun(deps, { orgId, runId: r.runId }, "w-unpriced");
    if (!run) throw new Error("not claimed");
    await commitAssistantMessage(deps, run, call({ inputTokens: 1_000, outputTokens: 10 }));
    const [row] = await t.owner<{ usage: Record<string, number> }[]>`select usage from app.run where id = ${r.runId}`;
    expect(row?.usage).toMatchObject({ unpricedCalls: 1, costUsd: 0 });
    const [e] = await t.owner<
      { cost: string | null }[]
    >`select cost_usd as cost from app.usage_event where source_id = ${r.runId}`;
    expect(e?.cost).toBeNull();
    const summary = await deps.withTenant(orgId, (tx) => usageSummary(tx, orgId));
    expect(summary.byModel.find((m) => m.model === "test-model")?.unpriced).toBeGreaterThan(0);
  });
});

describe("a shared conversation's readers and the asker's memory", () => {
  it("see a run given memory without its working notes; its author sees them", async () => {
    const author = uuidv7();
    const reader = uuidv7();
    await joins(author);
    const r = await submitQuestion(deps, {
      orgId,
      userId: author,
      connectionId,
      text: "What was churn?",
      channel: "web",
      model: "test-model",
    });
    const run = await claimRun(deps, { orgId, runId: r.runId }, "w-memory");
    if (!run) throw new Error("not claimed");
    await recordContext(deps, run, [{ id: uuidv7(), kind: "memory", title: "", version: 1, how: "yours" }]);
    await commitAssistantMessage(deps, run, {
      content: [{ type: "text", text: "Using their memory: churn is churned MRR." }],
      text: "Using their memory: churn is churned MRR.",
      reasoning: "Their memory says churn means churned MRR.",
      usage,
      finishReason: "stop",
      provider: "anthropic",
      keySource: "deployment" as const,
    });
    expect(await shareThread(deps, { orgId, userId: author }, r.threadId, "org")).toBe(true);
    const message = (events: Awaited<ReturnType<typeof runEvents>>) =>
      events.find((e) => e.type === "assistant_message")?.data;
    expect(message(await runEvents(deps, { orgId, userId: author }, r.runId))).toMatchObject({
      reasoning: "Their memory says churn means churned MRR.",
    });
    await startToolCall(deps, run, {
      callId: "m-1",
      tool: "context_search",
      args: { query: "churned MRR preference" },
      messageId: null,
    });
    await finishToolCall(deps, run, {
      callId: "m-1",
      tool: "context_search",
      outcome: { ok: false, error: "nothing about churned MRR" },
    });
    const read = await runEvents(deps, { orgId, userId: reader }, r.runId);
    expect(message(read)).toEqual({ messageId: expect.any(String), toolCalls: [], redacted: true });
    // Structure only: no text the model wrote, anywhere.
    expect(JSON.stringify(read)).not.toContain("churned MRR");
    expect(read.find((e) => e.type === "tool_result")?.data).toMatchObject({ tool: "context_search", redacted: true });
  });
});

describe("streaming", () => {
  it("announces each event once it commits, with ids only", async () => {
    const listener = createListener(t.url("opendash_app"));
    const heard: string[] = [];
    await listener.listen(RUN_EVENTS_CHANNEL, (payload) => heard.push(payload));
    try {
      const r = await ask("Streamed?");
      const run = await claimRun(deps, { orgId, runId: r.runId }, "w-stream");
      if (!run) throw new Error("not claimed");
      await finalizeRun(deps, run, "succeeded", { kind: "no_answer", reason: "test" });
      const seqs = (await runEvents(deps, { orgId, userId: null }, r.runId)).map((e) => e.seq);
      await expect
        .poll(() => heard.filter((h) => h.startsWith(`${r.runId}:`)))
        .toEqual(seqs.map((s) => `${r.runId}:${s}`));
      // No tenant data rides on the channel: anyone LISTENing sees ids, and reads events through RLS.
      for (const h of heard) expect(h).toMatch(/^[0-9a-f-]{36}:\d+$/);
    } finally {
      await listener.end();
    }
  });
});

describe("dead letters", () => {
  it("fails a run whose job is gone, once, and leaves an ended run alone", async () => {
    const r = await ask("Lost?");
    await claimRun(deps, { orgId, runId: r.runId }, "w1");
    expect(await failRunFromQueue(deps, { orgId, runId: r.runId }, "The run stopped unexpectedly.")).toBe(true);
    expect(await failRunFromQueue(deps, { orgId, runId: r.runId }, "again")).toBe(false);
    const run = await getRun(deps, { orgId, userId: null }, r.runId);
    expect(run).toMatchObject({ status: "failed", error: "The run stopped unexpectedly." });
  });
});

describe("a run's earlier attempts", () => {
  it("count their working time, and their failures: a crash is one, a shutdown hand-off isn't", async () => {
    const q = await ask("How long have we worked?");
    const first = await claimRun(deps, { orgId, runId: q.runId }, "w1");
    if (!first) throw new Error("not claimed");
    // The first attempt worked two seconds, then its worker died (it records no end).
    await t.owner`update app.run_event set created_at = created_at - interval '2 seconds'
      where run_id = ${q.runId} and attempt = 1`;
    await appendNote(deps, first, "(OpenDash) still working");
    const second = await claimRun(deps, { orgId, runId: q.runId }, "w2");
    if (!second) throw new Error("not claimed");
    await recordAttemptEnd(deps, second, "shutdown");
    // An attempt that lost the run records nothing, and doesn't fail for trying.
    await recordAttemptEnd(deps, first, "model_busy");
    const third = await claimRun(deps, { orgId, runId: q.runId }, "w3");
    if (!third) throw new Error("not claimed");
    const spent = await runSpent(deps, third);
    expect(spent.failedAttempts).toBe(1);
    expect(spent.workedMs).toBeGreaterThanOrEqual(1900);
    expect(spent.workedMs).toBeLessThan(10_000);
    const ends = await t.owner<{ attempt: number; reason: string }[]>`
      select attempt, data->>'reason' as reason from app.run_event where run_id = ${q.runId} and type = 'attempt_ended'`;
    expect(ends).toEqual([{ attempt: 2, reason: "shutdown" }]);
  });

  it("count a failed check as a failed query, as the run does while it works, but not as a query run", async () => {
    const q = await ask("Check it first");
    const run = await claimRun(deps, { orgId, runId: q.runId }, "w1");
    if (!run) throw new Error("not claimed");
    const messageId = await commitAssistantMessage(deps, run, {
      content: [toolCallPart("chk-1", "sql_check")],
      text: "",
      reasoning: "",
      usage: { inputTokens: 1, outputTokens: 1 },
      finishReason: "tool-calls",
      provider: "anthropic",
      keySource: "deployment",
    });
    const row = await startToolCall(deps, run, { callId: "chk-1", tool: "sql_check", args: {}, messageId });
    await t.owner`
      insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, tool_call_id, mode,
        compiled_sql, sql_hash, status, truncated, sanity, created_at)
      values (${uuidv7()}, ${orgId}, ${connectionId}, 'run', ${q.runId}, ${row.id}, 'explain',
        'select nope', 'h', 'failed', false, '[]'::jsonb, now())`;
    await finishToolCall(deps, run, { callId: "chk-1", tool: "sql_check", outcome: { ok: true, value: {} } });
    const spent = await runSpent(deps, run);
    expect(spent).toMatchObject({ queries: 0, failedQueries: 1, toolCalls: 1 });
  });
});

describe("stored prompts", () => {
  const sent = (source: string) => ({
    agent: "The agent layer.",
    source,
    question: "Today is 2026-10-15; times are UTC.",
    verified: [],
    tools: ["answer"],
    attached: [],
    memories: 0,
  });

  it("sends an earlier question again with its block, only while its verified queries hold", async () => {
    const vq = uuidv7();
    await t.owner`
      insert into app.context_item (org_id, id, kind, path, slug, title, status, current_version, released_version)
      values (${orgId}, ${vq}, 'verified_query', ${`/verified/${vq}.md`}, ${`v_${vq.slice(0, 8)}`}, 'MRR by month',
        'verified', 1, 1)`;
    const first = await ask("What was MRR in September?");
    const asked = await claimRun(deps, { orgId, runId: first.runId }, "w1");
    if (!asked) throw new Error("not claimed");
    await recordPrompt(deps, asked, {
      ...sent("The source layer."),
      question: "Today is 2026-10-15.\n\nA verified query like it: MRR by month.",
      verified: [{ kind: "verified_query", id: vq, version: 1 }],
    });
    await finalizeRun(deps, asked, "succeeded", { kind: "no_answer", reason: "Done." }, null, "finished");
    const next = await ask("And in October?", { threadId: first.threadId });
    const running = await claimRun(deps, { orgId, runId: next.runId }, "w1");
    if (!running) throw new Error("not claimed");
    const questions = async () =>
      JSON.stringify((await rebuildTranscript(deps, running)).filter((m) => m.role === "user"));
    expect(await questions()).toContain("A verified query like it: MRR by month.");
    // An admin changes the verified query: the earlier question reads without the block that held its old version.
    await t.owner`update app.context_item set released_version = 2, current_version = 2 where id = ${vq}`;
    expect(await questions()).not.toContain("A verified query like it");
    expect(await questions()).toContain("What was MRR in September?");
  });

  it("stores each layer once, and drops one no run refers to after a day", async () => {
    const q = await ask("What was it sent?");
    const first = await claimRun(deps, { orgId, runId: q.runId }, "w1");
    if (!first) throw new Error("not claimed");
    const was = await recordPrompt(deps, first, sent("The source layer, before a sync."));
    // Its next attempt was sent the source after a sync: the first source layer is no longer referred to.
    const second = await claimRun(deps, { orgId, runId: q.runId }, "w2");
    if (!second) throw new Error("not claimed");
    const now = await recordPrompt(deps, second, sent("The source layer, after a sync."));
    expect(now.agent).toBe(was.agent);
    expect(now.source).not.toBe(was.source);
    const [run] = await t.owner<{ prompt: { attempt: number; source: string } }[]>`
      select prompt from app.run where id = ${q.runId}`;
    expect(run?.prompt).toMatchObject({ attempt: 2, source: now.source });

    await t.owner`update app.prompt_text set created_at = now() - interval '2 days' where org_id = ${orgId}`;
    await t.owner`insert into app.prompt_text (org_id, sha256, text) values (${orgId}, 'fresh', 'Just written.')`;
    expect(await dropUnusedPrompts((fn) => withSystemOn(t.system, fn))).toBe(1);
    const kept = (await t.owner<{ sha256: string }[]>`select sha256 from app.prompt_text where org_id = ${orgId}`).map(
      (k) => k.sha256,
    );
    expect(kept).toEqual(expect.arrayContaining([now.agent, now.source, now.question, "fresh"]));
    expect(kept).not.toContain(was.source);
  });
});

// Follow-ups against a real database: a message sent while its conversation's answer is worked on is queued
// on that run (once per client id; never an eval's, never on background work, never one that switches the source), read
// at the run's next step with its place in the transcript, or passed on as the next run's question when the run ends
// first (finished, stopped, failed, or over the spend limit); one with attachments waits for that next run; its author
// can take it back until it's read; the thread shows each with its run.
import { type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  claimRun,
  failRunFromQueue,
  finalizeRun,
  getThread,
  isFollowUp,
  joinFollowUps,
  RunActive,
  rebuildTranscript,
  requestStop,
  setSpendLimits,
  submitQuestion,
  takeBackFollowUp,
} from "../src";

let t: TestDatabase;
const orgId = uuidv7();
const connectionId = uuidv7();
const me = uuidv7();
const deps = {
  withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
  boss: null,
};
const ask = (text: string, extra: Partial<Parameters<typeof submitQuestion>[1]> = {}) =>
  submitQuestion(deps, { orgId, userId: me, connectionId, text, channel: "web", model: "m", ...extra });
const row = async (id: string) => {
  const [m] = await t.owner<{ seq: number | null; kind: string; status: string; run_id: string | null }[]>`
    select seq, kind, status, run_id from app.message where id = ${id}`;
  return m;
};
const thread = (threadId: string) => getThread(deps, { orgId, userId: me }, threadId);
const stopped = { kind: "no_answer" as const, reason: "Stopped." };

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Follow-ups");
  // The asker is a member: only a member's question is answered.
  await t.auth
    .client`insert into auth.user (id, name, email, email_verified) values (${me}, 'Me', 'me@acme.test', true)`;
  await t.auth.client`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${orgId}, ${me}, 'member', now())`;
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connectionId}, 'src', 'postgres')`;
});

afterAll(async () => {
  await t?.drop();
});

describe("a follow-up", () => {
  it("queues on the answer being worked on, once per client id; an eval's question is refused as before", async () => {
    const first = await ask("How did MRR change?");
    const added = await ask("And churn?", { threadId: first.threadId, clientMsgId: "c-2" });
    expect(added).toEqual({
      threadId: first.threadId,
      runId: first.runId,
      messageId: expect.any(String),
      queued: true,
    });
    expect(await ask("And churn?", { threadId: first.threadId, clientMsgId: "c-2" })).toEqual(added);
    expect(await row(added.messageId)).toEqual({
      seq: null,
      kind: "queued_input",
      status: "queued",
      run_id: first.runId,
    });
    await expect(ask("Again?", { threadId: first.threadId, channel: "eval" })).rejects.toBeInstanceOf(RunActive);
    // Nor one sent another way (the API, into an answer asked on the web): it would run with the web's trigger, and
    // with what that may use (memoryRoom), so it waits for the answer to end.
    await expect(ask("And via the API?", { threadId: first.threadId, channel: "api" })).rejects.toBeInstanceOf(
      RunActive,
    );
    // A follow-up can't move the conversation to another source while this answer is worked on.
    const other = uuidv7();
    await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${other}, 'support', 'postgres')`;
    await expect(ask("And tickets?", { threadId: first.threadId, connectionId: other })).rejects.toBeInstanceOf(
      RunActive,
    );
    // Background work in a conversation (a drafting batch) reads no follow-up: one sent meanwhile is refused as before.
    const drafting = await ask("Draft the plans table");
    await t.owner`update app.run set profile = 'modeler' where id = ${drafting.runId}`;
    await expect(ask("And invoices?", { threadId: drafting.threadId })).rejects.toBeInstanceOf(RunActive);
  });

  it("waits, unread, once its author can only read (or left): the next run, refused for them, says why", async () => {
    const first = await ask("How did ARR change?");
    const run = await claimRun(deps, { orgId, runId: first.runId }, "w1");
    if (!run) throw new Error("expected to claim the run");
    const next = await ask("By region?", { threadId: first.threadId });
    await t.auth.client`update auth.member set role = 'viewer' where organization_id = ${orgId} and user_id = ${me}`;
    try {
      expect(await joinFollowUps(deps, run)).toEqual([]);
      expect(await row(next.messageId)).toMatchObject({ kind: "queued_input", status: "queued" });
    } finally {
      await t.auth.client`update auth.member set role = 'member' where organization_id = ${orgId} and user_id = ${me}`;
      await t.owner`update app.run set status = 'cancelled', finished_at = now() where thread_id = ${first.threadId}`;
    }
  });

  it("is read at the run's next step, in its place, marked as the run's; one with attachments, or after the source moved, waits", async () => {
    const first = await ask("How did MRR change?");
    const run = await claimRun(deps, { orgId, runId: first.runId }, "w1");
    if (!run) throw new Error("expected to claim the run");
    const byPlan = await ask("By plan?", { threadId: first.threadId });
    const file = { kind: "file" as const, id: uuidv7(), name: "notes.txt", text: "Plans renamed in May." };
    const withFile = await ask("See this file", { threadId: first.threadId, attachments: [file] });

    // Only the asker's own are read (no one else can add to the conversation; the read holds to it too).
    await t.owner`
      insert into app.message (org_id, id, thread_id, run_id, role, kind, status, author_id, content, text)
      values (${orgId}, ${uuidv7()}, ${first.threadId}, ${first.runId}, 'user', 'queued_input', 'queued', ${uuidv7()},
        ${t.owner.json({ role: "user", content: "Someone else's" })}, 'Someone else''s')`;
    expect(await joinFollowUps(deps, run)).toEqual([{ id: byPlan.messageId, text: "By plan?" }]);
    expect(await joinFollowUps(deps, run)).toEqual([]);
    expect(await row(byPlan.messageId)).toMatchObject({ kind: "normal", status: "complete", run_id: first.runId });
    expect((await row(byPlan.messageId))?.seq).toBeGreaterThan(0);
    expect((await row(withFile.messageId))?.status).toBe("queued");
    const [joined] = await t.owner<{ data: { messageId: string; text: string } }[]>`
      select data from app.run_event where run_id = ${first.runId} and type = 'input_joined'`;
    expect(joined?.data).toEqual({ messageId: byPlan.messageId, text: "By plan?" });

    // A resumed attempt reads it where it was read, still the run's own, never its question.
    const transcript = await rebuildTranscript(deps, run);
    const last = transcript.at(-1) as { role: string; content: unknown; providerOptions?: unknown };
    expect(last).toMatchObject({ role: "user", content: "By plan?" });
    expect(isFollowUp(last)).toBe(true);
    await t.owner`delete from app.message where thread_id = ${first.threadId} and text = 'Someone else''s'`;
    expect((await thread(first.threadId))?.turns.map((x) => x.followUps.map((f) => [f.text, f.state]))).toEqual([
      [
        ["By plan?", "read"],
        ["See this file", "next"],
      ],
    ]);

    // Taken over, the run's question is what the asker wrote in it: the follow-up it read too.
    expect((await claimRun(deps, { orgId, runId: first.runId }, "w2"))?.question).toBe(
      "How did MRR change?\n\nBy plan?",
    );
  });

  it("is the next run's question when the run is stopped while it works", async () => {
    const first = await ask("How did MRR change?");
    const run = await claimRun(deps, { orgId, runId: first.runId }, "w1");
    if (!run) throw new Error("expected to claim the run");
    const churn = await ask("Actually, churn instead", { threadId: first.threadId });
    expect(await requestStop(deps, { orgId, userId: me }, first.runId)).toBe(true);
    await finalizeRun(deps, run, "cancelled", stopped);
    const [next] = await t.owner<{ status: string; input_message_id: string }[]>`
      select status, input_message_id from app.run where thread_id = ${first.threadId} and id <> ${first.runId}`;
    expect(next).toEqual({ status: "queued", input_message_id: churn.messageId });
  });

  it("is the next run's question when the run ends first, the rest queued on that run, a Slack reply going on to it", async () => {
    const first = await ask("How did MRR change?");
    const run = await claimRun(deps, { orgId, runId: first.runId }, "w1");
    if (!run) throw new Error("expected to claim the run");
    await t.owner`
      insert into app.slack_reply (org_id, run_id, team_id, slack_thread_id, slack_user_id, slack_message_ts)
      values (${orgId}, ${first.runId}, 'T0ACME', 'slack:D0:1.1', 'UPRIYA', '1.2')`;
    const churn = await ask("And churn?", { threadId: first.threadId, model: "other-model" });
    const plan = await ask("And by plan?", { threadId: first.threadId });
    await finalizeRun(deps, run, "succeeded", stopped);

    const [next] = await t.owner<{ id: string; status: string; model: string; input_message_id: string }[]>`
      select id, status, model, input_message_id from app.run where thread_id = ${first.threadId} and id <> ${first.runId}`;
    expect(next).toMatchObject({ status: "queued", model: "other-model", input_message_id: churn.messageId });
    expect(await row(churn.messageId)).toMatchObject({ kind: "normal", status: "complete", run_id: null });
    expect(await row(plan.messageId)).toMatchObject({ status: "queued", run_id: next?.id });
    const [reply] = await t.owner<{ team_id: string; slack_message_ts: string | null }[]>`
      select team_id, slack_message_ts from app.slack_reply where run_id = ${next?.id as string}`;
    expect(reply).toEqual({ team_id: "T0ACME", slack_message_ts: null });
    expect(
      (await thread(first.threadId))?.turns.map((x) => [x.message.text, x.run?.status, x.followUps.map((f) => f.text)]),
    ).toEqual([
      ["How did MRR change?", "succeeded", []],
      ["And churn?", "queued", ["And by plan?"]],
    ]);
    // Sent now, it queues on the run that started.
    expect((await ask("And last year?", { threadId: first.threadId })).runId).toBe(next?.id);
  });

  it("is passed on by a run that fails from the queue too, and taken back only by its author, before it's read", async () => {
    const first = await ask("How did MRR change?");
    const kept = await ask("And churn?", { threadId: first.threadId });
    const taken = await ask("Never mind", { threadId: first.threadId });
    expect(await takeBackFollowUp(deps, { orgId, userId: uuidv7() }, taken.messageId)).toBe(false);
    expect(await takeBackFollowUp(deps, { orgId, userId: me }, taken.messageId)).toBe(true);
    expect(await row(taken.messageId)).toBeUndefined();

    expect(await failRunFromQueue(deps, { orgId, runId: first.runId }, "The analyst stopped unexpectedly.")).toBe(true);
    const [next] = await t.owner<{ input_message_id: string }[]>`
      select input_message_id from app.run where thread_id = ${first.threadId} and id <> ${first.runId}`;
    expect(next?.input_message_id).toBe(kept.messageId);
    // A question now, it's no longer anyone's to take back.
    expect(await takeBackFollowUp(deps, { orgId, userId: me }, kept.messageId)).toBe(false);
  });

  it("is refused at once when the spend limit was reached after it was sent: none runs, none waits", async () => {
    const first = await ask("How did MRR change?");
    const run = await claimRun(deps, { orgId, runId: first.runId }, "w1");
    if (!run) throw new Error("expected to claim the run");
    await ask("And churn?", { threadId: first.threadId });
    await ask("And by plan?", { threadId: first.threadId });
    await deps.withTenant(orgId, (tx) => setSpendLimits(tx, { orgId, userId: me }, { monthlyUsd: null, dailyUsd: 1 }));
    await t.system.client`
      insert into app.usage_event (id, org_id, kind, qty, unit, model, provider, key_source, cost_usd, source_type,
        source_id, background)
      values (app.uuidv7_floor(now()), ${orgId}, 'llm_tokens', 100, 'tokens', 'claude-sonnet-5-5', 'anthropic',
        'deployment', 2, 'run', ${first.runId}, false)`;
    try {
      await finalizeRun(deps, run, "succeeded", stopped);
      const turns = (await thread(first.threadId))?.turns ?? [];
      expect(turns.map((x) => [x.message.text, x.run?.status, x.run?.outcome?.kind])).toEqual([
        ["How did MRR change?", "succeeded", "no_answer"],
        ["And churn?", "failed", "no_answer"],
        ["And by plan?", "failed", "no_answer"],
      ]);
      expect(turns[1]?.run?.error).toMatch(/today's \$1\.00 limit for AI/);
      const [left] = await t.owner<{ n: number }[]>`
        select count(*)::int as n from app.message where thread_id = ${first.threadId} and status = 'queued'`;
      expect(left?.n).toBe(0);
    } finally {
      await deps.withTenant(orgId, (tx) =>
        setSpendLimits(tx, { orgId, userId: me }, { monthlyUsd: null, dailyUsd: null }),
      );
    }
  });
});

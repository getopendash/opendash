// Feedback on answers: thumbs with a reason, "this number is wrong", one row per person per target, only on answers
// the person can see (and numbers from that answer's queries), and the reviewers' reports with the definitions used,
// which never show more of a private conversation than the reviewer could open. A thumbs down that says what it
// should have said is a correction: the person's memory at once, a guide for everyone once an admin approves it.
import { type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  askedToRemember,
  giveFeedback,
  listMemories,
  listReports,
  myFeedback,
  ownWordsInThread,
  rememberFact,
  reportsForDefinition,
  setReportStatus,
  submitQuestion,
  withdrawFeedback,
} from "../src";

let t: TestDatabase;
const orgId = uuidv7();
const connectionId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const itemId = uuidv7();
const deps = {
  withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
  boss: null,
};
const as = (userId: string) => ({ orgId, userId });
let runId: string;
let queryRunId: string;
let otherQueryRunId: string;

/** A finished answer in a private conversation of alice's, with one metric query. */
async function answered(userId: string, question: string) {
  const r = await submitQuestion(deps, { orgId, userId, connectionId, text: question, channel: "web", model: "m" });
  await t.owner`update app.run set status = 'succeeded', outcome = ${t.owner.json({ kind: "answer", status: "answered" })} where id = ${r.runId}`;
  const q = uuidv7();
  await t.owner`
    insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, alias, mode, path, engine,
      compiled_sql, sql_hash, status, semantic)
    values (${q}, ${orgId}, ${connectionId}, 'run', ${r.runId}, 'q1', 'execute', 'metric', 'compiler', 'select 1', 'h',
      'succeeded', ${t.owner.json({ query: {}, definitions: [{ id: itemId, kind: "metric", slug: "mrr", version: 1 }] })})`;
  return { runId: r.runId, queryRunId: q };
}

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "Feedback");
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connectionId}, 'src', 'postgres')`;
  await t.owner`
    insert into app.context_item (org_id, id, kind, connection_id, path, slug, title, current_version)
    values (${orgId}, ${itemId}, 'metric', ${connectionId}, '/sources/x/metrics/mrr.yaml', 'mrr', 'MRR', 1)`;
  ({ runId, queryRunId } = await answered(alice, "How did MRR change last month?"));
  ({ queryRunId: otherQueryRunId } = await answered(bob, "Bob's own question?"));
});

afterAll(async () => {
  await t?.drop();
});

describe("feedback", () => {
  it("records a thumbs down with its reason, once per person, and can be changed or taken back", async () => {
    expect(await giveFeedback(deps, as(alice), { runId, kind: "up" })).toMatchObject({ id: expect.any(String) });
    expect(await myFeedback(deps, as(alice), runId)).toEqual({
      answer: { kind: "up", reasonCode: null, comment: null, correction: null },
      numbers: [],
    });
    await giveFeedback(deps, as(alice), {
      runId,
      kind: "down",
      reasonCode: "wrong_definition",
      comment: "MRR should leave out refunds",
    });
    expect((await myFeedback(deps, as(alice), runId)).answer).toMatchObject({
      kind: "down",
      reasonCode: "wrong_definition",
      comment: "MRR should leave out refunds",
    });
    const [n] = await t.owner<{ n: number }[]>`select count(*)::int as n from app.feedback where target_type = 'run'`;
    expect(n?.n).toBe(1);
    expect(await withdrawFeedback(deps, as(alice), runId)).toBe(true);
    expect((await myFeedback(deps, as(alice), runId)).answer).toBeNull();
  });

  it("takes a wrong number only from the answer's own queries, and only on answers the person can see", async () => {
    expect(
      await giveFeedback(deps, as(alice), {
        runId,
        queryRunId,
        claimKey: "q1:0:mrr",
        kind: "wrong_number",
        correction: "412k",
      }),
    ).not.toBeNull();
    expect((await myFeedback(deps, as(alice), runId)).numbers).toEqual(["q1:0:mrr"]);
    // Another conversation's query, and someone else's private conversation.
    expect(
      await giveFeedback(deps, as(alice), {
        runId,
        queryRunId: otherQueryRunId,
        claimKey: "q1:0:x",
        kind: "wrong_number",
      }),
    ).toBeNull();
    expect(await giveFeedback(deps, as(bob), { runId, kind: "down" })).toBeNull();
  });

  it("shows admins the reports, with the definitions the answer used, until one is dismissed", async () => {
    await giveFeedback(deps, as(alice), { runId, kind: "down", reasonCode: "wrong_number" });
    const reports = await deps.withTenant(orgId, (tx) => listReports(tx, as(bob)));
    // Bob reviews: he sees what was reported, not alice's private conversation.
    expect(reports.map((r) => [r.kind, r.claimKey, r.question, r.threadId, r.mine])).toEqual([
      ["down", null, null, null, false],
      ["wrong_number", "q1:0:mrr", null, null, false],
    ]);
    const own = await deps.withTenant(orgId, (tx) => listReports(tx, as(alice)));
    expect(own.map((r) => [r.question, r.mine])).toEqual([
      ["How did MRR change last month?", true],
      ["How did MRR change last month?", true],
    ]);
    expect(reports[1]?.correction).toBe("412k");
    expect(reports[0]?.definitions).toEqual([{ id: itemId, kind: "metric", title: "MRR" }]);
    expect(await deps.withTenant(orgId, (tx) => reportsForDefinition(tx, as(bob), itemId))).toHaveLength(2);
    expect(await deps.withTenant(orgId, (tx) => setReportStatus(tx, orgId, reports[0]?.id as string, "ignored"))).toBe(
      true,
    );
    expect(await deps.withTenant(orgId, (tx) => listReports(tx, as(bob)))).toHaveLength(1);
    expect(await deps.withTenant(orgId, (tx) => listReports(tx, as(bob), { status: "ignored" }))).toHaveLength(1);
  });
});

describe("a correction on an answer", () => {
  const withUser = <T>(org: string, userId: string, fn: (tx: TenantTx) => Promise<T>) =>
    withTenantOn(t.app, { orgId: org, userId }, fn);
  const full = { ...deps, withUser };
  const facts = async (userId: string) =>
    (await withUser(orgId, userId, (tx) => listMemories(tx, orgId, userId))).map((m) => m.fact);
  const _guide = async (id: string) => {
    const [g] = await t.owner<
      {
        status: string;
        deleted: boolean;
        released_version: number | null;
        current_version: number;
        connection_id: string | null;
        source: string;
        spec: Record<string, unknown>;
      }[]
    >`
      select i.status, i.deleted_at is not null as deleted, i.released_version, i.current_version, i.connection_id,
        v.source, v.spec
      from app.context_item i
      join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.current_version
      where i.id = ${id}`;
    return g;
  };
  /** The learning a correction opened: its status, source and the corrections it holds. */
  const learning = async (id: string) => {
    const [l] = await t.owner<
      {
        status: string;
        source: string;
        connection_id: string;
        signals: { kind: string; id: string; text: string; runId: string }[];
      }[]
    >`select status, source, connection_id, evidence->'signals' as signals from app.proposal where id = ${id}`;
    return l;
  };

  it("keeps a person's correction as their memory at once, and opens a learning for the team", async () => {
    // A thumbs down used to be stored and never read: the same mistake came back the next day.
    const { runId: corrected } = await answered(alice, "How many paying accounts did we have last month?");
    const text = "Paying accounts are the active subscriptions, not trial accounts. Count them from subscriptions.";
    const r = await giveFeedback(full, as(alice), {
      runId: corrected,
      kind: "down",
      reasonCode: "wrong_definition",
      comment: text,
    });
    const fact = "Paying accounts are the active subscriptions, not trial accounts.";
    expect(r?.correction?.memory?.fact).toBe(fact);
    // Its note, after a reload, reads what was kept: no guide any more, a learning instead.
    expect((await myFeedback(full, as(alice), corrected)).answer?.correction).toEqual({
      text,
      memory: { fact },
      guideId: null,
      learningId: r?.correction?.learningId,
    });
    expect(await facts(alice)).toContain(fact);
    expect(await facts(bob)).not.toContain(fact);
    // The learning waits for the Curator, on the answer's source, with the correction as its evidence.
    const l = await learning(r?.correction?.learningId as string);
    expect(l).toMatchObject({ status: "drafting", source: "curator", connection_id: connectionId });
    expect(l?.signals).toEqual([expect.objectContaining({ kind: "feedback", text, runId: corrected })]);
    // Taking the thumbs back takes back their memory, and its evidence: a learning left with none is discarded.
    expect(await withdrawFeedback(full, as(alice), corrected)).toBe(true);
    expect(await facts(alice)).not.toContain(fact);
    expect(await learning(r?.correction?.learningId as string)).toMatchObject({ status: "discarded", signals: [] });
  });

  it("files a correction under the source its answer read, after the conversation moved to another", async () => {
    const other = uuidv7();
    await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${other}, 'support', 'postgres')`;
    const { runId: first } = await answered(alice, "How many trials converted last quarter?");
    const [{ thread_id: threadId } = { thread_id: "" }] = await t.owner<{ thread_id: string }[]>`
      select thread_id from app.run where id = ${first}`;
    const moved = await submitQuestion(deps, {
      orgId,
      userId: alice,
      threadId,
      connectionId: other,
      text: "And support tickets?",
      channel: "web",
      model: "m",
    });
    await t.owner`update app.run set status = 'succeeded' where id = ${moved.runId}`;
    const r = await giveFeedback(full, as(alice), {
      runId: first,
      kind: "down",
      comment: "Trials that converted within thirty days count as converted.",
    });
    expect((await learning(r?.correction?.learningId as string))?.connection_id).toBe(connectionId);
  });

  it("is changed in place, and undone with the thumbs, the memory and its evidence with it", async () => {
    const { runId: churn } = await answered(alice, "What was churned MRR in September?");
    const first = await giveFeedback(full, as(alice), {
      runId: churn,
      kind: "down",
      comment: "Churned MRR should exclude accounts that came back.",
    });
    const second = await giveFeedback(full, as(alice), {
      runId: churn,
      kind: "down",
      comment: "Churned MRR should exclude accounts that came back within 30 days.",
    });
    // One memory, and the learning holds the changed words only.
    expect(await facts(alice)).toContain("Churned MRR should exclude accounts that came back within 30 days.");
    expect(await facts(alice)).not.toContain("Churned MRR should exclude accounts that came back.");
    const changed = await learning(second?.correction?.learningId as string);
    expect(changed?.signals.map((s) => s.text)).toEqual([
      "Churned MRR should exclude accounts that came back within 30 days.",
    ]);
    expect((await learning(first?.correction?.learningId as string))?.status).toBe("discarded");
    // A thumbs up instead: the memory and the evidence go.
    await giveFeedback(full, as(alice), { runId: churn, kind: "up" });
    expect(await facts(alice)).not.toContain("Churned MRR should exclude accounts that came back within 30 days.");
    expect((await learning(second?.correction?.learningId as string))?.status).toBe("discarded");
    // A thumbs down that says nothing, or too little to be a correction, keeps nothing: the admins read it.
    expect((await giveFeedback(full, as(alice), { runId: churn, kind: "down" }))?.correction).toBeUndefined();
    const short = await giveFeedback(full, as(alice), { runId: churn, kind: "down", comment: "Wrong number" });
    expect(short?.correction).toBeUndefined();
    expect((await myFeedback(full, as(alice), churn)).answer).toMatchObject({
      comment: "Wrong number",
      correction: null,
    });
  });

  it("remembers what it should have said, not the word that says it was wrong", async () => {
    const { runId: wrong } = await answered(alice, "How many active customers?");
    const r = await giveFeedback(full, as(alice), {
      runId: wrong,
      kind: "down",
      comment: "Wrong. Active customers are the ones with a login in the last 30 days.",
    });
    expect(r?.correction?.memory?.fact).toBe("Wrong. Active customers are the ones with a login in the last 30 days.");
  });

  it("never undoes a memory the person already had", async () => {
    const { runId: plans } = await answered(alice, "Which plans grew?");
    const own = "Plans means the paid plans only.";
    await withUser(orgId, alice, (tx) => rememberFact(tx, as(alice), { fact: own }));
    await giveFeedback(full, as(alice), { runId: plans, kind: "down", comment: own });
    await withdrawFeedback(full, as(alice), plans);
    expect(await facts(alice)).toContain(own);
  });

  it("lets 'add it to your memory' keep what the person wrote earlier in the conversation, nothing else", async () => {
    // After the person's own correction, "add it to your memory" used to be refused.
    const first = await submitQuestion(deps, {
      orgId,
      userId: alice,
      connectionId,
      text: "No, paying accounts are the active subscriptions, not trial accounts.",
      channel: "web",
      model: "m",
    });
    await t.owner`
      insert into app.message (org_id, id, thread_id, run_id, seq, role, content, text)
      values (${orgId}, ${uuidv7()}, ${first.threadId}, ${first.runId}, 99, 'assistant', ${t.owner.json([])},
        'Got it. Also, always report revenue in USD.')`;
    const said = await withUser(orgId, alice, (tx) => ownWordsInThread(tx, as(alice), first.threadId));
    const ask = "Add it to your memory";
    expect(askedToRemember(ask, "Paying accounts are the active subscriptions, not trial accounts.", said)).toBe(true);
    // The analyst's words, and someone else's, aren't theirs.
    expect(askedToRemember(ask, "Always report revenue in USD.", said)).toBe(false);
    expect(await withUser(orgId, bob, (tx) => ownWordsInThread(tx, as(bob), first.threadId))).toEqual([]);
    // Other ways of asking; "memory" only as where to put it.
    for (const q of [
      "Keep that in mind",
      "Please note this for next time",
      "Save that to your memory",
      "Memorize this",
    ]) {
      expect(askedToRemember(q, "Paying accounts are active subscriptions", said)).toBe(true);
    }
    for (const q of [
      "How many paying accounts were added?",
      "What's the memory usage of the warehouse?",
      "Save that as a dashboard",
    ]) {
      expect(askedToRemember(q, "Paying accounts are active subscriptions", said)).toBe(false);
    }
    // A planted instruction pieced together from words of different messages of theirs isn't one they wrote.
    const two = ["Exclude test accounts from the dashboard.", "Always report revenue in EUR."];
    expect(askedToRemember(ask, "Always exclude revenue", two)).toBe(false);
    expect(askedToRemember(ask, "Always report revenue in EUR", two)).toBe(true);
  });
});

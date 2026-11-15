// Learning from corrections, on Postgres, with no model: a correction someone may share opens its topic's
// learning, or joins it; the Curator's proposal (its outcome written here, as its run would end) becomes a proposed
// term, checked on the data and tested by a run given that unreleased term alone; the rule releases it only when all
// five of its predicates hold, otherwise an approver taps once; Revert and Reject undo it; a taken-back correction
// leaves. The tables are the case in miniature: a table of trial accounts, which aren't paying ones, and memberships
// whose status 'active' makes an account a paying one.
import { uuidv7 } from "@opendash/db";
import { withSystemOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveContext,
  approveLearning,
  ContextProblem,
  type CuratorOutcome,
  checkLearning,
  contextForRun,
  decideLearning,
  editLearning,
  ensureSuite,
  executeEvalCase,
  gradeLearningTest,
  gradeReads,
  learningsForRun,
  listLearnings,
  memoryRoom,
  rejectLearning,
  rememberFact,
  revertLearning,
  runQuery,
  saveTerm,
  settleLearning,
  signalCorrection,
  startDueLearnings,
  startLearningTest,
  suggestLearning,
  syncCases,
  topicKey,
  withdrawSignal,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const SETUP = `
  create table public.trial_accounts (trial_id int primary key, trial_name text, converted boolean);
  insert into public.trial_accounts select g, 'Trial ' || g, false from generate_series(1, 12) g;
  create table public.memberships (id int primary key, account_name text, status text);
  insert into public.memberships
    select g, 'Account ' || g, case when g % 3 = 0 then 'active' else 'canceled' end from generate_series(1, 30) g;`;

let s: LearnedSource;
const admin = uuidv7();
const priya = uuidv7();
const ben = uuidv7();
const vera = uuidv7();
const keys = { anthropic: true, openai: false, google: false } as never;
const system = { withSystem: <T>(fn: Parameters<typeof withSystemOn<T>>[1]) => withSystemOn(s.t.system, fn) };

beforeAll(async () => {
  s = await learnedSource({ setup: SETUP });
  for (const [id, role, name] of [
    [admin, "owner", "Ada Admin"],
    [priya, "member", "Priya Raman"],
    [ben, "member", "Ben Ito"],
    [vera, "viewer", "Vera Viewer"],
  ] as const) {
    await s.t.owner`insert into auth.user (id, name, email, email_verified)
      values (${id}, ${name}, ${`${id}@acme.test`}, true)`;
    await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${s.orgId}, ${id}, ${role}, now())`;
  }
}, 300_000);
afterAll(async () => {
  await s?.close();
});

/** An answer someone got (and corrects): a run in a conversation of their own. */
const answered = async (userId: string) => {
  const threadId = uuidv7();
  const runId = uuidv7();
  const messageId = uuidv7();
  await s.t.owner`insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
    values (${s.orgId}, ${threadId}, ${s.connectionId}, ${userId}, 'Paying accounts', 'web', 'private')`;
  await s.t.owner`insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
    values (${s.orgId}, ${messageId}, ${threadId}, 1, 'user', ${userId}, ${s.t.owner.json({ role: "user", content: "How many paying accounts?" })}, 'How many paying accounts?')`;
  await s.t.owner`insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, status)
    values (${s.orgId}, ${runId}, ${threadId}, ${s.connectionId}, 'user', ${messageId}, 'mock', 'succeeded')`;
  return runId;
};
/** A transaction carrying this person, as their requests are. */
const as = <T>(userId: string, fn: Parameters<typeof withTenantOn<T>>[2]) =>
  withTenantOn(s.t.app, { orgId: s.orgId, userId }, fn);
const proposal = async (id: string) =>
  (
    await s.t.owner<
      { status: string; run_id: string | null; dedupe_key: string | null; evidence: Record<string, unknown> }[]
    >`
      select status, run_id, dedupe_key, evidence from app.proposal where id = ${id}`
  )[0];
// It says the synonym the term would answer to as well: what's released is what was said.
const PAYING = "paying accounts means the active memberships, not the trial accounts; paying customers too";
const LEARNED: NonNullable<CuratorOutcome["learning"]> = {
  term: "Paying accounts",
  means: "The accounts with an active membership.",
  synonyms: ["paying customers"],
  column: "public.memberships.status",
  values: ["active"],
  not: ["public.trial_accounts"],
  quote: "paying accounts means the active memberships",
  question: "How many paying accounts do we have?",
};
/** The Curator started on due learnings, and its run ended with this outcome: settled. */
const curated = async (proposalId: string, outcome: CuratorOutcome) => {
  await startDueLearnings({ ...system, withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: keys });
  const p = await proposal(proposalId);
  expect(p?.run_id).toBeTruthy();
  await s.t.owner`update app.run set status = 'succeeded', outcome = ${s.t.owner.json(outcome as never)}
    where id = ${p?.run_id as string}`;
  return settleLearning({ withTenant: s.deps.withTenant, boss: null }, s.orgId, p?.run_id as string);
};
/** A learning's test run as the analyst would end it: its queries (through the gateway) and its answer. */
const tested = async (proposalId: string, sql: string, interpretation: string[]) => {
  const runId = await startLearningTest({ withTenant: s.deps.withTenant, deploymentKeys: keys }, s.orgId, proposalId);
  expect(runId).toBeTruthy();
  await runQuery(s.deps, {
    orgId: s.orgId,
    connectionId: s.connectionId,
    sql,
    mode: "execute",
    requester: { type: "run", id: runId as string },
  });
  await s.t.owner`update app.run set status = 'succeeded', outcome = ${s.t.owner.json({
    kind: "answer",
    status: "answered",
    interpretation,
  } as never)} where id = ${runId as string}`;
  return { runId: runId as string, test: await gradeLearningTest(s.deps, s.orgId, proposalId) };
};

describe("a correction becomes a learning", () => {
  it("opens one per topic: a second correction about it joins, the same one twice counts once", async () => {
    const run = await answered(priya);
    const first = await as(priya, (tx) =>
      signalCorrection(
        tx,
        { orgId: s.orgId, userId: priya },
        {
          kind: "feedback",
          id: uuidv7(),
          text: PAYING,
          runId: run,
          connectionId: s.connectionId,
          about: "Paying accounts",
        },
      ),
    );
    const again = {
      kind: "feedback" as const,
      id: uuidv7(),
      text: "paying accounts are active members",
      runId: run,
      connectionId: s.connectionId,
      about: "paying account",
    };
    const joined = await as(ben, (tx) => signalCorrection(tx, { orgId: s.orgId, userId: ben }, again));
    expect(joined).toEqual({ proposalId: first?.proposalId, joined: true });
    await as(ben, (tx) => signalCorrection(tx, { orgId: s.orgId, userId: ben }, again));
    const p = await proposal(first?.proposalId as string);
    expect(p?.dedupe_key).toBe(topicKey("Paying accounts"));
    const signals = (p?.evidence.signals ?? []) as { kind: "feedback"; id: string; userId: string }[];
    expect(signals).toHaveLength(2);
    // Someone who can't approve sees only their own correction on the card; an approver sees both.
    const card = (approver: boolean) =>
      as(ben, (tx) => learningsForRun(tx, { orgId: s.orgId, userId: ben, approver }, run));
    expect((await card(false)).map((c) => [c.said.map((x) => x.text), c.people])).toEqual([
      [["paying accounts are active members"], 1],
    ]);
    expect((await card(true))[0]?.said).toHaveLength(2);
    // Taken back, a correction leaves; the last one gone, a learning nobody started on is discarded.
    await as(ben, (tx) => withdrawSignal(tx, s.orgId, again));
    const hers = signals.find((x) => x.userId === priya) as { kind: "feedback"; id: string };
    await as(priya, (tx) => withdrawSignal(tx, s.orgId, hers));
    expect((await proposal(first?.proposalId as string))?.status).toBe("discarded");
  });
});

describe("from the Curator's proposal to the team's glossary", () => {
  it("keeps it as a proposed term, checks it, tests it given that term alone, and the rule releases it for an approver's 👎", async () => {
    const run = await answered(admin);
    const opened = await as(admin, (tx) =>
      signalCorrection(
        tx,
        { orgId: s.orgId, userId: admin },
        {
          kind: "feedback",
          id: uuidv7(),
          text: `No, ${PAYING}`,
          runId: run,
          connectionId: s.connectionId,
          about: "paying accounts",
        },
      ),
    );
    const id = opened?.proposalId as string;
    expect((await curated(id, { kind: "curator", status: "proposed", learning: LEARNED }))?.next).toBe("evaluate");
    const p = await proposal(id);
    expect(p).toMatchObject({ status: "evaluating", evidence: expect.objectContaining({ quoteOk: true }) });
    const termId = p?.evidence.termId as string;
    // Not released: no analyst reads it, except a test run given it.
    const plain = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(plain.terms.map((t) => t.spec.term)).not.toContain("Paying accounts");
    const given = await s.tenant((tx) =>
      contextForRun(tx, s.orgId, s.connectionId, { itemId: termId, version: p?.evidence.termVersion as number }),
    );
    expect(given.terms.find((t) => t.spec.term === "Paying accounts")?.spec).toMatchObject({
      maps_to: { column: "public.memberships.status", values: ["active"] },
      not: ["public.trial_accounts"],
      learned: { proposalId: id },
    });
    // The check: active memberships exist (ten of them), its query kept as proof.
    expect(await checkLearning(s.deps, s.orgId, id)).toMatchObject({ ok: true, rows: 10 });
    // The test: the run read the right table with the right filter, and said it applied the term.
    const { test } = await tested(id, "select count(*) from public.memberships where status = 'active'", [
      "Paying accounts = the accounts with an active membership (Glossary)",
    ]);
    expect(test).toMatchObject({ ok: true, used: true });
    // All five hold (an owner said it): released by the rule, and every analyst reads it now.
    expect(await decideLearning(s.deps, s.orgId, id)).toEqual({ automatic: true, missing: [] });
    expect((await proposal(id))?.status).toBe("approved");
    const now = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(now.terms.map((t) => t.spec.term)).toContain("Paying accounts");
    // Its card under the answer, for an approver; Revert takes it back, and the analyst no longer reads it.
    const [card] = await s.tenant((tx) => learningsForRun(tx, { orgId: s.orgId, userId: admin, approver: true }, run));
    expect(card).toMatchObject({ status: "approved", automatic: true, term: "Paying accounts", people: 1 });
    expect(await s.tenant((tx) => learningsForRun(tx, { orgId: s.orgId, userId: ben, approver: false }, run))).toEqual(
      [],
    );
    // Released again since (an admin's edit): reverting would undo that too, so it's refused and the term stays.
    const [released] = await s.t.owner<{ v: number }[]>`
      select released_version as v from app.context_item where id = ${termId}`;
    const v = released?.v as number;
    await s.t.owner`insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
      select org_id, item_id, ${v + 1}, body, body_hash || '-edited', spec, 'user'
      from app.context_item_version where item_id = ${termId} and version = ${v}`;
    await s.t.owner`update app.context_item set released_version = ${v + 1}, current_version = ${v + 1}
      where id = ${termId}`;
    expect(await s.tenant((tx) => revertLearning(tx, { orgId: s.orgId, userId: admin }, id))).toBe("superseded");
    const kept = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(kept.terms.map((t) => t.spec.term)).toContain("Paying accounts");
    expect((await proposal(id))?.status).toBe("approved");
    // The edit taken back, its own version released again: Revert takes it back.
    await s.t.owner`update app.context_item set released_version = ${v}, current_version = ${v} where id = ${termId}`;
    await s.t.owner`delete from app.context_item_version where item_id = ${termId} and version = ${v + 1}`;
    expect(await s.tenant((tx) => revertLearning(tx, { orgId: s.orgId, userId: admin }, id))).toBe("reverted");
    const after = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(after.terms.map((t) => t.spec.term)).not.toContain("Paying accounts");
    expect((await proposal(id))?.status).toBe("reverted");
    // Reverted once, it can't be again.
    expect(await s.tenant((tx) => revertLearning(tx, { orgId: s.orgId, userId: admin }, id))).toBe("not_found");
  });

  it("waits for a tap when one person who can't approve said it, or its test read the wrong table", async () => {
    const run = await answered(priya);
    const opened = await as(priya, (tx) =>
      signalCorrection(
        tx,
        { orgId: s.orgId, userId: priya },
        {
          kind: "suggestion",
          id: uuidv7(),
          text: PAYING,
          runId: run,
          connectionId: s.connectionId,
          about: "Paying accounts",
        },
      ),
    );
    const id = opened?.proposalId as string;
    await curated(id, { kind: "curator", status: "proposed", learning: LEARNED });
    await checkLearning(s.deps, s.orgId, id);
    const { test } = await tested(id, "select count(*) from public.trial_accounts", ["Counted the trial accounts"]);
    expect(test).toMatchObject({ ok: false, used: false, why: "It read public.trial_accounts." });
    expect(await decideLearning(s.deps, s.orgId, id)).toEqual({
      automatic: false,
      missing: ["its test passed and used it", "said by an approver or two people"],
    });
    expect((await proposal(id))?.status).toBe("open");
    // Priya sees her own; an approver taps once.
    const [mine] = await s.tenant((tx) => learningsForRun(tx, { orgId: s.orgId, userId: priya, approver: false }, run));
    expect(mine).toMatchObject({ status: "open", mine: true, check: { ok: true } });
    expect(await s.tenant((tx) => approveLearning(tx, { orgId: s.orgId, userId: admin }, id))).toBe(true);
    expect((await proposal(id))?.status).toBe("approved");
    expect((await s.tenant((tx) => listLearnings(tx, { orgId: s.orgId, userId: admin }))).map((l) => l.id)).toContain(
      id,
    );
  });

  it("refuses the rule for a term that names a verified metric, and Reject takes its proposed version away", async () => {
    // A released metric called MRR: a learning called MRR could move a verified number.
    const metric = uuidv7();
    await s.t.owner`insert into app.context_item (org_id, id, kind, scope, path, slug, title, status, current_version,
        released_version)
      values (${s.orgId}, ${metric}, 'metric', 'org', '/metrics/mrr.yaml', 'mrr', 'Monthly recurring revenue', 'verified', 1, 1)`;
    await s.t.owner`insert into app.context_item_version (org_id, item_id, version, body, body_hash, spec, source)
      values (${s.orgId}, ${metric}, 1, 'metric: mrr', 'x', ${s.t.owner.json({ synonyms: ["MRR"] })}, 'user')`;
    const run = await answered(admin);
    const opened = await as(admin, (tx) =>
      signalCorrection(
        tx,
        { orgId: s.orgId, userId: admin },
        {
          kind: "feedback",
          id: uuidv7(),
          text: "MRR means the plans table rows, not the subscriptions",
          runId: run,
          connectionId: s.connectionId,
          about: "MRR",
        },
      ),
    );
    const id = opened?.proposalId as string;
    await curated(id, {
      kind: "curator",
      status: "proposed",
      learning: { ...LEARNED, term: "MRR", synonyms: [], quote: "MRR means the plans table rows" },
    });
    await checkLearning(s.deps, s.orgId, id);
    await tested(id, "select count(*) from public.memberships where status = 'active'", ["MRR (Glossary)"]);
    const decided = await decideLearning(s.deps, s.orgId, id);
    expect(decided?.missing).toContain("a low-risk kind");
    expect(await s.tenant((tx) => rejectLearning(tx, { orgId: s.orgId, userId: admin }, id, "Not what MRR is."))).toBe(
      true,
    );
    const [term] = await s.t.owner<{ deleted: boolean }[]>`
      select deleted_at is not null as deleted from app.context_item where id = ${(await proposal(id))?.evidence.termId as string}`;
    expect(term?.deleted).toBe(true);
  });

  it("says why when there's nothing to learn, and fails one whose column isn't the source's", async () => {
    const run = await answered(admin);
    const signal = (text: string, about: string) =>
      as(admin, (tx) =>
        signalCorrection(
          tx,
          { orgId: s.orgId, userId: admin },
          {
            kind: "feedback",
            id: uuidv7(),
            text,
            runId: run,
            connectionId: s.connectionId,
            about,
          },
        ),
      );
    const nothing = await signal("this answer was too slow", "slow");
    await curated(nothing?.proposalId as string, {
      kind: "curator",
      status: "discarded",
      reason: "A complaint, not a meaning.",
    });
    expect((await proposal(nothing?.proposalId as string))?.status).toBe("discarded");
    const wrong = await signal("pipelines are the sales stages", "pipelines");
    await curated(wrong?.proposalId as string, {
      kind: "curator",
      status: "proposed",
      learning: {
        ...LEARNED,
        term: "Pipelines",
        column: "public.nothing_here.status",
        quote: "pipelines are the sales stages",
      },
    });
    expect(await proposal(wrong?.proposalId as string)).toMatchObject({
      status: "failed",
      evidence: expect.objectContaining({ failed: "public.nothing_here.status isn't a column of that source." }),
    });
  });
});

describe("what the rule never does on its own", () => {
  const signal = (userId: string, kind: "feedback" | "memory" | "suggestion", text: string, about: string) =>
    answered(userId).then((run) =>
      as(userId, (tx) =>
        signalCorrection(
          tx,
          { orgId: s.orgId, userId },
          {
            kind,
            id: uuidv7(),
            text,
            runId: run,
            connectionId: s.connectionId,
            about,
          },
        ),
      ),
    );
  const through = async (id: string, learning: NonNullable<CuratorOutcome["learning"]>) => {
    await curated(id, { kind: "curator", status: "proposed", learning });
    await checkLearning(s.deps, s.orgId, id);
    await tested(id, "select count(*) from public.memberships where status = 'active'", [
      `${learning.term} = the active memberships (Glossary)`,
    ]);
    return decideLearning(s.deps, s.orgId, id);
  };
  const PIPES = { ...LEARNED, term: "Pipelines", synonyms: [], quote: "pipelines are the active memberships" };

  it("doesn't count an approver's chat correction, which the analyst judged one, as the approver saying it", async () => {
    const opened = await signal(admin, "memory", "No, pipelines are the active memberships", "pipelines");
    const decided = await through(opened?.proposalId as string, PIPES);
    expect(decided).toEqual({ automatic: false, missing: ["said by an approver or two people"] });
  });

  it("releases on two people's own corrections, approved by no one, and only when each names the term", async () => {
    const opened = await signal(priya, "feedback", "Streams are the active memberships, not the trials", "streams");
    await signal(ben, "suggestion", "the dashboard was slow", "streams");
    const STREAMS = { ...LEARNED, term: "Streams", synonyms: [], quote: "Streams are the active memberships" };
    // Ben's doesn't say "streams": one person said it.
    expect(await through(opened?.proposalId as string, STREAMS)).toEqual({
      automatic: false,
      missing: ["said by an approver or two people"],
    });
    await signal(ben, "suggestion", "streams means the active memberships", "streams");
    expect(await decideLearning(s.deps, s.orgId, opened?.proposalId as string)).toEqual({
      automatic: true,
      missing: [],
    });
    const [term] = await s.t.owner<{ verified_by: string | null; released: number | null }[]>`
      select verified_by, released_version as released from app.context_item
      where org_id = ${s.orgId} and kind = 'term' and title = 'Streams'`;
    expect(term).toEqual({ verified_by: null, released: 1 });
  });

  it("goes back, on Revert, to a version as nobody approved it when the rule released it", async () => {
    const ROOMS = { ...LEARNED, term: "Rooms", synonyms: [], quote: "rooms are the active memberships" };
    const first = await signal(priya, "feedback", "No, rooms are the active memberships", "rooms");
    await signal(ben, "feedback", "rooms are the active memberships, I checked", "rooms");
    expect(await through(first?.proposalId as string, ROOMS)).toEqual({ automatic: true, missing: [] });
    // A change to it waits for a tap; an approver's tap releases it as theirs.
    const second = await signal(priya, "feedback", "No, rooms are the active memberships, always", "rooms");
    await through(second?.proposalId as string, { ...ROOMS, quote: "rooms are the active memberships, always" });
    expect(
      await s.tenant((tx) => approveLearning(tx, { orgId: s.orgId, userId: admin }, second?.proposalId as string)),
    ).toBe(true);
    const learned = async () =>
      (await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId))).terms.find((t) => t.spec.term === "Rooms")
        ?.learned;
    expect(await learned()).toBe(false);
    // Reverted: the rule's version again, given as learned, never with the approval its successor had.
    expect(
      await s.tenant((tx) => revertLearning(tx, { orgId: s.orgId, userId: admin }, second?.proposalId as string)),
    ).toBe("reverted");
    expect(await learned()).toBe(true);
  });

  it("counts only members who may correct, and only what the people counted said themselves", async () => {
    const decide = (id: string) => decideLearning(s.deps, s.orgId, id);
    // A viewer's correction, or one by someone gone since, doesn't make a second person.
    const LANES = { ...LEARNED, term: "Lanes", synonyms: [], quote: "lanes are the active memberships" };
    const lanes = await signal(priya, "feedback", "No, lanes are the active memberships", "lanes");
    await signal(vera, "feedback", "lanes are the active memberships, really", "lanes");
    expect(await through(lanes?.proposalId as string, LANES)).toEqual({
      automatic: false,
      missing: ["said by an approver or two people"],
    });
    // An approver's 👎 that only names the term never releases a member's statement as the approver's: it's two
    // people naming it, released by the rule, approved by no one (and given as learned).
    const TIERS = { ...LEARNED, term: "Tiers", synonyms: [], quote: "tiers are the active memberships" };
    const tiers = await signal(priya, "feedback", "No, tiers are the active memberships", "tiers");
    await signal(admin, "feedback", "the tiers chart is too small", "tiers");
    expect(await through(tiers?.proposalId as string, TIERS)).toEqual({ automatic: true, missing: [] });
    const [tier] = await s.t.owner<{ verified_by: string | null }[]>`
      select verified_by from app.context_item where org_id = ${s.orgId} and kind = 'term' and title = 'Tiers'`;
    expect(tier?.verified_by).toBeNull();
    expect(
      (await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId))).terms.find((t) => t.spec.term === "Tiers"),
    ).toMatchObject({ learned: true });
    // A synonym the Curator added and nobody said: it waits for a tap, even for the approver who said the rest.
    const SEATS = { ...LEARNED, term: "Seats", synonyms: ["licences"], quote: "seats are the active memberships" };
    const seats = await signal(admin, "feedback", "No, seats are the active memberships", "seats");
    expect(await through(seats?.proposalId as string, SEATS)).toEqual({
      automatic: false,
      missing: ["stated, synonyms too, by the people who said it"],
    });
    await signal(admin, "feedback", "seats are the active memberships; licences too", "seats");
    expect(await decide(seats?.proposalId as string)).toEqual({ automatic: true, missing: [] });
  });

  it("never changes a term the team already uses, and never takes a quote stitched from scattered words", async () => {
    // Paying accounts is released (an earlier test's tap): a learning that changes it waits for one.
    await s.t.owner`update app.context_item set released_version = current_version, status = 'verified'
      where org_id = ${s.orgId} and kind = 'term' and title = 'Paying accounts'`;
    const opened = await signal(
      admin,
      "feedback",
      "paying accounts means the active memberships, always",
      "paying accounts",
    );
    const decided = await through(opened?.proposalId as string, {
      ...LEARNED,
      quote: "paying accounts means the active memberships",
    });
    expect(decided?.missing).toContain("a new term, not a change to one the team uses");
    // Words picked from here and there in a correction aren't anyone's statement.
    const stitched = await signal(
      admin,
      "feedback",
      "Cohorts? not the canceled ones, the active memberships matter, active only",
      "cohorts",
    );
    const out = await through(stitched?.proposalId as string, {
      ...LEARNED,
      term: "Cohorts",
      synonyms: [],
      quote: "Cohorts the active memberships",
    });
    expect(out?.missing).toContain("stated outright");
  });
});

describe("what the rule never does, by another name", () => {
  const signal = (text: string, about: string) =>
    answered(admin).then((run) =>
      as(admin, (tx) =>
        signalCorrection(
          tx,
          { orgId: s.orgId, userId: admin },
          {
            kind: "feedback",
            id: uuidv7(),
            text,
            runId: run,
            connectionId: s.connectionId,
            about,
          },
        ),
      ),
    );
  const through = async (id: string, learning: NonNullable<CuratorOutcome["learning"]>) => {
    await curated(id, { kind: "curator", status: "proposed", learning });
    await checkLearning(s.deps, s.orgId, id);
    await tested(id, "select count(*) from public.memberships where status = 'active'", [
      `${learning.term} = the active memberships (Glossary)`,
    ]);
    return decideLearning(s.deps, s.orgId, id);
  };

  it("finds the team's term by its topic or a synonym, and leaves it to an approver", async () => {
    // A released term with a synonym.
    const released = await s.tenant((tx) =>
      saveTerm(
        tx,
        { orgId: s.orgId, userId: admin },
        {
          body: "term: Jobs\nmeans: The scheduled report runs.\nsynonyms: [scheduled runs]\n",
        },
      ),
    );
    await s.tenant((tx) => approveContext(tx, { orgId: s.orgId, userId: admin }, [{ id: released.id, version: 1 }]));
    // Named like its synonym: it's that term, changed, not a new one.
    const opened = await signal("scheduled runs means the active memberships, always", "scheduled runs");
    const decided = await through(opened?.proposalId as string, {
      ...LEARNED,
      term: "Scheduled runs",
      synonyms: [],
      quote: "scheduled runs means the active memberships",
    });
    expect(decided?.missing).toContain("a new term, not a change to one the team uses");
    const p = await proposal(opened?.proposalId as string);
    expect(p?.evidence.termId).toBe(released.id);
  });

  it("checks the synonyms of the version it would release, a draft's kept ones too", async () => {
    // An unreleased draft with a synonym nobody here said: a learning about it keeps that synonym.
    await s.tenant((tx) =>
      saveTerm(
        tx,
        { orgId: s.orgId, userId: admin },
        { body: "term: Desks\nmeans: The desks booked.\nsynonyms: [workstations]\n" },
      ),
    );
    const opened = await signal("desks are the active memberships, nothing else", "desks");
    expect(
      await through(opened?.proposalId as string, {
        ...LEARNED,
        term: "Desks",
        synonyms: [],
        quote: "desks are the active memberships",
      }),
    ).toEqual({ automatic: false, missing: ["stated, synonyms too, by the people who said it"] });
  });

  it("checks every name the version would answer to, a draft's own name too", async () => {
    // A draft found by its synonym keeps its own name: released, it would be "Offices", which nobody here said.
    await s.tenant((tx) =>
      saveTerm(
        tx,
        { orgId: s.orgId, userId: admin },
        { body: "term: Offices\nmeans: The offices booked.\nsynonyms: [cubicles]\n" },
      ),
    );
    const opened = await signal("cubicles are the active memberships, nothing else", "cubicles");
    expect(
      await through(opened?.proposalId as string, {
        ...LEARNED,
        term: "Cubicles",
        synonyms: [],
        quote: "cubicles are the active memberships",
      }),
    ).toEqual({ automatic: false, missing: ["stated, synonyms too, by the people who said it"] });
  });

  it("needs the quote to say the values it maps to", async () => {
    const opened = await signal("Tasks are the paid memberships, the current ones", "tasks");
    const decided = await through(opened?.proposalId as string, {
      ...LEARNED,
      term: "Tasks",
      synonyms: [],
      quote: "Tasks are the paid memberships",
    });
    expect(decided?.missing).toContain("stated outright");
  });
});

describe("Suggest for the team", () => {
  it("shares someone's own correction, kept as their memory, with the team's learning about it", async () => {
    const corrected = await answered(ben);
    const [r] = await s.t.owner<{ thread_id: string }[]>`select thread_id from app.run where id = ${corrected}`;
    const reply = uuidv7();
    const msg = uuidv7();
    await s.t.owner`insert into app.message (org_id, id, thread_id, seq, role, author_id, content, text)
      values (${s.orgId}, ${msg}, ${r?.thread_id as string}, 2, 'user', ${ben}, ${s.t.owner.json({ role: "user", content: "x" })}, 'x')`;
    await s.t
      .owner`insert into app.run (org_id, id, thread_id, connection_id, trigger, input_message_id, model, status, queued_at)
      values (${s.orgId}, ${reply}, ${r?.thread_id as string}, ${s.connectionId}, 'user', ${msg}, 'mock', 'succeeded', now() + interval '1 second')`;
    const who = { orgId: s.orgId, userId: ben };
    const kept = await as(ben, (tx) =>
      rememberFact(tx, who, { fact: "Seats means paid seats", why: "correction", about: "seats", runId: reply }),
    );
    const shared = await as(ben, (tx) => suggestLearning(tx, who, kept.id));
    const p = await proposal(shared?.proposalId as string);
    expect(p?.evidence.signals).toEqual([
      expect.objectContaining({
        kind: "suggestion",
        text: "Seats means paid seats",
        runId: corrected,
        fromRunId: reply,
      }),
    ]);
    // Only one's own: someone else's memory id shares nothing.
    expect(await as(priya, (tx) => suggestLearning(tx, { orgId: s.orgId, userId: priya }, kept.id))).toBeNull();
  });
});

describe("a released learning's case, in the workspace's evals", () => {
  it("joins the suite, stays across syncs, and is graded on what the answer read", async () => {
    // Earlier tests released learnings (Paying accounts by a tap, Streams by the rule): each is a case now.
    const cases = await s.tenant((tx) => syncCases(tx, s.orgId));
    const learned = cases.filter((c) => c.origin === "correction");
    expect(learned.map((c) => c.question)).toContain("How many paying accounts do we have?");
    const paying = learned.find((c) => c.question === "How many paying accounts do we have?");
    expect(paying?.expect).toEqual({
      reads: "public.memberships",
      compared: { column: "status", values: ["active"] },
      not: ["public.trial_accounts"],
    });
    expect((await s.tenant((tx) => syncCases(tx, s.orgId))).find((c) => c.id === paying?.id)?.active).toBe(true);
    // Run it: the stub analyst's queries go through the gateway, as a real one's do.
    const suite = await s.tenant((tx) => ensureSuite(tx, s.orgId));
    const graded = async (sql: string) => {
      const evalRunId = uuidv7();
      await s.t.owner`insert into app.eval_run (org_id, id, suite_id, model, trigger, status, started_at)
        values (${s.orgId}, ${evalRunId}, ${suite.id}, 'mock', 'manual', 'running', now())`;
      await executeEvalCase(s.deps, { orgId: s.orgId, evalRunId, caseId: paying?.id as string }, async () => {
        const runId = await answered(admin);
        await runQuery(s.deps, {
          orgId: s.orgId,
          connectionId: s.connectionId,
          sql,
          mode: "execute",
          requester: { type: "run", id: runId },
        });
        return { runId, outcome: { kind: "answer", status: "answered", rendered: "…" } as never, usage: {} };
      });
      const [r] = await s.t.owner<{ verdict: string; reason: string }[]>`
        select verdict, diff->>'reason' as reason from app.eval_result where eval_run_id = ${evalRunId}`;
      return r;
    };
    expect(await graded("select count(*) from public.memberships where status = 'active'")).toEqual({
      verdict: "pass",
      reason: "It read public.memberships with status = active.",
    });
    expect(await graded("select count(*) from public.trial_accounts")).toEqual({
      verdict: "fail",
      reason: "It read public.trial_accounts.",
    });
  });
});

describe("grading what an answer read", () => {
  const expect_ = {
    reads: "public.memberships",
    compared: { column: "status", values: ["active"] },
    not: ["public.trial_accounts"],
  };
  it("passes the right table and filter, and says why otherwise", () => {
    expect(
      gradeReads(expect_, [
        {
          tables: ["public.memberships"],
          compared: [{ table: "public.memberships", column: "status", values: ["ACTIVE"] }],
        },
      ]),
    ).toEqual({ ok: true });
    expect(gradeReads(expect_, [{ tables: ["public.memberships"], compared: [] }])).toEqual({
      ok: false,
      why: "It didn't keep to status = active.",
    });
    expect(gradeReads(expect_, [{ tables: ["public.memberships", "public.trial_accounts"], compared: [] }]).why).toBe(
      "It read public.trial_accounts.",
    );
  });
});

describe("an approver's change before the tap", () => {
  it("drops a synonym naming a table; an edit is checked and tested again, and waits for the tap", async () => {
    const run = await answered(priya);
    const said = "lapsed accounts are the canceled ones, kept in memberships";
    const opened = await as(priya, (tx) =>
      signalCorrection(
        tx,
        { orgId: s.orgId, userId: priya },
        {
          kind: "feedback",
          id: uuidv7(),
          text: said,
          runId: run,
          connectionId: s.connectionId,
          about: "Lapsed accounts",
        },
      ),
    );
    const id = opened?.proposalId as string;
    await curated(id, {
      kind: "curator",
      status: "proposed",
      learning: {
        term: "Lapsed accounts",
        means: "The accounts whose membership was canceled.",
        synonyms: ["memberships", "former members"],
        column: "public.memberships.status",
        values: ["canceled"],
        not: ["public.trial_accounts"],
        quote: "lapsed accounts are the canceled ones",
        question: "How many lapsed accounts are there?",
      },
    });
    // The table's own name isn't kept as a synonym: every question about the table would get the filter.
    const settled = await proposal(id);
    expect(settled?.evidence.learning).toMatchObject({ synonyms: ["former members"] });
    expect(await checkLearning(s.deps, s.orgId, id)).toMatchObject({ ok: true });
    await tested(id, "select count(*) from public.memberships where status = 'canceled'", [
      "Lapsed accounts = the canceled memberships (Glossary)",
    ]);
    expect((await decideLearning(s.deps, s.orgId, id))?.automatic).toBe(false);
    const [card] = await s.tenant((tx) => learningsForRun(tx, { orgId: s.orgId, userId: admin, approver: true }, run));
    expect(card).toMatchObject({ status: "open", synonyms: ["former members"], edited: false });

    // A column the source doesn't have is refused, and nothing changes.
    await expect(
      as(admin, (tx) =>
        editLearning({ boss: null }, tx, { orgId: s.orgId, userId: admin }, id, { column: "public.nope.version" }),
      ),
    ).rejects.toBeInstanceOf(ContextProblem);
    expect((await proposal(id))?.status).toBe("open");

    // The owner's change: a new proposed version, checked and tested again, theirs to tap.
    const before = (await proposal(id))?.evidence.termVersion as number;
    expect(
      await as(admin, (tx) =>
        editLearning({ boss: null }, tx, { orgId: s.orgId, userId: admin }, id, {
          synonyms: ["former members", "former customers"],
          means: "The former customers, whose membership was canceled.",
        }),
      ),
    ).toBe(true);
    const edited = await proposal(id);
    expect(edited?.status).toBe("evaluating");
    expect(edited?.evidence).toMatchObject({ edited: { by: admin }, termVersion: before + 1 });
    expect(edited?.evidence).not.toHaveProperty("check");
    expect(edited?.evidence).not.toHaveProperty("test");
    expect(await checkLearning(s.deps, s.orgId, id)).toMatchObject({ ok: true });
    await tested(id, "select count(*) from public.memberships where status = 'canceled'", [
      "Lapsed accounts = the former customers' canceled memberships (Glossary)",
    ]);
    expect((await decideLearning(s.deps, s.orgId, id))?.missing).toContain(
      "changed by an approver, so it waits for their tap",
    );
    expect(await as(admin, (tx) => approveLearning(tx, { orgId: s.orgId, userId: admin }, id))).toBe(true);
    const now = await s.tenant((tx) => contextForRun(tx, s.orgId, s.connectionId));
    expect(now.terms.find((t) => t.spec.term === "Lapsed accounts")?.spec).toMatchObject({
      means: "The former customers, whose membership was canceled.",
      synonyms: ["former members", "former customers"],
      maps_to: { column: "public.memberships.status", values: ["canceled"] },
    });
    // Released, it can't be changed this way any more.
    expect(
      await as(admin, (tx) =>
        editLearning({ boss: null }, tx, { orgId: s.orgId, userId: admin }, id, { synonyms: [] }),
      ),
    ).toBe(false);
  });
});

describe("where memories are used", () => {
  it("only for a run its asker asked privately, on the web or in a Slack DM", async () => {
    await s.t.owner`insert into app.slack_workspace (org_id, team_id, team_name, bot_user_id)
      values (${s.orgId}, 'T0ACME', 'Acme', 'U0BOT')`;
    const room = async (channel: string, visibility: string, trigger: string, slack?: string) => {
      const thread = uuidv7();
      const run = uuidv7();
      await s.t.owner`insert into app.thread (org_id, id, connection_id, created_by, title, channel, visibility)
        values (${s.orgId}, ${thread}, ${s.connectionId}, ${priya}, 'Churn', ${channel}, ${visibility})`;
      await s.t.owner`insert into app.run (org_id, id, thread_id, connection_id, profile, model, status, trigger)
        values (${s.orgId}, ${run}, ${thread}, ${s.connectionId}, 'analyst', 'claude-haiku-5-5', 'succeeded', ${trigger})`;
      if (slack) {
        await s.t.owner`insert into app.slack_conversation (org_id, team_id, slack_thread_id, slack_user_id, thread_id)
          values (${s.orgId}, 'T0ACME', ${slack}, 'U0PRIYA', ${thread})`;
      }
      return as(priya, (tx) => memoryRoom(tx, s.orgId, run));
    };
    expect(await room("web", "private", "user")).toBe(true);
    expect(await room("web", "org", "user")).toBe(false);
    // A question sent through the API, even into their own web conversation, isn't them reading the answer there.
    expect(await room("web", "private", "api")).toBe(false);
    expect(await room("slack", "private", "slack", "slack:D0PRIYA:1791700001.000100")).toBe(true);
    // A channel thread is private in OpenDash, but its answers are posted for the channel to read.
    expect(await room("slack", "private", "slack", "slack:C0REV:1791700001.000100")).toBe(false);
    expect(await room("slack", "private", "slack")).toBe(false);
    for (const [channel, trigger] of [
      ["eval", "eval"],
      ["api", "api"],
      ["routine", "routine"],
    ])
      expect(await room(channel as string, "private", trigger as string)).toBe(false);
    expect(await as(priya, (tx) => memoryRoom(tx, s.orgId, "not-a-run"))).toBe(false);
  });
});

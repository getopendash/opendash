// Knowledge → Learnings: one topic per thing, with its meaning, its learnings, the viewer's own memories,
// the guides on its tables, its tests, and for an approver how many answers read a table it isn't. Who sees what.
import { uuidv7 } from "@opendash/db";
import { withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  approveContext,
  getTopic,
  listTopics,
  projectGraph,
  rememberFact,
  saveGuide,
  saveTerm,
  syncCases,
} from "../src";
import { type LearnedSource, learnedSource } from "./helpers/learned-source";

const SETUP = `
  create table public.trial_accounts (trial_id int primary key, trial_name text);
  insert into public.trial_accounts select g, 'Trial ' || g from generate_series(1, 5) g;
  create table public.memberships (id int primary key, account_name text, status text);
  insert into public.memberships select g, 'Account ' || g, case when g % 3 = 0 then 'active' else 'canceled' end
    from generate_series(1, 12) g;`;

let s: LearnedSource;
const ben = uuidv7();
const priya = uuidv7();
beforeAll(async () => {
  s = await learnedSource({ setup: SETUP });
  for (const [id, name] of [
    [ben, "Ben Ito"],
    [priya, "Priya Raman"],
  ] as const) {
    await s.t
      .owner`insert into auth.user (id, name, email, email_verified) values (${id}, ${name}, ${`${id}@acme.test`}, true)`;
    await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
      values (${uuidv7()}, ${s.orgId}, ${id}, 'member', now())`;
  }
}, 300_000);
afterAll(async () => {
  await s?.close();
});

/** The viewer's own transaction (their memories are theirs alone). */
const as = <T>(userId: string, fn: Parameters<typeof withTenantOn<T>>[2]) =>
  withTenantOn(s.t.app, { orgId: s.orgId, userId }, fn);
const owner = { orgId: "", userId: "", approver: true };
const member = (userId: string) => ({ orgId: s.orgId, userId, approver: false });

describe("Knowledge → Learnings", () => {
  beforeAll(async () => {
    Object.assign(owner, { orgId: s.orgId, userId: s.userId });
    const who = { orgId: s.orgId, userId: s.userId };
    const term = await s.tenant((tx) =>
      saveTerm(tx, who, {
        body: "term: Paying accounts\nmeans: The accounts with an active membership.\nmaps_to:\n  column: public.memberships.status\n  values: [active]\nnot: [public.trial_accounts]\n",
        connectionId: s.connectionId,
      }),
    );
    await s.tenant((tx) => approveContext(tx, who, [{ id: term.id, version: term.version }]));
    await s.tenant((tx) =>
      saveGuide(tx, who, {
        title: "Canceled memberships",
        body: "A canceled membership keeps its row.",
        connectionId: s.connectionId,
        table: "public.memberships",
      }),
    );
    // The owner's correction made it the team's; its question is a nightly test.
    const learning = {
      term: "Paying accounts",
      means: "The accounts with an active membership.",
      synonyms: [],
      column: "public.memberships.status",
      values: ["active"],
      not: ["public.trial_accounts"],
      quote: "paying accounts are the active memberships",
      question: "How many paying accounts do we have?",
    };
    const signal = (userId: string) => ({ kind: "feedback", id: uuidv7(), userId, text: "x", runId: null, at: "" });
    await s.t
      .owner`insert into app.proposal (org_id, id, connection_id, kind, source, status, title, evidence, dedupe_key, decided_at)
      values (${s.orgId}, ${uuidv7()}, ${s.connectionId}, 'update', 'curator', 'approved', 'Learning: Paying accounts',
        ${s.t.owner.json({ termId: term.id, termVersion: term.version, learning, signals: [signal(s.userId)] } as never)},
        'term:paying account', now())`;
    // Ben's correction about another word is still being learned.
    await s.t
      .owner`insert into app.proposal (org_id, id, connection_id, kind, source, status, title, evidence, dedupe_key)
      values (${s.orgId}, ${uuidv7()}, ${s.connectionId}, 'update', 'curator', 'evaluating', 'Learning: Lapsed accounts',
        ${s.t.owner.json({ signals: [signal(ben)] } as never)}, 'term:lapsed account')`;
    await s.tenant((tx) => syncCases(tx, s.orgId));
    // Memories, each its owner's.
    await as(s.userId, (tx) =>
      rememberFact(tx, who, {
        fact: "Paying accounts are the active memberships",
        why: "correction",
        about: "paying accounts",
      }),
    );
    await as(ben, (tx) =>
      rememberFact(
        tx,
        { orgId: s.orgId, userId: ben },
        {
          fact: "Lapsed accounts are the canceled memberships",
          why: "correction",
          about: "lapsed accounts",
        },
      ),
    );
    // Someone's answer read the table Paying accounts isn't.
    await s.t
      .owner`insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, compiled_sql, sql_hash, status, reads)
      values (${uuidv7()}, ${s.orgId}, ${s.connectionId}, 'run', ${uuidv7()}, 'execute', 'select 1', 'h', 'succeeded',
        ${s.t.owner.json({ tables: ["public.trial_accounts"], compared: [] } as never)})`;
    await s.tenant((tx) => projectGraph(tx, s.orgId));
  });

  it("lists every topic for an owner, what's being learned first, each with its state and meaning", async () => {
    const topics = await as(s.userId, (tx) => listTopics(tx, owner));
    expect(topics.map((t) => [t.slug, t.state])).toEqual([
      ["lapsed-account", "learning"],
      ["paying-account", "team"],
    ]);
    expect(topics[1]).toMatchObject({
      title: "Paying accounts",
      line: "public.memberships where status in ('active')",
      learnings: 1,
      corrections: 1,
      memories: 1,
      tests: 1,
    });
  });

  it("shows anyone else the team's terms and what they corrected or remember, nothing more", async () => {
    expect((await as(ben, (tx) => listTopics(tx, member(ben)))).map((t) => t.slug).sort()).toEqual([
      "lapsed-account",
      "paying-account",
    ]);
    expect((await as(priya, (tx) => listTopics(tx, member(priya)))).map((t) => t.slug)).toEqual(["paying-account"]);
    expect(await as(priya, (tx) => getTopic(tx, member(priya), "lapsed-account"))).toBeNull();
    // Ben's memory is his: the owner sees no one else's on the topic.
    const lapsed = await as(s.userId, (tx) => getTopic(tx, owner, "lapsed-account"));
    expect(lapsed?.yourMemories).toEqual([]);
    expect((await as(ben, (tx) => getTopic(tx, member(ben), "lapsed-account")))?.yourMemories).toHaveLength(1);
  });

  it("brings a topic's meaning, learnings, guides, tests and the answers that read what it isn't onto one page", async () => {
    const topic = await as(s.userId, (tx) => getTopic(tx, owner, "paying-account"));
    expect(topic?.released).toMatchObject({
      column: "public.memberships.status",
      values: ["active"],
      not: ["public.trial_accounts"],
    });
    expect(topic?.proposed).toBeNull();
    expect(topic?.cards.map((c) => c.status)).toEqual(["approved"]);
    expect(topic?.guides.map((g) => g.title)).toEqual(["Canceled memberships"]);
    expect(topic?.testCases.map((c) => c.question)).toEqual(["How many paying accounts do we have?"]);
    expect(topic?.yourMemories.map((m) => m.fact)).toEqual(["Paying accounts are the active memberships"]);
    expect(topic?.readNot).toEqual([{ table: "public.trial_accounts", answers: 1 }]);
    // Anyone else: no counts of other people's answers.
    const theirs = await as(priya, (tx) => getTopic(tx, member(priya), "paying-account"));
    expect(theirs?.readNot).toBeNull();
    // Its diagram, along the paths that mean something: the column it means and that table, the guide on it, the table
    // it isn't (nothing beyond), and how it was learned as one summary.
    const kinds = (g: typeof topic) => (g?.graph?.nodes ?? []).map((n) => `${n.role}:${n.kind}`).sort();
    expect(kinds(topic)).toEqual([
      "isnt:table",
      "learned:learning",
      "means:column",
      "on:guide",
      "table:table",
      "term:term",
    ]);
    expect(topic?.graph?.nodes.find((n) => n.role === "learned")).toMatchObject({
      title: "Approved",
      detail: "1 learning · 1 correction by 1 person",
    });
    expect(topic?.graph?.nodes.find((n) => n.role === "on")?.detail).toBe("A guide on public.memberships · a draft");
    expect(topic?.graph?.edges.map((e) => e.rel).sort()).toEqual(["ABOUT", "ABOUT", "IS_NOT", "MEANS", "PART_OF"]);
    // Anyone else: what's released (the guide is still a draft), and not the learnings.
    expect(kinds(theirs)).toEqual(["isnt:table", "means:column", "table:table", "term:term"]);
    expect(theirs?.guides).toEqual([]);
  });

  it("keeps a change waiting for a tap to approvers, and counts only answers on the term's own source", async () => {
    const who = { orgId: s.orgId, userId: s.userId };
    const [t] = await s.t.owner<{ id: string }[]>`
      select id from app.context_item where org_id = ${s.orgId} and kind = 'term' and title = 'Paying accounts'`;
    await s.tenant((tx) =>
      saveTerm(tx, who, {
        id: t?.id as string,
        body: "term: Paying accounts\nmeans: The accounts with an active or trialing membership.\nmaps_to:\n  column: public.memberships.status\n  values: [active, trialing]\nnot: [public.trial_accounts]\n",
        connectionId: s.connectionId,
        proposed: true,
      }),
    );
    expect((await as(s.userId, (tx) => getTopic(tx, owner, "paying-account")))?.proposed?.values).toEqual([
      "active",
      "trialing",
    ]);
    const theirs = await as(priya, (tx) => getTopic(tx, member(priya), "paying-account"));
    expect(theirs?.released?.values).toEqual(["active"]);
    expect(theirs?.proposed).toBeNull();
    // The same table on another source isn't this term's.
    await s.t
      .owner`insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, compiled_sql, sql_hash, status, reads)
      values (${uuidv7()}, ${s.orgId}, ${uuidv7()}, 'run', ${uuidv7()}, 'execute', 'select 1', 'h', 'succeeded',
        ${s.t.owner.json({ tables: ["public.trial_accounts"], compared: [] } as never)})`;
    expect((await as(s.userId, (tx) => getTopic(tx, owner, "paying-account")))?.readNot).toEqual([
      { table: "public.trial_accounts", answers: 1 },
    ]);
  });
});

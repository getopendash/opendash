// The conversations list: a conversation's state read from its latest run, the scopes, searching questions and answers (never tool
// results), the state and project filters, and paging with a total. Every filter narrows what the viewer may read.
import { sql, type TenantTx, uuidv7 } from "@opendash/db";
import { createOrg, freshDatabase, type TestDatabase, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dashboardStarredBy,
  listThreadPage,
  searchPatterns,
  setDashboardStar,
  setThreadStar,
  shareThread,
  submitQuestion,
  type ThreadFilters,
} from "../src";

let t: TestDatabase;
const orgId = uuidv7();
const otherOrg = uuidv7();
const connectionId = uuidv7();
const alice = uuidv7();
const bob = uuidv7();
const deps = {
  withTenant: <T>(org: string, fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId: org }, fn),
  boss: null,
};
const ask = async (userId: string, text: string, org = orgId, connection = connectionId) =>
  (await submitQuestion(deps, { orgId: org, userId, connectionId: connection, text, channel: "web", model: "m" }))
    .threadId;
const ended = (threadId: string, status: string, outcome: Record<string, string | string[]> | null = null) =>
  t.owner`update app.run set status = ${status}, outcome = ${outcome ? t.owner.json(outcome) : null}
    where thread_id = ${threadId}`;
const say = (threadId: string, role: "assistant" | "tool_result", text: string) =>
  t.owner`insert into app.message (org_id, id, thread_id, seq, role, content, text)
    values (${orgId}, ${uuidv7()}, ${threadId}, 90, ${role}, '[]'::jsonb, ${text})`;
const list = (userId: string, f: ThreadFilters & { limit?: number; offset?: number } = {}) =>
  listThreadPage(deps, { orgId, userId }, f);
const titles = async (userId: string, f: ThreadFilters = {}) => (await list(userId, f)).threads.map((x) => x.title);

const ids: Record<string, string> = {};

beforeAll(async () => {
  t = await freshDatabase();
  await createOrg(t, orgId, "History");
  await createOrg(t, otherOrg, "Elsewhere");
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${orgId}, ${connectionId}, 'src', 'postgres')`;
  const elsewhere = uuidv7();
  await t.owner`insert into app.connection (org_id, id, name, dialect) values (${otherOrg}, ${elsewhere}, 'src', 'postgres')`;
  ids.answered = await ask(alice, "Why did churn drop in September?");
  await ended(ids.answered, "succeeded", {
    kind: "answer",
    status: "answered",
    rendered: "Churned MRR fell to $4.1k on Starter.",
  });
  await say(ids.answered, "assistant", "Annual renewals landed early, so I'll compare September with August.");
  ids.cannot = await ask(alice, "Net revenue retention in Q3");
  await ended(ids.cannot, "succeeded", { kind: "answer", status: "cannot_answer" });
  ids.noAnswer = await ask(alice, "Revenue by sales rep");
  await ended(ids.noAnswer, "succeeded", { kind: "no_answer", reason: "There's no sales rep in the data." });
  ids.clarify = await ask(alice, "What's our churn rate?");
  await ended(ids.clarify, "succeeded", { kind: "clarify", question: "Logo churn or revenue churn?", options: [] });
  ids.failed = await ask(alice, "Trial conversion by channel");
  await ended(ids.failed, "failed");
  await say(ids.failed, "tool_result", "secret_customer_email@example.com");
  ids.stopped = await ask(alice, "Top 10 accounts 100% expanded");
  await ended(ids.stopped, "cancelled");
  ids.working = await ask(alice, "MRR bridge for the board pack");
  ids.bobs = await ask(bob, "Bob's churn by plan");
  await ended(ids.bobs, "succeeded", { kind: "answer", status: "answered" });
  ids.bobsPrivate = await ask(bob, "Bob's private churn notes");
  await shareThread(deps, { orgId, userId: bob }, ids.bobs, "org");
  // Another organization's churn question never shows up.
  await ask(alice, "Churn in the other org", otherOrg, elsewhere);
});

afterAll(async () => {
  await t?.drop();
});

describe("G9's list", () => {
  it("reads each conversation's state from its latest run, as the Ask UI labels it", async () => {
    const state = new Map((await list(alice)).threads.map((x) => [x.id, x.state]));
    expect(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, state.get(id) ?? "hidden"]))).toEqual({
      answered: "answered",
      cannot: "cannot_answer",
      noAnswer: "cannot_answer",
      clarify: "needs_input",
      failed: "interrupted",
      stopped: "stopped",
      working: "working",
      bobs: "answered",
      bobsPrivate: "hidden",
    });
    expect(await titles(alice, { state: "cannot_answer" })).toEqual([
      "Revenue by sales rep",
      "Net revenue retention in Q3",
    ]);
  });

  it("scopes to mine, or to others' conversations shared with me", async () => {
    expect(await titles(alice, { scope: "shared" })).toEqual(["Bob's churn by plan"]);
    expect(await titles(alice, { scope: "mine" })).not.toContain("Bob's churn by plan");
    expect(await titles(bob, { scope: "shared" })).toEqual([]);
  });

  it("searches titles, questions and answers, every word, in any case and any part of a word", async () => {
    expect(await titles(alice, { q: "CHURN" })).toEqual([
      "Bob's churn by plan",
      "What's our churn rate?",
      "Why did churn drop in September?",
    ]);
    // Only in the analyst's notes, in the answer as shown (numbers included), in a question asked back, in a reason.
    expect(await titles(alice, { q: "renewal" })).toEqual(["Why did churn drop in September?"]);
    expect(await titles(alice, { q: "$4.1k starter" })).toEqual(["Why did churn drop in September?"]);
    expect(await titles(alice, { q: "logo" })).toEqual(["What's our churn rate?"]);
    expect(await titles(alice, { q: "no sales rep" })).toEqual(["Revenue by sales rep"]);
    expect(await titles(alice, { q: "churn plan" })).toEqual(["Bob's churn by plan"]);
    expect(await titles(alice, { q: "churn nothing-like-it" })).toEqual([]);
  });

  it("never searches tool results, others' private conversations or another organization", async () => {
    expect(await titles(alice, { q: "secret_customer_email" })).toEqual([]);
    expect(await titles(alice, { q: "private" })).toEqual([]);
    expect(await titles(bob, { q: "private" })).toEqual(["Bob's private churn notes"]);
    expect(await titles(alice, { q: "other org" })).toEqual([]);
  });

  it("takes % and _ as themselves", async () => {
    expect(searchPatterns("100% a_b")).toEqual(["%100\\%%", "%a\\_b%"]);
    expect(await titles(alice, { q: "100%" })).toEqual(["Top 10 accounts 100% expanded"]);
    expect(await titles(alice, { q: "%" })).toEqual(["Top 10 accounts 100% expanded"]);
    expect(await titles(alice, { q: "_" })).toEqual([]);
    expect(searchPatterns("   ")).toEqual([]);
  });

  it("finds a person's matches however many private ones others have (no cap before who may read them)", async () => {
    const mine = await ask(alice, "Quarterly secretword review");
    await t.owner`
      insert into app.thread (org_id, id, connection_id, created_by, title)
      select ${orgId}, gen_random_uuid(), ${connectionId}, ${bob}, 'Quarterly secretword ' || g
      from generate_series(1, 2100) g`;
    expect((await list(alice, { q: "secretword" })).threads.map((x) => x.id)).toEqual([mine]);
    expect((await list(bob, { q: "secretword", limit: 1 })).total).toBe(2100);
    await t.owner`delete from app.thread where org_id = ${orgId} and title like 'Quarterly secretword %'`;
  });

  it("pages, with how many match in all", async () => {
    const all = await list(alice);
    expect(all.total).toBe(8);
    const second = await list(alice, { limit: 3, offset: 3 });
    expect(second.total).toBe(8);
    expect(second.threads.map((x) => x.id)).toEqual(all.threads.slice(3, 6).map((x) => x.id));
    expect(await list(alice, { offset: 50 })).toEqual({ threads: [], total: 0 });
  });
});

describe("stars", () => {
  const star = (userId: string | null, threadId: string | undefined, on = true) =>
    setThreadStar(deps, { orgId, userId }, threadId as string, on);
  const marks = async () =>
    (await t.owner<{ n: number }[]>`select count(*)::int as n from app.user_mark where org_id = ${orgId}`)[0]?.n;

  it("stars what the person can read, theirs alone, and lists it under Starred", async () => {
    expect(await star(alice, ids.answered)).toBe(true);
    expect(await star(alice, ids.answered)).toBe(true);
    expect(await star(alice, ids.bobs)).toBe(true);
    expect(await marks()).toBe(2);
    expect(await titles(alice, { scope: "starred" })).toEqual([
      "Bob's churn by plan",
      "Why did churn drop in September?",
    ]);
    expect((await list(alice)).threads.find((x) => x.id === ids.bobs)?.starred).toBe(true);
    // Bob doesn't see Alice's star on his conversation.
    expect((await list(bob)).threads.find((x) => x.id === ids.bobs)?.starred).toBe(false);
    expect(await titles(bob, { scope: "starred" })).toEqual([]);
    // With a search, Starred narrows like any scope.
    expect(await titles(alice, { scope: "starred", q: "plan" })).toEqual(["Bob's churn by plan"]);
  });

  it("refuses what the person can't read, and an organization API key", async () => {
    expect(await star(alice, ids.bobsPrivate)).toBe(false);
    expect(await star(null, ids.answered)).toBe(false);
    expect(await star(alice, "01a126d7-0000-7000-8000-000000000000")).toBe(false);
    expect(await marks()).toBe(2);
  });

  it("unstars, and a star on a conversation the person loses drops out of their list", async () => {
    expect(await star(alice, ids.answered, false)).toBe(true);
    expect(await star(alice, ids.answered, false)).toBe(true);
    await shareThread(deps, { orgId, userId: bob }, ids.bobs as string, "private");
    expect(await titles(alice, { scope: "starred" })).toEqual([]);
    // Shared again, it's starred again: the mark stayed, harmless while she couldn't read it.
    await shareThread(deps, { orgId, userId: bob }, ids.bobs as string, "org");
    expect(await titles(alice, { scope: "starred" })).toEqual(["Bob's churn by plan"]);
  });

  it("stars a dashboard the person can read, theirs alone", async () => {
    const tenant = <T>(fn: (tx: TenantTx) => Promise<T>) => withTenantOn(t.app, { orgId }, fn);
    const board = uuidv7();
    await t.owner`insert into app.dashboard (org_id, id, title, owner_id) values (${orgId}, ${board}, 'Revenue', ${alice})`;
    const starDash = (userId: string | null, on = true) =>
      tenant((tx) => setDashboardStar(tx, { orgId, userId }, board, on));
    const starred = async (userId: string) =>
      (
        await tenant((tx) =>
          tx.execute<{ starred: boolean }>(
            sql`select ${dashboardStarredBy(userId)} as starred from app.dashboard d where d.id = ${board}`,
          ),
        )
      )[0]?.starred;
    // Private to Alice: Bob can't star it, nor can an organization key.
    expect(await starDash(bob)).toBe(false);
    expect(await starDash(null)).toBe(false);
    expect(await starDash(alice)).toBe(true);
    expect(await starred(alice)).toBe(true);
    await t.owner`update app.dashboard set visibility = 'org' where id = ${board}`;
    expect(await starred(bob)).toBe(false);
    expect(await starDash(alice, false)).toBe(true);
    expect(await starred(alice)).toBe(false);
  });
});

describe("Earlier about this", () => {
  it("lists the conversations where a question attached it, of those the viewer may read", async () => {
    const mrr = uuidv7();
    const attach = (threadId: string, items: unknown[]) =>
      t.owner`update app.message set attachments = ${t.owner.json(items as never)}
        where thread_id = ${threadId} and role = 'user'`;
    await attach(ids.answered as string, [{ kind: "metric", id: mrr }]);
    await attach(ids.clarify as string, [
      { kind: "guide", id: uuidv7() },
      { kind: "metric", id: mrr },
    ]);
    // Bob's private conversation about it, and one about another metric.
    await attach(ids.bobsPrivate as string, [{ kind: "metric", id: mrr }]);
    await attach(ids.cannot as string, [{ kind: "metric", id: uuidv7() }]);
    expect(await titles(alice, { attached: { kind: "metric", id: mrr } })).toEqual([
      "What's our churn rate?",
      "Why did churn drop in September?",
    ]);
    expect(await titles(bob, { attached: { kind: "metric", id: mrr }, scope: "mine" })).toEqual([
      "Bob's private churn notes",
    ]);
    // The same id as another kind isn't it.
    expect(await titles(alice, { attached: { kind: "dataset", id: mrr } })).toEqual([]);
    // An App's own conversation, the one it was built in, is about it too, though nothing attached it there.
    const app = uuidv7();
    await t.owner`insert into app.dashboard (org_id, id, title, owner_id, thread_id)
      values (${orgId}, ${app}, 'Desk', ${alice}, ${ids.cannot as string})`;
    expect(await titles(alice, { attached: { kind: "dashboard", id: app } })).toEqual(["Net revenue retention in Q3"]);
  });
});

describe("conversations asked in Slack", () => {
  it("are listed, found, filtered and starred like the web's, marked where they were asked; work isn't", async () => {
    const carol = uuidv7();
    const asked = async (text: string, channel: "web" | "slack" | "eval") =>
      (await submitQuestion(deps, { orgId, userId: carol, connectionId, text, channel, model: "m" })).threadId;
    const fromSlack = await asked("Customers who lost users this month", "slack");
    await ended(fromSlack, "succeeded", { kind: "answer", status: "answered" });
    const inOpenDash = await asked("Customers who gained users this month", "web");
    await ended(inOpenDash, "succeeded", { kind: "answer", status: "answered" });
    const evalCase = await asked("An eval case about users", "eval");
    await ended(evalCase, "succeeded", { kind: "answer", status: "answered" });

    // Hers (the org's shared ones are listed for her too).
    const listed = (await list(carol, { scope: "mine" })).threads;
    expect(listed.map((x) => [x.title, x.channel])).toEqual([
      ["Customers who gained users this month", "web"],
      ["Customers who lost users this month", "slack"],
    ]);
    expect(await titles(carol, { q: "lost users" })).toEqual(["Customers who lost users this month"]);
    expect(await titles(carol, { state: "answered", scope: "mine" })).toHaveLength(2);
    expect(await setThreadStar(deps, { orgId, userId: carol }, fromSlack, true)).toBe(true);
    expect(await titles(carol, { scope: "starred" })).toEqual(["Customers who lost users this month"]);
    expect((await list(carol)).threads.some((x) => x.id === evalCase)).toBe(false);
    // An eval's thread is work, never a conversation in the list, nor one to star.
    expect(await setThreadStar(deps, { orgId, userId: carol }, evalCase, true)).toBe(false);
  });
});

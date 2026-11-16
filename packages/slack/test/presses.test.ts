// The presses under an answer in Slack, end to end through the real Chat SDK adapter, on Postgres, with
// a stand-in for Slack's Web API. 👍 by the asker is their feedback, as the web's; by anyone else, a private "only the
// person who asked". 👎 opens a box asking what it should have said, and what's written there is a correction. A
// follow-up asks its question in the same conversation, once. An option under a question back is the asker's alone.
// App Home: published for the person, linked or not, with their own recent conversations; Unlink, then Link account.
import { createMemoryState } from "@chat-adapter/state-memory";
import { askFromSlack, connectSlack, listMemories, rememberFact, type SlackEnvelope, saveTerm } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import { withPublicOn, withTenantOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createSlackBot,
  FEEDBACK_MODAL,
  forwardToBot,
  gateSlackEvent,
  HOME_LINK,
  HOME_UNLINK,
  LEARNING_APPROVE,
  LEARNING_REVERT,
  LEARNING_SUGGEST,
  MEMORY_UNDO,
  publishSlackHome,
  ROUTINE_FINDING,
  tellLearning,
} from "../src";
import { type FakeSlack, fakeSlack } from "./helpers/fake-slack";

const TEAM = { teamId: "T0ACME", teamName: "Acme Corp", teamDomain: "acme", botUserId: "U0BOT" };
const PRIYA = "UPRIYA";
const MALLORY = "UMALLORY";
let s: LearnedSource;
let fake: FakeSlack;
let deliver: (envelope: SlackEnvelope) => Promise<void>;
let home: () => Promise<boolean>;
let tell: (proposalId: string) => Promise<number>;
let stop: () => Promise<void>;

beforeAll(async () => {
  s = await learnedSource();
  await s.t.owner`insert into auth.user (id, name, email, email_verified)
    values (${s.userId}, 'Priya Raman', 'priya@acme.test', true) on conflict (id) do update set name = excluded.name, email = excluded.email`;
  await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${s.userId}, 'member', now())
      on conflict (organization_id, user_id) do update set role = excluded.role`;
  const withPublic = <T>(fn: Parameters<typeof withPublicOn<T>>[1]) => withPublicOn(s.t.app, fn);
  const deps = { withTenant: s.deps.withTenant, withPublic, secrets: s.secrets };
  await s.tenant((tx) => connectSlack(deps, tx, { orgId: s.orgId, userId: s.userId }, TEAM, "xoxb-acme-test"));
  await s.t.owner`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
    values (${s.orgId}, ${TEAM.teamId}, ${PRIYA}, ${s.userId})`;
  fake = await fakeSlack();
  const { bot, slack } = createSlackBot(
    {
      ...deps,
      withUser: (orgId, userId, fn) => withTenantOn(s.t.app, { orgId, userId }, fn),
      boss: async () => s.boss,
      deploymentKeys: { anthropic: true, openai: false, google: false } as never,
      webUrl: "https://opendash.example",
    },
    { signingSecret: "unused", forwardingSecret: "fwd", state: createMemoryState(), apiUrl: fake.url },
  );
  await bot.initialize();
  deliver = async (envelope) => {
    if ((await gateSlackEvent(deps, envelope)) !== "forward") return;
    const tasks: Promise<unknown>[] = [];
    await forwardToBot(slack, "fwd", envelope, (t) => void tasks.push(t));
    await Promise.all(tasks);
  };
  home = () => publishSlackHome({ ...deps, webUrl: "https://opendash.example" }, slack, TEAM.teamId, PRIYA);
  tell = (proposalId) => tellLearning(deps, slack, s.orgId, proposalId);
  stop = () => bot.shutdown().catch(() => {});
});

afterAll(async () => {
  await stop?.();
  await fake?.close();
  await s?.close();
});

let n = 0;
/** A question asked from Slack in a channel thread of its own, ended with `outcome`: its run, thread and ts. */
const answered = async (outcome: Record<string, unknown>) => {
  const ts = `17919${String(++n).padStart(5, "0")}.000100`;
  const asked = await askFromSlack(
    { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
    {
      orgId: s.orgId,
      userId: s.userId,
      role: "member",
      teamId: TEAM.teamId,
      slackThreadId: `slack:C0SALES:${ts}`,
      slackUserId: PRIYA,
      slackMessageId: ts,
      text: "How did MRR change?",
      files: [],
    },
  );
  if (asked.kind !== "asked") throw new Error(asked.kind);
  await s.t.owner`update app.run set status = 'succeeded', finished_at = now(),
    outcome = ${s.t.owner.json(outcome as never)} where id = ${asked.runId}`;
  return { ...asked, ts };
};
const answer = {
  kind: "answer",
  status: "answered",
  verified: true,
  path: "unmodelled",
  markdown: "",
  rendered: "MRR grew **4%**.",
  interpretation: [],
  caveats: [],
  citations: [],
  values: [],
  problems: [],
  next: ["MRR by plan?", "Churn by plan?"],
};
/** A press under a message in the answer's thread. */
const press = (at: string, user: string, action: Record<string, unknown>): SlackEnvelope => ({
  eventType: "interactive",
  body: {
    type: "block_actions",
    trigger_id: `trigger-${uuidv7()}`,
    team: { id: TEAM.teamId },
    user: { id: user, team_id: TEAM.teamId },
    channel: { id: "C0SALES" },
    container: { type: "message", message_ts: `${at}9`, channel_id: "C0SALES" },
    message: { ts: `${at}9`, thread_ts: at, text: "" },
    actions: [action],
  },
});
/** What the bot said privately to someone, from here on. */
const told = (user: string, since: number) =>
  fake.calls
    .slice(since)
    .filter((c) => c.method === "chat.postEphemeral" && c.args.user === user)
    .map((c) => String(c.args.text ?? JSON.stringify(c.args.blocks ?? "")));
const feedback = async (runId: string) =>
  s.t.owner<{ kind: string; correction: { text?: string } | null }[]>`
    select kind, correction from app.feedback where run_id = ${runId} and user_id = ${s.userId}`;

describe("a press under an answer in Slack", () => {
  it("is the asker's 👍, kept as their feedback, and someone else's told it isn't theirs", async () => {
    const a = await answered(answer);
    const since = fake.calls.length;
    const up = { action_id: "opendash:feedback", type: "feedback_buttons", value: `up:${a.runId}` };
    await deliver(press(a.ts, PRIYA, up));
    expect(await feedback(a.runId)).toEqual([{ kind: "up", correction: null }]);
    expect(told(PRIYA, since)).toEqual(["Thanks, noted."]);
    await deliver(press(a.ts, MALLORY, up));
    expect(told(MALLORY, since)).toEqual(["Only the person who asked can rate this answer."]);
    // A press in the answer's thread: told in that thread.
    const [said] = fake.calls.slice(since).filter((c) => c.method === "chat.postEphemeral" && c.args.user === MALLORY);
    expect(said?.args).toMatchObject({ channel: "C0SALES", thread_ts: a.ts });
    expect(await feedback(a.runId)).toHaveLength(1);
  });

  it("is a 👎 that asks what it should have said, and keeps what's written as a correction", async () => {
    const a = await answered(answer);
    const since = fake.calls.length;
    await deliver(
      press(a.ts, PRIYA, { action_id: "opendash:feedback", type: "feedback_buttons", value: `down:${a.runId}` }),
    );
    const [opened] = fake.calls.slice(since).filter((c) => c.method === "views.open");
    const view = opened?.args.view as { callback_id: string; private_metadata?: string; blocks: unknown[] };
    expect(view.callback_id).toBe(FEEDBACK_MODAL);
    expect(JSON.stringify(view.blocks)).toContain("What should it have said?");
    // Nothing kept until it's sent.
    expect(await feedback(a.runId)).toEqual([]);
    await deliver({
      eventType: "interactive",
      body: {
        type: "view_submission",
        team: { id: TEAM.teamId },
        user: { id: PRIYA, team_id: TEAM.teamId, name: "priya" },
        view: {
          id: "V1",
          callback_id: view.callback_id,
          private_metadata: view.private_metadata,
          state: {
            values: { b1: { correction: { type: "plain_text_input", value: "It should leave out refunds." } } },
          },
        },
      },
    });
    const [kept] = await feedback(a.runId);
    expect(kept?.kind).toBe("down");
    expect(kept?.correction?.text).toBe("It should leave out refunds.");
    expect(told(PRIYA, since).at(-1)).toMatch(/^Thanks\. I'll keep that in mind/);
  });

  it("is a follow-up asked in the same conversation, once", async () => {
    const a = await answered(answer);
    const since = fake.calls.length;
    const next = { action_id: "opendash:next:1", type: "button", value: JSON.stringify({ r: a.runId, i: 1 }) };
    await deliver(press(a.ts, PRIYA, next));
    const [asked] = await s.t.owner<{ text: string; thread_id: string }[]>`
      select text, thread_id from app.message where org_id = ${s.orgId} and client_msg_id = ${`next:${a.runId}`}`;
    expect(asked).toEqual({ text: "Churn by plan?", thread_id: a.threadId });
    // A second press, once the conversation has moved on.
    await deliver(
      press(a.ts, PRIYA, { ...next, action_id: "opendash:next:0", value: JSON.stringify({ r: a.runId, i: 0 }) }),
    );
    expect(told(PRIYA, since)).toContain("This answer was followed up already. Ask in your own words.");
    const [count] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.message where org_id = ${s.orgId} and thread_id = ${a.threadId} and role = 'user'`;
    expect(count?.n).toBe(2);
  });

  it("is an option under a question back, the asker's alone", async () => {
    const a = await answered({ kind: "clarify", question: "Which revenue?", options: ["MRR", "Bookings"] });
    const since = fake.calls.length;
    const option = { action_id: "opendash:option:1", type: "button", value: JSON.stringify({ r: a.runId, i: 1 }) };
    await deliver(press(a.ts, MALLORY, option));
    expect(told(MALLORY, since)).toEqual(["Only the person who asked can answer these."]);
    await deliver(press(a.ts, PRIYA, option));
    const [asked] = await s.t.owner<{ text: string }[]>`
      select text from app.message where org_id = ${s.orgId} and thread_id = ${a.threadId} and text = 'Bookings'`;
    expect(asked?.text).toBe("Bookings");
    // The buttons then show what was chosen.
    expect(fake.calls.slice(since).some((c) => c.method === "chat.update")).toBe(true);
  });
});

describe("a source picked in Slack", () => {
  it("asks the question it was picked for, by its asker, and the buttons then say which", async () => {
    const at = `17919${String(++n).padStart(5, "0")}.000100`;
    // The question the buttons were posted under, as Slack keeps it in the thread.
    fake.messages.push({
      channel: "C0SALES",
      ts: at,
      thread_ts: at,
      user: PRIYA,
      team: TEAM.teamId,
      text: "Revenue by region?",
    });
    const since = fake.calls.length;
    await deliver(
      press(at, PRIYA, {
        action_id: "opendash:source:0",
        type: "button",
        text: { type: "plain_text", text: "Acme warehouse" },
        value: JSON.stringify({ c: s.connectionId, m: at }),
      }),
    );
    const [asked] = await s.t.owner<{ text: string }[]>`
      select text from app.message where org_id = ${s.orgId} and client_msg_id = ${at}`;
    expect(asked?.text).toBe("Revenue by region?");
    const [edited] = fake.calls.slice(since).filter((c) => c.method === "chat.update");
    expect(String(edited?.args.markdown_text ?? JSON.stringify(edited?.args))).toContain("Acme warehouse");
  });

  it("tells its asker why it can't be asked, in the picker's thread", async () => {
    const at = `17919${String(++n).padStart(5, "0")}.000100`;
    fake.messages.push({ channel: "C0SALES", ts: at, thread_ts: at, user: PRIYA, team: TEAM.teamId, text: "Orders?" });
    const since = fake.calls.length;
    // A source that isn't ready (gone since the buttons were posted): refused, and told where the buttons are, though
    // the question itself was said in the channel.
    await deliver(
      press(at, PRIYA, {
        action_id: "opendash:source:0",
        type: "button",
        text: { type: "plain_text", text: "Old warehouse" },
        value: JSON.stringify({ c: uuidv7(), m: at }),
      }),
    );
    expect(told(PRIYA, since)).toEqual(["That source isn't ready to ask."]);
    const [said] = fake.calls.slice(since).filter((c) => c.method === "chat.postEphemeral" && c.args.user === PRIYA);
    expect(said?.args).toMatchObject({ channel: "C0SALES", thread_ts: at });
  });
});

describe("Undo of what an answer remembered, in Slack", () => {
  it("forgets it for its owner, with the older one back; anyone else can't", async () => {
    const who = { orgId: s.orgId, userId: s.userId };
    const as = <T>(fn: Parameters<typeof withTenantOn<T>>[2]) => withTenantOn(s.t.app, who, fn);
    const older = await as((tx) => rememberFact(tx, who, { fact: "Paying accounts means active subscriptions" }));
    const kept = await as((tx) =>
      rememberFact(tx, who, {
        fact: "Paying accounts are the active subscriptions",
        why: "correction",
        about: "paying accounts",
      }),
    );
    expect(kept.replaced).toEqual([older.id]);
    const at = `17919${String(++n).padStart(5, "0")}.000100`;
    const undo = (user: string) =>
      press(at, user, { action_id: MEMORY_UNDO, type: "button", value: JSON.stringify({ m: kept.id }) });
    // Someone else in the channel (not linked): nothing happens.
    let since = fake.calls.length;
    await deliver(undo("UOTHER"));
    expect((await as((tx) => listMemories(tx, s.orgId, s.userId))).map((m) => m.fact)).toContain(
      "Paying accounts are the active subscriptions",
    );
    since = fake.calls.length;
    await deliver(undo(PRIYA));
    const facts = (await as((tx) => listMemories(tx, s.orgId, s.userId))).map((m) => m.fact);
    expect(facts).toContain("Paying accounts means active subscriptions");
    expect(facts).not.toContain("Paying accounts are the active subscriptions");
    expect(told(PRIYA, since)[0]).toMatch(/^Forgotten/);
    // Twice: already done.
    since = fake.calls.length;
    await deliver(undo(PRIYA));
    expect(told(PRIYA, since)[0]).toMatch(/^Only the person it was remembered for/);
  });
});

describe("App Home in Slack", () => {
  const views = (since: number) =>
    fake.calls
      .slice(since)
      .filter((c) => c.method === "views.publish" && c.args.user_id === PRIYA)
      .map((c) => JSON.stringify(c.args.view));

  it("is published for the person with their own recent conversations, and Unlink and Link account change it", async () => {
    const a = await answered(answer);
    await s.t.owner`update app.thread set title = 'MRR in September' where id = ${a.threadId}`;
    let since = fake.calls.length;
    expect(await home()).toBe(true);
    const [linked] = views(since);
    expect(linked).toContain("Your Slack account is linked");
    expect(linked).toContain("MRR in September");
    expect(linked).toContain(`https://opendash.example/ask/${a.threadId}`);
    expect(linked).toContain(HOME_UNLINK);

    // Unlink: the link goes, and the tab offers Link account.
    since = fake.calls.length;
    const homePress = (actionId: string): SlackEnvelope => ({
      eventType: "interactive",
      body: {
        type: "block_actions",
        trigger_id: `trigger-${uuidv7()}`,
        team: { id: TEAM.teamId },
        user: { id: PRIYA, team_id: TEAM.teamId },
        container: { type: "view", view_id: "VHOME" },
        view: { id: "VHOME", type: "home" },
        actions: [{ action_id: actionId, type: "button" }],
      },
    });
    await deliver(homePress(HOME_UNLINK));
    const [rows] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.slack_identity where slack_user_id = ${PRIYA}`;
    expect(rows?.n).toBe(0);
    const [unlinked] = views(since);
    expect(unlinked).toContain(HOME_LINK);
    expect(unlinked).not.toContain("MRR in September");

    // Link account: a link made now, its address on the tab.
    since = fake.calls.length;
    await deliver(homePress(HOME_LINK));
    const [link] = views(since);
    expect(link).toContain("https://opendash.example/slack/link#");
    const [made] = await s.t.owner<{ n: number }[]>`
      select count(*)::int as n from app.slack_link where slack_user_id = ${PRIYA} and used_at is null`;
    expect(made?.n).toBe(1);
    // Its Slack email goes with it only when Slack confirmed the address is theirs (read fresh, users.info).
    const emails = () =>
      s.t.owner<{ email: string | null }[]>`
        select slack_user_email as email from app.slack_link where slack_user_id = ${PRIYA} order by expires_at desc`;
    expect((await emails())[0]?.email).toBeNull();
    fake.answer("users.info", (a) => ({
      ok: true,
      user: { id: a.user, name: "priya", is_email_confirmed: true, profile: { email: "Priya@Acme.test" } },
    }));
    await deliver(homePress(HOME_LINK));
    expect((await emails())[0]?.email).toBe("priya@acme.test");
    fake.answer("users.info", (a) => ({
      ok: true,
      user: { id: a.user, name: "priya", is_email_confirmed: false, profile: { email: "priya@acme.test" } },
    }));
    await deliver(homePress(HOME_LINK));
    expect((await emails())[0]?.email).toBeNull();
    fake.answer("users.info", null);
    // Linked again, for the tests after.
    await s.t.owner`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
      values (${s.orgId}, ${TEAM.teamId}, ${PRIYA}, ${s.userId})`;
  });
});

describe("a learning in Slack", () => {
  let k = 0;
  const setRole = (role: string) =>
    s.t.owner`update auth.member set role = ${role} where organization_id = ${s.orgId} and user_id = ${s.userId}`;
  /** A learning decided (open) from a correction under this Slack answer: a proposed term, checked and tested. */
  const learning = async (runId: string, by = s.userId) => {
    const word = `Plans${++k}`;
    const term = await s.tenant((tx) =>
      saveTerm(
        tx,
        { orgId: s.orgId, userId: s.userId },
        { body: `term: ${word}\nmeans: The paid plans.\n`, proposed: true },
      ),
    );
    const id = uuidv7();
    const evidence = {
      signals: [
        {
          kind: "feedback",
          id: uuidv7(),
          userId: by,
          text: `${word} means the paid plans`,
          runId,
          fromRunId: runId,
          at: new Date().toISOString(),
        },
      ],
      learning: {
        term: word,
        means: "The paid plans.",
        synonyms: [`paid plans${k}`],
        not: [],
        quote: `${word} means the paid plans`,
        question: "How many plans?",
      },
      termId: term.id,
      termVersion: term.version,
      check: { queryRunId: null, ok: true, rows: 3 },
      test: { runId: uuidv7(), ok: true, used: true },
      decided: { automatic: false, missing: ["said by an approver or two people"] },
    };
    await s.t
      .owner`insert into app.proposal (org_id, id, connection_id, kind, source, status, title, evidence, dedupe_key, items)
      values (${s.orgId}, ${id}, ${s.connectionId}, 'update', 'curator', 'open', ${`Learning: ${word}`},
        ${s.t.owner.json(evidence as never)}, ${`term:${word.toLowerCase()}`}, ${`{${term.id}}`}::uuid[])`;
    return id;
  };
  const ephemerals = (since: number) =>
    fake.calls.slice(since).filter((c) => c.method === "chat.postEphemeral" && c.args.user === PRIYA);

  it("tells whoever corrected it, privately in the thread, once: 'Suggested to your admins' when they can't approve", async () => {
    const a = await answered(answer);
    const id = await learning(a.runId);
    const since = fake.calls.length;
    expect(await tell(id)).toBe(1);
    const [told] = ephemerals(since);
    expect(told?.args).toMatchObject({ channel: "C0SALES", thread_ts: a.ts });
    expect(String(told?.args.text)).toMatch(/^Suggested to your admins: Plans\d means/);
    expect(await tell(id)).toBe(0);
    // Someone else's correction on this answer isn't told to its asker.
    expect(await tell(await learning(a.runId, uuidv7()))).toBe(0);
  });

  it("offers an owner one tap, which only an owner or admin can press; Revert the same", async () => {
    await setRole("owner");
    try {
      const a = await answered(answer);
      const id = await learning(a.runId);
      let since = fake.calls.length;
      await tell(id);
      const [offer] = ephemerals(since);
      expect(JSON.stringify(offer?.args.blocks)).toContain(LEARNING_APPROVE);
      // What else it's called is shown before the tap: the analyst reads each word as the term.
      expect(String(offer?.args.text)).toMatch(/Also called: paid plans\d\./);
      // An unlinked person in the channel: told to link, nothing approved.
      since = fake.calls.length;
      await deliver(
        press(a.ts, MALLORY, { action_id: LEARNING_APPROVE, type: "button", value: JSON.stringify({ p: id }) }),
      );
      const [p0] = await s.t.owner<{ status: string }[]>`select status from app.proposal where id = ${id}`;
      expect(p0?.status).toBe("open");
      // The owner taps: it's the team's.
      since = fake.calls.length;
      await deliver(
        press(a.ts, PRIYA, { action_id: LEARNING_APPROVE, type: "button", value: JSON.stringify({ p: id }) }),
      );
      expect(told(PRIYA, since)[0]).toMatch(/^Done: it's a team learning now/);
      const [p1] = await s.t.owner<{ status: string }[]>`select status from app.proposal where id = ${id}`;
      expect(p1?.status).toBe("approved");
      // As a member again, Revert is refused.
      await setRole("member");
      since = fake.calls.length;
      await deliver(
        press(a.ts, PRIYA, { action_id: LEARNING_REVERT, type: "button", value: JSON.stringify({ p: id }) }),
      );
      expect(told(PRIYA, since)[0]).toBe("Only owners and admins make a learning the team's.");
    } finally {
      await setRole("member");
    }
  });

  it("lets someone suggest their own correction from the reply's line", async () => {
    const a = await answered(answer);
    const who = { orgId: s.orgId, userId: s.userId };
    const kept = await withTenantOn(s.t.app, who, (tx) =>
      rememberFact(tx, who, { fact: "Seats means paid seats", why: "correction", about: "seats", runId: a.runId }),
    );
    const since = fake.calls.length;
    await deliver(
      press(a.ts, PRIYA, { action_id: LEARNING_SUGGEST, type: "button", value: JSON.stringify({ m: kept.id }) }),
    );
    expect(told(PRIYA, since)[0]).toMatch(/^Suggested for the team/);
    const [p] = await s.t.owner<{ signals: { kind: string; text: string }[] }[]>`
      select evidence->'signals' as signals from app.proposal where source = 'curator' and dedupe_key = 'term:seat'`;
    expect(p?.signals).toEqual([expect.objectContaining({ kind: "suggestion", text: "Seats means paid seats" })]);
  });
});

describe("a finding a routine posted in a channel", () => {
  const finding = async () => {
    const id = uuidv7();
    await s.t
      .owner`insert into app.insight (org_id, id, connection_id, kind, period, title, summary, severity, dedupe_key)
      values (${s.orgId}, ${id}, ${s.connectionId}, 'data_quality', '2026-10-01', 'Orders stopped arriving',
        'No orders since Oct 7.', 2, ${`press:${id}`})`;
    return id;
  };
  const status = async (id: string) =>
    (
      await s.t.owner<{ status: string; dismiss_reason: string | null }[]>`
      select status, dismiss_reason from app.insight where id = ${id}`
    )[0];
  /** A choice in a finding's menu, on a routine's post: a message of its own in the channel, not in a thread. */
  const choose = (who: string, value: Record<string, unknown>) =>
    deliver({
      eventType: "interactive",
      body: {
        type: "block_actions",
        trigger_id: `trigger-${uuidv7()}`,
        team: { id: TEAM.teamId },
        user: { id: who, team_id: TEAM.teamId },
        channel: { id: "C0GROWTH" },
        container: { type: "message", message_ts: "1791900000.000100", channel_id: "C0GROWTH" },
        message: { ts: "1791900000.000100", text: "" },
        actions: [{ action_id: ROUTINE_FINDING, type: "overflow", selected_option: { value: JSON.stringify(value) } }],
      },
    });
  const setRole = (role: string) =>
    s.t.owner`update auth.member set role = ${role} where organization_id = ${s.orgId} and user_id = ${s.userId}`;

  it("is dismissed with why by an owner or admin only, and investigated by anyone who can ask", async () => {
    const id = await finding();
    try {
      // Someone who hasn't linked their Slack account: told to, nothing changes.
      let since = fake.calls.length;
      await choose(MALLORY, { a: "dismiss", i: id, r: "known_issue" });
      expect(told(MALLORY, since)[0]).toBe("Link your Slack account to OpenDash first.");
      // Said in the channel: the post has no replies, and Slack hides a private message in a thread without any.
      const [said] = fake.calls.slice(since).filter((c) => c.method === "chat.postEphemeral");
      expect(said?.args).toMatchObject({ channel: "C0GROWTH", user: MALLORY });
      expect(said?.args.thread_ts).toBeUndefined();
      // A member can't dismiss it for everyone.
      since = fake.calls.length;
      await choose(PRIYA, { a: "dismiss", i: id, r: "known_issue" });
      expect(told(PRIYA, since)[0]).toBe("Only owners and admins dismiss findings.");
      expect((await status(id))?.status).toBe("new");
      // Investigate: a finding that isn't about a metric's change can't be.
      since = fake.calls.length;
      await choose(PRIYA, { a: "investigate", i: id });
      expect(told(PRIYA, since)[0]).toBe("Only an open finding about a metric's change can be investigated.");
      await setRole("viewer");
      since = fake.calls.length;
      await choose(PRIYA, { a: "investigate", i: id });
      expect(told(PRIYA, since)[0]).toBe("Your role can't start investigations.");
      // An admin dismisses it, with why; again, it isn't open any more.
      await setRole("admin");
      since = fake.calls.length;
      await choose(PRIYA, { a: "dismiss", i: id, r: "known_issue" });
      expect(told(PRIYA, since)[0]).toBe("Dismissed for everyone, with why.");
      expect(await status(id)).toEqual({ status: "dismissed", dismiss_reason: "known_issue" });
      since = fake.calls.length;
      await choose(PRIYA, { a: "dismiss", i: id, r: "known_issue" });
      expect(told(PRIYA, since)[0]).toBe("It isn't open any more.");
      // A reason that isn't one does nothing.
      const other = await finding();
      since = fake.calls.length;
      await choose(PRIYA, { a: "dismiss", i: other, r: "because" });
      expect(told(PRIYA, since)).toEqual([]);
      expect((await status(other))?.status).toBe("new");
    } finally {
      await setRole("member");
    }
  });
});

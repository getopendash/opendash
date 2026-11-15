// Every question from Slack recorded before Slack hears it arrived, asked once, end to end: Slack's
// events through the gate and the real Chat SDK adapter, into OpenDash's ask, on Postgres, with a stand-in for Slack's
// Web API. A DM Slack sends twice, a mention with its twin, a press delivered twice: each asked once, its record
// marked asked with its run. A question whose handler never ran (the process stopped after acknowledging it) handed
// to the bot again once due, and asked once; one past its last try told it was lost. Two first questions at once in
// a new Slack thread: one conversation, the second its follow-up. A week on, the records go.
import { createMemoryState } from "@chat-adapter/state-memory";
import { connectSlack, purgeSlackInbound, type SlackEnvelope } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import { withPublicOn, withSystemOn } from "@opendash/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSlackBot, forwardToBot, gateSlackEvent, LOST_QUESTION, replaySlackInbound } from "../src";
import { type FakeSlack, fakeSlack } from "./helpers/fake-slack";

const TEAM = { teamId: "T0ACME", teamName: "Acme Corp", teamDomain: "acme", botUserId: "U0BOT" };
const FORWARDING = "forwarding-secret";
const PRIYA = "UPRIYA";

let s: LearnedSource;
let fake: FakeSlack;
let deliver: (envelope: SlackEnvelope) => Promise<"forward" | "skip">;
let replay: () => Promise<{ replayed: number; lost: number }>;
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
      boss: async () => s.boss,
      deploymentKeys: { anthropic: true, openai: false, google: false } as never,
      webUrl: "https://opendash.example",
    },
    { signingSecret: "unused", forwardingSecret: FORWARDING, state: createMemoryState(), apiUrl: fake.url },
  );
  await bot.initialize();
  // What the worker and the web do with an event: the gate, then the bot for the delivery that made the record. The
  // work the bot starts is waited for, so a test reads what it did.
  const run = async (task: Promise<unknown>[], work: (track: (t: Promise<unknown>) => void) => Promise<unknown>) => {
    await work((t) => void task.push(t));
    await Promise.all(task);
  };
  deliver = async (envelope) => {
    const verdict = await gateSlackEvent(deps, envelope);
    if (verdict === "forward") await run([], (track) => forwardToBot(slack, FORWARDING, envelope, track));
    return verdict;
  };
  replay = async () => {
    let done = { replayed: 0, lost: 0 };
    const withSystem = <T>(fn: Parameters<typeof withSystemOn<T>>[1]) => withSystemOn(s.t.system, fn);
    await run([], async (track) => {
      done = await replaySlackInbound({ ...deps, withSystem }, bot, slack, FORWARDING, track);
    });
    return done;
  };
  stop = async () => {
    await bot.shutdown().catch(() => {});
  };
}, 300_000);

afterAll(async () => {
  await stop?.();
  await fake?.close();
  await s?.close();
});

let n = 0;
const ts = () => `17918${String(++n).padStart(5, "0")}.000100`;
const dm = (at: string, text = "How did MRR change last month?"): SlackEnvelope => ({
  eventType: "events_api",
  body: {
    type: "event_callback",
    team_id: TEAM.teamId,
    event: { type: "message", channel_type: "im", channel: "D0PRIYA", user: PRIYA, ts: at, text },
  },
});
const mention = (type: "app_mention" | "message", at: string, thread: string): SlackEnvelope => ({
  eventType: "events_api",
  body: {
    type: "event_callback",
    team_id: TEAM.teamId,
    event: {
      type,
      ...(type === "message" ? { channel_type: "channel" } : {}),
      channel: "C0SALES",
      user: PRIYA,
      ts: at,
      thread_ts: thread,
      text: `<@${TEAM.botUserId}> Which plans churned most?`,
    },
  },
});
/** The questions asked from one Slack message (or press), by its message id. */
const asked = async (clientMsgId: string) => {
  const [r] = await s.t.owner<{ n: number }[]>`
    select count(*)::int as n from app.message where org_id = ${s.orgId} and client_msg_id = ${clientMsgId}`;
  return r?.n ?? 0;
};
const record = async (key: string) => {
  const [r] = await s.t.owner<{ status: string; run_id: string | null; envelope: unknown; replays: number }[]>`
    select status, run_id, envelope, replays from app.slack_inbound where org_id = ${s.orgId} and key = ${key}`;
  return r;
};

describe("a question from Slack", () => {
  it("is asked once though Slack sends it twice, and recorded as asked with its run", async () => {
    const at = ts();
    expect(await deliver(dm(at))).toBe("forward");
    // Slack's retry (it didn't hear back in time): recorded already, so it goes no further.
    expect(await deliver(dm(at))).toBe("skip");
    expect(await asked(at)).toBe(1);
    const r = await record(`m:D0PRIYA:${at}`);
    expect(r).toMatchObject({ status: "asked", envelope: null });
    expect(r?.run_id).toBeTruthy();
    // 👀 on the question: it was picked up.
    expect(fake.of("reactions.add").some((c) => c.args.timestamp === at && c.args.name === "eyes")).toBe(true);
  }, 60_000);

  it("is asked once when a mention comes with its twin", async () => {
    const thread = ts();
    const at = ts();
    expect(await deliver(mention("app_mention", at, thread))).toBe("forward");
    expect(await deliver(mention("message", at, thread))).toBe("skip");
    expect(await asked(at)).toBe(1);
    expect((await record(`m:C0SALES:${at}`))?.status).toBe("asked");
  }, 60_000);

  it("isn't recorded when it's a channel message not addressed to OpenDash", async () => {
    const at = ts();
    const chatter: SlackEnvelope = {
      eventType: "events_api",
      body: {
        type: "event_callback",
        team_id: TEAM.teamId,
        event: { type: "message", channel_type: "channel", channel: "C0SALES", user: PRIYA, ts: at, text: "lunch?" },
      },
    };
    expect(await deliver(chatter)).toBe("forward");
    expect(await record(`m:C0SALES:${at}`)).toBeUndefined();
    expect(await asked(at)).toBe(0);
  }, 60_000);

  it("is a press asked once though it's delivered twice", async () => {
    const at = ts();
    const press: SlackEnvelope = {
      eventType: "interactive",
      body: {
        type: "block_actions",
        trigger_id: `trigger-${at}`,
        team: { id: TEAM.teamId },
        user: { id: PRIYA, team_id: TEAM.teamId },
        channel: { id: "D0PRIYA" },
        container: { type: "message", message_ts: at, channel_id: "D0PRIYA" },
        message: { ts: at, thread_ts: at, text: "Choose one:" },
        actions: [{ action_id: "opendash:option:0", value: "Last quarter", type: "button" }],
      },
    };
    expect(await deliver(press)).toBe("forward");
    expect(await deliver(press)).toBe("skip");
    expect(await asked(`${at}:Last quarter`)).toBe(1);
    expect((await record(`a:trigger-${at}`))?.status).toBe("asked");
  }, 60_000);

  it("is handed to the bot again when nothing handled it, once due, and asked once", async () => {
    const at = ts();
    // Recorded and acknowledged, then the process stopped before the bot saw it.
    const verdict = await gateSlackEvent(
      { withTenant: s.deps.withTenant, withPublic: (fn) => withPublicOn(s.t.app, fn) },
      dm(at, "Revenue by region?"),
    );
    expect(verdict).toBe("forward");
    expect((await record(`m:D0PRIYA:${at}`))?.status).toBe("received");
    // Not yet due: Chat SDK may still remember it.
    expect(await replay()).toEqual({ replayed: 0, lost: 0 });
    await s.t
      .owner`update app.slack_inbound set next_at = now() - interval '1 second' where key = ${`m:D0PRIYA:${at}`}`;
    expect(await replay()).toEqual({ replayed: 1, lost: 0 });
    expect(await asked(at)).toBe(1);
    expect(await record(`m:D0PRIYA:${at}`)).toMatchObject({ status: "asked", replays: 1, envelope: null });
    // Asked: never handed on again.
    await s.t
      .owner`update app.slack_inbound set next_at = now() - interval '1 second' where key = ${`m:D0PRIYA:${at}`}`;
    expect(await replay()).toEqual({ replayed: 0, lost: 0 });
  }, 60_000);

  it("is said to be lost, privately, once its last try is used", async () => {
    const at = ts();
    await gateSlackEvent(
      { withTenant: s.deps.withTenant, withPublic: (fn) => withPublicOn(s.t.app, fn) },
      mention("app_mention", at, at),
    );
    await s.t.owner`update app.slack_inbound set replays = 3, next_at = now() - interval '1 second'
      where key = ${`m:C0SALES:${at}`}`;
    const before = fake.of("chat.postEphemeral").length;
    expect(await replay()).toEqual({ replayed: 0, lost: 1 });
    const told = fake.of("chat.postEphemeral").slice(before);
    expect(told).toHaveLength(1);
    expect(told[0]?.args).toMatchObject({ channel: "C0SALES", user: PRIYA });
    expect(JSON.stringify(told[0]?.args)).toContain(LOST_QUESTION.slice(0, 20));
    expect(await record(`m:C0SALES:${at}`)).toMatchObject({ status: "lost", envelope: null });
    expect(await asked(at)).toBe(0);
  }, 60_000);

  it("starts one conversation when two first questions arrive at once in a new Slack thread", async () => {
    const thread = ts();
    const [a, b] = [ts(), ts()];
    await Promise.all([deliver(mention("app_mention", a, thread)), deliver(mention("app_mention", b, thread))]);
    const conversations = await s.t.owner<{ thread_id: string }[]>`
      select thread_id from app.slack_conversation
      where org_id = ${s.orgId} and slack_thread_id = ${`slack:C0SALES:${thread}`} and slack_user_id = ${PRIYA}`;
    expect(conversations).toHaveLength(1);
    // Both asked, in that one conversation.
    const threads = await s.t.owner<{ thread_id: string }[]>`
      select distinct thread_id from app.message where org_id = ${s.orgId} and client_msg_id in (${a}, ${b})`;
    expect(threads.map((t) => t.thread_id)).toEqual([conversations[0]?.thread_id]);
  }, 60_000);

  it("is purged a week after it came in, whatever became of it", async () => {
    const [before] = await s.t.owner<{ n: number }[]>`select count(*)::int as n from app.slack_inbound`;
    await s.t.owner`update app.slack_inbound set received_at = now() - interval '8 days'
      where key = (select key from app.slack_inbound order by received_at limit 1)`;
    expect(await purgeSlackInbound((fn) => withSystemOn(s.t.system, fn))).toBe(1);
    const [after] = await s.t.owner<{ n: number }[]>`select count(*)::int as n from app.slack_inbound`;
    expect(after?.n).toBe((before?.n ?? 0) - 1);
  }, 60_000);
});

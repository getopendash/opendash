// Routines posting to Slack channels: a channel is checked with Slack before saving (there, not
// archived, the bot in it) and against the workspace (Slack connected, the same team); each run queues a post per
// channel, composed as the whole workspace reads it (a scheduled question's answer, in a conversation the workspace
// reads); a post goes once: a later attempt looks for it first, one nobody can tell went is `unknown`, and Slack
// refusing for good fails it, all without a retry. Slack's API is a fake here, and the Analyst's runs are ended by hand.
import { uuidv7 } from "@opendash/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  channelSentence,
  checkRoutineChannels,
  connectSlack,
  createRoutine,
  type DeliveryOut,
  deliverEffect,
  finishAgentRun,
  listRoutines,
  postSlackOnce,
  type RoutineMessage,
  RoutineProblem,
  runRoutineNow,
  runRoutineRun,
  SLACK_FOR_GOOD,
  SlackApiError,
  type SlackPostInput,
  type SlackPostResult,
  sentenceText,
  setOrgTz,
  slackPoster,
  updateRoutine,
} from "../src";
import { actor, jobDeps, member, verifiedSource } from "./helpers/checks";
import type { LearnedSource } from "./helpers/learned-source";

let s: LearnedSource;
const NOW = new Date("2026-10-11T09:00:00Z");
const TEAM = "T0TESTTEAM";
const BOT = "U0OPENDASH";
const bob = uuidv7();
const growth = { teamId: TEAM, channelId: "C0GROWTH01", name: "growth" };

/** A fake Slack Web API: each method's answer, and every call it was given. */
function fakeSlack(answers: Record<string, (args: URLSearchParams) => unknown>) {
  const calls: { method: string; args: URLSearchParams }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const method = String(url).split("/api/")[1] as string;
    const args = new URLSearchParams(String(init?.body ?? ""));
    calls.push({ method, args });
    const answer = answers[method];
    if (!answer) return new Response(JSON.stringify({ ok: false, error: "unknown_method" }));
    const value = answer(args);
    if (value instanceof Response) return value;
    return new Response(JSON.stringify(value));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const problem = async (p: Promise<unknown>) => {
  try {
    await p;
    return "ok";
  } catch (error) {
    if (error instanceof RoutineProblem) return error.message;
    throw error;
  }
};
const SIGNUPS = "How many accounts signed up last week?";
/** A question asked on Mondays at 07:00 (its source is known once the workspace is). */
const asking = () => ({
  version: 1,
  trigger: "schedule",
  rule: { every: "week", days: ["mon"], at: "07:00" },
  action: { kind: "ask", connectionId: s.connectionId, question: SIGNUPS },
});
const effectsOf = (runId: string) =>
  s.t.owner<
    {
      id: string;
      status: string;
      channel: string;
      recipient_key: string;
      idempotency_key: string;
      attempt: number;
      provider_ref: string | null;
      receipt: { reason?: string; error?: string };
    }[]
  >`
    select id, status, channel, recipient_key, idempotency_key, attempt, provider_ref, receipt from app.effect
    where org_id = ${s.orgId} and source_id = ${runId} order by channel, created_at`;
const runOf = async (routineId: string) => {
  const [r] = await s.t.owner<{ id: string; status: string; error: string | null }[]>`
    select id, status, error from app.routine_run where org_id = ${s.orgId} and routine_id = ${routineId}
    order by created_at desc limit 1`;
  return r;
};

/** A delivery whose Slack poster is scripted: each call takes the next result (or throws it). */
function delivery(results: (SlackPostResult | Error)[]) {
  const posts: SlackPostInput[] = [];
  const rendered: RoutineMessage[] = [];
  const out: DeliveryOut = {
    sender: { send: async () => ({ id: "email" }) },
    render: (m) => ({ subject: m.kind, html: "", text: "" }),
    baseUrl: "https://app.opendash.example",
    canDeliver: () => true,
    slack: {
      render: (m) => {
        rendered.push(m);
        return { text: m.because, blocks: [] };
      },
      post: async (input) => {
        posts.push(input);
        const next = results.shift() ?? { status: "sent", ts: "1.000" };
        if (next instanceof Error) throw next;
        return next;
      },
    },
  };
  return { out, posts, rendered };
}

/**
 * A routine that asks a question and posts the answer to #growth (and emails Maya), run now, its Analyst's run ended
 * with the answer and filed; its run's id, and where the answer is.
 */
async function postedRun(extra: { userIds?: string[] } = {}) {
  const routine = await s.tenant((tx) =>
    createRoutine(tx, actor(s), { spec: asking(), userIds: extra.userIds ?? [], slack: [growth] }, NOW),
  );
  await s.tenant((tx) => runRoutineNow(tx, s.boss, actor(s), routine, NOW));
  const run = await runOf(routine);
  expect(await runRoutineRun(jobDeps(s), { orgId: s.orgId, routineRunId: run?.id as string }, NOW)).toBe("writing");
  const [agent] = await s.t.owner<{ id: string; thread_id: string }[]>`
    select a.id, a.thread_id from app.routine_run rr join app.run a on a.org_id = rr.org_id and a.id = rr.run_id
    where rr.id = ${run?.id as string}`;
  await s.t.owner`update app.run set status = 'succeeded', finished_at = now(), outcome = ${s.t.owner.json({
    kind: "answer",
    status: "answered",
    verified: true,
    markdown: "**212** accounts signed up last week.",
    rendered: "**212** accounts signed up last week.",
    interpretation: [],
    caveats: [],
    citations: [],
    values: [],
    problems: [],
  } as never)} where id = ${agent?.id as string}`;
  expect(await finishAgentRun({ ...s.deps, boss: s.boss }, s.orgId, agent?.id as string)).toBe("sending");
  return {
    routine,
    runId: run?.id as string,
    answer: { threadId: agent?.thread_id as string, runId: agent?.id as string },
  };
}
const slackEffect = async (runId: string) => (await effectsOf(runId)).find((e) => e.channel === "slack");

beforeAll(async () => {
  ({ s } = await verifiedSource(NOW));
  await member(s, s.userId, "maya@acme.example", "owner");
  await member(s, bob, "bob@acme.example");
  await s.tenant((tx) => setOrgTz(tx, actor(s), "Europe/Berlin", NOW));
}, 300_000);

afterAll(async () => {
  await s?.close();
});

describe("a routine's channels", () => {
  it("are the connected Slack's, for owners and admins", async () => {
    const spec = asking();
    const make = (slack: unknown[], who = actor(s)) =>
      s.tenant((tx) => createRoutine(tx, who, { spec, userIds: [], slack: slack as never }, NOW));
    expect(await problem(make([growth]))).toBe("Connect Slack first, in Settings → Slack.");
    await s.tenant((tx) =>
      connectSlack(
        { secrets: s.secrets },
        tx,
        { orgId: s.orgId, userId: s.userId },
        { teamId: TEAM, teamName: "Acme", teamDomain: "acme", botUserId: BOT },
        "xoxb-test",
      ),
    );
    expect(await problem(make([{ ...growth, teamId: "T0OTHERTEAM" }]))).toBe(
      "Pick channels from the Slack workspace connected here.",
    );
    expect(await problem(make([growth], actor(s, bob, false)))).toBe(
      "Only owners and admins can make routines that reach other people.",
    );
    const made = await make([growth, growth]);
    const [r] = await s.t.owner<{ slack: unknown[] }[]>`select slack from app.routine where id = ${made}`;
    expect(r?.slack).toEqual([growth]);
    // Changing it keeps the same checks.
    expect(
      await problem(
        s.tenant((tx) =>
          updateRoutine(tx, actor(s), made, { spec, userIds: [], slack: [{ ...growth, teamId: "T0X" }] }),
        ),
      ),
    ).toBe("Pick channels from the Slack workspace connected here.");
    await s.t.owner`update app.routine set deleted_at = now() where org_id = ${s.orgId}`;
  });

  it("are checked with Slack before saving: there, not archived, the bot in it, named as Slack names them", async () => {
    const info: Record<string, unknown> = {
      C0GROWTH01: { ok: true, channel: { id: "C0GROWTH01", name: "growth-team", is_member: true } },
      C0OLDNEWS1: { ok: true, channel: { id: "C0OLDNEWS1", name: "old-news", is_archived: true } },
      C0QUIET001: { ok: true, channel: { id: "C0QUIET001", name: "quiet", is_member: false } },
      C0PARTNER1: {
        ok: true,
        channel: { id: "C0PARTNER1", name: "partner-acme", is_member: true, is_ext_shared: true },
      },
      C0BOARD001: { ok: true, channel: { id: "C0BOARD001", name: "board", is_member: true, is_private: true } },
    };
    const { fetchImpl, calls } = fakeSlack({
      "conversations.info": (a) => info[a.get("channel") ?? ""] ?? { ok: false, error: "channel_not_found" },
    });
    const check = (channelIds: string[], who = { orgId: s.orgId, canManage: true }) =>
      checkRoutineChannels(
        { withTenant: s.deps.withTenant, secrets: s.secrets },
        who,
        channelIds.map((channelId) => ({ channelId, name: "whatever the browser said" })),
        fetchImpl,
      );
    // Someone who can't post to channels: refused before Slack is asked anything.
    expect(await problem(check(["C0GROWTH01"], { orgId: s.orgId, canManage: false }))).toBe(
      "Only owners and admins can make routines that reach other people.",
    );
    expect(calls).toHaveLength(0);
    expect(await check(["C0GROWTH01"])).toEqual([{ teamId: TEAM, channelId: "C0GROWTH01", name: "growth-team" }]);
    expect(calls[0]?.args.get("channel")).toBe("C0GROWTH01");
    expect(await problem(check(["C0OLDNEWS1"]))).toBe("#old-news is archived. Pick another channel.");
    expect(await problem(check(["C0QUIET001"]))).toBe(
      "OpenDash isn't in #quiet. Invite it there first: /invite @opendash in the channel.",
    );
    expect(await problem(check(["C0GONE0001"]))).toBe("A channel you picked isn't in Slack any more.");
    // People outside the company read a Slack Connect channel: a routine never posts there.
    expect(await problem(check(["C0PARTNER1"]))).toBe(
      "#partner-acme is shared with another company. A routine posts only to your workspace's own channels.",
    );
    // A private one is kept as private, so its name is shown only to whoever may know it.
    expect(await check(["C0BOARD001"])).toEqual([
      { teamId: TEAM, channelId: "C0BOARD001", name: "board", private: true },
    ]);
    expect(await problem(check(["not a channel"]))).toBe("Pick a Slack channel from the list.");
    const down = fakeSlack({ "conversations.info": () => new Response("", { status: 503 }) });
    expect(
      await problem(
        checkRoutineChannels(
          { withTenant: s.deps.withTenant, secrets: s.secrets },
          { orgId: s.orgId, canManage: true },
          [{ channelId: "C0GROWTH01" }],
          down.fetchImpl,
        ),
      ),
    ).toBe("Slack couldn't be reached to check the channels. Try again in a moment.");
  });
});

describe("a private channel", () => {
  it("is named to its routine's owner, owners and admins, and itself; to anyone else, and other channels, it's private", async () => {
    const board = { teamId: TEAM, channelId: "C0BOARD001", name: "board", private: true };
    const routine = await s.tenant((tx) =>
      createRoutine(tx, actor(s), { spec: asking(), userIds: [], slack: [growth, board] }, NOW),
    );
    const as = async (who: ReturnType<typeof actor>) =>
      sentenceText((await s.tenant((tx) => listRoutines(tx, who, { id: routine })))[0]?.sentence ?? []);
    const asks = `Every Monday at 07:00, ask “${SIGNUPS}” and send the answer to`;
    expect(await as(actor(s))).toBe(`${asks} #growth and #board.`);
    expect(await as(actor(s, bob, false))).toBe(`${asks} #growth and a private channel.`);
    expect(await s.tenant((tx) => channelSentence(tx, s.orgId, routine, "C0GROWTH01"))).toBe(
      `${asks} #growth and a private channel.`,
    );
    expect(await s.tenant((tx) => channelSentence(tx, s.orgId, routine, "C0BOARD001"))).toBe(
      `${asks} #growth and #board.`,
    );
    await s.t.owner`delete from app.routine where id = ${routine}`;
  });
});

describe("a post to a channel", () => {
  it("is queued per channel, composed as the workspace reads it, and posted once", async () => {
    const { routine, runId, answer } = await postedRun({ userIds: [s.userId] });
    const effects = await effectsOf(runId);
    expect(effects.map((e) => [e.channel, e.recipient_key, e.idempotency_key])).toEqual([
      ["email", `user:${s.userId}`, `routine_run:${runId}:email:user:${s.userId}`],
      ["slack", `slack:${TEAM}:C0GROWTH01`, `routine_run:${runId}:slack:${TEAM}:C0GROWTH01`],
    ]);
    const post = await slackEffect(runId);
    const { out, posts, rendered } = delivery([{ status: "sent", ts: "1712345.000100" }]);
    expect(
      await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: post?.id as string }, out),
    ).toBe("sent");
    expect(posts[0]).toMatchObject({ teamId: TEAM, channelId: "C0GROWTH01", attempt: 1, effectId: post?.id });
    // Read by the channel: nobody's "me", the routine's page, and the answer in its conversation, which the whole
    // workspace reads.
    expect(rendered[0]).toMatchObject({
      kind: "answer",
      routineUrl: `https://app.opendash.example/routines/${routine}`,
      answer: { ...answer, question: SIGNUPS, answer: "212 accounts signed up last week." },
    });
    expect(
      (await s.t.owner<{ visibility: string }[]>`select visibility from app.thread where id = ${answer.threadId}`)[0],
    ).toEqual({ visibility: "org" });
    // The people it emails are counted, never named: a channel may hold guests.
    expect(rendered[0]?.because).toBe(
      `Every Monday at 07:00, ask “${SIGNUPS}” and send the answer to 1 person by email and #growth.`,
    );
    expect(rendered[0]?.unsubscribeUrl).toBeUndefined();
    expect(await slackEffect(runId)).toMatchObject({ status: "sent", provider_ref: "1712345.000100" });
    // Delivered again (a duplicate job): nothing posted twice.
    expect(
      await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: post?.id as string }, out),
    ).toBe("skipped");
    expect(posts).toHaveLength(1);
    await s.t.owner`update app.routine set deleted_at = now() where org_id = ${s.orgId}`;
  });

  it("is retried only when it may not have gone, and the retry looks for it first", async () => {
    const { runId } = await postedRun();
    const post = (await slackEffect(runId))?.id as string;
    const { out, posts } = delivery([new SlackApiError("ratelimited"), { status: "sent", ts: "2.000" }]);
    await expect(deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: post }, out)).rejects.toThrow(
      SlackApiError,
    );
    expect(await slackEffect(runId)).toMatchObject({ status: "queued", receipt: { error: "Slack said: ratelimited" } });
    expect(await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: post }, out)).toBe("sent");
    expect(posts.map((p) => p.attempt)).toEqual([1, 2]);
    expect(
      (
        await runOf(
          (
            await s.t.owner<{ routine_id: string }[]>`
      select routine_id from app.routine_run where id = ${runId}`
          )[0]?.routine_id as string,
        )
      )?.status,
    ).toBe("delivered");
    // An attempt that stopped mid-post (the row left sending) is taken up again, and looks before it posts.
    const second = await postedRun();
    const stuck = (await slackEffect(second.runId))?.id as string;
    await s.t.owner`update app.effect set status = 'sending', attempt = 1 where id = ${stuck}`;
    const again = delivery([{ status: "sent", ts: "3.000" }]);
    expect(await deliverEffect({ ...s.deps, boss: s.boss }, { orgId: s.orgId, effectId: stuck }, again.out)).toBe(
      "sent",
    );
    expect(again.posts[0]?.attempt).toBe(2);
    await s.t.owner`update app.routine set deleted_at = now() where org_id = ${s.orgId}`;
  });

  it("settles without a retry when Slack refuses for good, or nobody can tell whether it went", async () => {
    const refused = await postedRun();
    const r = delivery([new SlackApiError("not_in_channel")]);
    expect(
      await deliverEffect(
        { ...s.deps, boss: s.boss },
        { orgId: s.orgId, effectId: (await slackEffect(refused.runId))?.id as string },
        r.out,
      ),
    ).toBe("failed");
    expect(await slackEffect(refused.runId)).toMatchObject({
      status: "failed",
      receipt: { error: "Slack refused it: not_in_channel." },
    });
    expect((await runOf(refused.routine))?.status).toBe("failed");
    const unsure = await postedRun();
    const u = delivery([{ status: "unknown", why: "timeout" }]);
    expect(
      await deliverEffect(
        { ...s.deps, boss: s.boss },
        { orgId: s.orgId, effectId: (await slackEffect(unsure.runId))?.id as string },
        u.out,
      ),
    ).toBe("unknown");
    expect((await slackEffect(unsure.runId))?.status).toBe("unknown");
    // Counted as a send that couldn't go: four in a row pause the routine.
    expect((await runOf(unsure.routine))?.status).toBe("failed");
    await s.t.owner`update app.routine set deleted_at = now() where org_id = ${s.orgId}`;
  });

  it("goes only while the routine still posts there, with what everyone can still read", async () => {
    const moved = await postedRun({ userIds: [s.userId] });
    await s.t.owner`update app.routine set slack = '[]'::jsonb where id = ${moved.routine}`;
    const d = delivery([]);
    expect(
      await deliverEffect(
        { ...s.deps, boss: s.boss },
        { orgId: s.orgId, effectId: (await slackEffect(moved.runId))?.id as string },
        d.out,
      ),
    ).toBe("suppressed");
    expect((await slackEffect(moved.runId))?.receipt.reason).toBe("The routine doesn't post there any more.");
    // Its conversation made its owner's alone since (as a routine's that reaches only her is): the owner reads it, the
    // whole workspace doesn't, so the channel gets nothing.
    const unshared = await postedRun();
    await s.t.owner`update app.thread set visibility = 'private', created_by = ${s.userId}
      where id = ${unshared.answer.threadId}`;
    expect(
      await deliverEffect(
        { ...s.deps, boss: s.boss },
        { orgId: s.orgId, effectId: (await slackEffect(unshared.runId))?.id as string },
        d.out,
      ),
    ).toBe("suppressed");
    expect((await slackEffect(unshared.runId))?.receipt.reason).toBe(
      "That answer isn't shared with the whole workspace.",
    );
    expect(d.posts).toHaveLength(0);
    // No Slack on this deployment: suppressed, saying so.
    const off = await postedRun();
    expect(
      await deliverEffect(
        { ...s.deps, boss: s.boss },
        { orgId: s.orgId, effectId: (await slackEffect(off.runId))?.id as string },
        { ...d.out, slack: null },
      ),
    ).toBe("suppressed");
    expect((await slackEffect(off.runId))?.receipt.reason).toBe("Slack isn't set up on this deployment.");
    await s.t.owner`update app.routine set deleted_at = now() where org_id = ${s.orgId}`;
  });
});

describe("posting once", () => {
  const input = {
    channelId: "C0GROWTH01",
    effectId: "0190a000-0000-7000-8000-0000000000e1",
    botUserId: BOT,
    since: NOW,
    text: "Every Monday at 07:00, ask “How many accounts signed up last week?” and send the answer to #growth.",
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "212 accounts signed up last week." } }],
  };
  const mine = {
    user: BOT,
    ts: "9.000",
    metadata: { event_type: "opendash_routine", event_payload: { effect: input.effectId } },
  };

  it("marks its post with its row, and a later attempt finds it rather than posting again", async () => {
    const first = fakeSlack({ "chat.postMessage": () => ({ ok: true, ts: "1.000" }) });
    expect(await postSlackOnce("xoxb", { ...input, attempt: 1 }, first.fetchImpl)).toEqual({
      status: "sent",
      ts: "1.000",
    });
    expect(first.calls.map((c) => c.method)).toEqual(["chat.postMessage"]);
    expect(JSON.parse(first.calls[0]?.args.get("metadata") ?? "{}")).toEqual({
      event_type: "opendash_routine",
      event_payload: { effect: input.effectId },
    });
    const found = fakeSlack({
      // Another app's message with the same mark doesn't count; the bot's does.
      "conversations.history": () => ({ ok: true, messages: [{ ...mine, user: "U0OTHERAPP", ts: "8.000" }, mine] }),
      "chat.postMessage": () => ({ ok: true, ts: "2.000" }),
    });
    expect(await postSlackOnce("xoxb", { ...input, attempt: 2 }, found.fetchImpl)).toEqual({
      status: "sent",
      ts: "9.000",
    });
    expect(found.calls.map((c) => c.method)).toEqual(["conversations.history"]);
    const missing = fakeSlack({
      "conversations.history": () => ({ ok: true, messages: [] }),
      "chat.postMessage": () => ({ ok: true, ts: "3.000" }),
    });
    expect(await postSlackOnce("xoxb", { ...input, attempt: 2 }, missing.fetchImpl)).toEqual({
      status: "sent",
      ts: "3.000",
    });
  });

  it("looks at the channel as it is now before posting: one shared with another company since gets nothing", async () => {
    const at = (channel: Record<string, unknown>) =>
      fakeSlack({
        "conversations.info": () => ({
          ok: true,
          channel: { id: "C0GROWTH01", name: "growth", is_member: true, ...channel },
        }),
        "chat.postMessage": () => ({ ok: true, ts: "5.000" }),
      });
    const post = (fetchImpl: typeof fetch) =>
      slackPoster(
        { withTenant: s.deps.withTenant, secrets: s.secrets },
        fetchImpl,
      )({
        ...input,
        orgId: s.orgId,
        teamId: TEAM,
        attempt: 1,
      });
    const fine = at({});
    expect(await post(fine.fetchImpl)).toEqual({ status: "sent", ts: "5.000" });
    expect(fine.calls.map((c) => c.method)).toEqual(["conversations.info", "chat.postMessage"]);
    const shared = at({ is_ext_shared: true });
    await expect(post(shared.fetchImpl)).rejects.toMatchObject({ code: "channel_external" });
    expect(shared.calls.map((c) => c.method)).toEqual(["conversations.info"]);
    expect(SLACK_FOR_GOOD.has("channel_external")).toBe(true);
  });

  it("says unknown when it can't look, posts its text when Slack refuses the blocks, and throws what to retry", async () => {
    const blind = fakeSlack({ "conversations.history": () => ({ ok: false, error: "ratelimited" }) });
    expect(await postSlackOnce("xoxb", { ...input, attempt: 3 }, blind.fetchImpl)).toEqual({
      status: "unknown",
      why: "ratelimited",
    });
    const plain = fakeSlack({
      "chat.postMessage": (a) => (a.has("blocks") ? { ok: false, error: "invalid_blocks" } : { ok: true, ts: "4.000" }),
    });
    expect(await postSlackOnce("xoxb", { ...input, attempt: 1 }, plain.fetchImpl)).toEqual({
      status: "sent",
      ts: "4.000",
    });
    const gone = fakeSlack({ "chat.postMessage": () => ({ ok: false, error: "is_archived" }) });
    await expect(postSlackOnce("xoxb", { ...input, attempt: 1 }, gone.fetchImpl)).rejects.toMatchObject({
      code: "is_archived",
    });
  });
});

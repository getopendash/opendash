// slack.reply through the real Chat SDK adapter, on Postgres, with a stand-in for Slack's Web API: a
// run asked from Slack, its events written while it "works", and what was said to Slack read back. Its steps as task
// cards in one message, the answer put in as the stream stops, marked with its run and part; the status line where
// Slack refuses the cards; a question's options as buttons, several as one form with Send; the answer as a PDF and the
// rows as CSV. Posted once whatever stops it: an attempt stopped at each step and a new one after it posts one answer;
// an older attempt coming back is fenced out; a shutdown hands off without a false error; three real failures give up
// and say where the answer is; Slack refusing it for good ends it.

import type { SlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { askFromSlack, connectSlack, type RunOutcome, rememberFact } from "@opendash/core";
import { type LearnedSource, learnedSource } from "@opendash/core/testing";
import { uuidv7 } from "@opendash/db";
import { withPublicOn, withTenantOn } from "@opendash/db/testing";
import type { Chat } from "chat";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  abandonSlackReply,
  addressed,
  createSlackBot,
  type DeliverDeps,
  deliverSlackReply,
  REPLY_EVENT,
  SlackReplyHandOff,
  statusLine,
} from "../src";
import { type FakeSlack, fakeSlack } from "./helpers/fake-slack";

const TEAM = { teamId: "T0ACME", teamName: "Acme Corp", teamDomain: "acme", botUserId: "U0BOT" };
let s: LearnedSource;
let fake: FakeSlack;
let bot: Chat;
let slack: SlackAdapter;
let deps: DeliverDeps;

beforeAll(async () => {
  s = await learnedSource();
  await s.t.owner`insert into auth.user (id, name, email, email_verified)
    values (${s.userId}, 'Priya Raman', 'priya@acme.test', true) on conflict (id) do update set name = excluded.name, email = excluded.email`;
  await s.t.owner`insert into auth.member (id, organization_id, user_id, role, created_at)
    values (${uuidv7()}, ${s.orgId}, ${s.userId}, 'member', now())
      on conflict (organization_id, user_id) do update set role = excluded.role`;
  const withPublic = <T>(fn: Parameters<typeof withPublicOn<T>>[1]) => withPublicOn(s.t.app, fn);
  await s.tenant((tx) =>
    connectSlack({ secrets: s.secrets }, tx, { orgId: s.orgId, userId: s.userId }, TEAM, "xoxb-acme"),
  );
  // The asker's Slack account, linked to them: a reply goes only to a linked member.
  await s.t.owner`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
    values (${s.orgId}, ${TEAM.teamId}, 'UPRIYA', ${s.userId})`;
  fake = await fakeSlack();
  const made = createSlackBot(
    {
      withTenant: s.deps.withTenant,
      withPublic,
      secrets: s.secrets,
      boss: async () => s.boss,
      deploymentKeys: { anthropic: true } as never,
      webUrl: "https://opendash.example",
    },
    { signingSecret: "unused", forwardingSecret: "unused", state: createMemoryState(), apiUrl: fake.url },
  );
  bot = made.bot;
  slack = made.slack;
  await bot.initialize();
  deps = {
    withTenant: s.deps.withTenant,
    withUser: (orgId, userId, fn) => withTenantOn(s.t.app, { orgId, userId }, fn),
    withPublic,
    secrets: s.secrets,
    webUrl: "https://opendash.example",
    pollMs: 10,
    status: { minGapMs: 0 },
  };
}, 300_000);

afterAll(async () => {
  await bot?.shutdown().catch(() => {});
  await fake?.close();
  await s?.close();
});

let n = 0;
/** A question asked from Slack, in a channel thread of its own: its run, thread and Slack thread. */
const question = async (text = "How many plans are there?") => {
  const ts = `17917${String(++n).padStart(5, "0")}.000100`;
  const asked = await askFromSlack(
    { withTenant: s.deps.withTenant, boss: s.boss, deploymentKeys: { anthropic: true } as never },
    {
      orgId: s.orgId,
      userId: s.userId,
      role: "member",
      teamId: TEAM.teamId,
      slackThreadId: `slack:C0REV:${ts}`,
      slackUserId: "UPRIYA",
      slackMessageId: ts,
      text,
      files: [],
    },
  );
  if (asked.kind !== "asked") throw new Error(asked.kind);
  let seq = 0;
  const event = async (type: string, data: Record<string, unknown>) => {
    seq += 1;
    await s.t.owner`insert into app.run_event (id, org_id, run_id, attempt, seq, type, data, created_at)
      values (${uuidv7()}, ${s.orgId}, ${asked.runId}, 1, ${seq}, ${type}, ${s.t.owner.json(data as never)}, now())`;
  };
  const end = async (outcome: object) => {
    await s.t.owner`update app.run set status = 'succeeded', finished_at = now(),
      outcome = ${s.t.owner.json(outcome as never)} where id = ${asked.runId}`;
    await event("run_end", { status: "succeeded" });
  };
  return { ...asked, ts, event, end, job: { orgId: s.orgId, runId: asked.runId } };
};

/** An answer outcome, as the gate leaves it. */
const answer = (rendered: string, over: Record<string, unknown> = {}): RunOutcome =>
  ({
    kind: "answer",
    status: "answered",
    verified: true,
    path: "unmodelled",
    markdown: "",
    rendered,
    interpretation: [],
    caveats: [],
    citations: [],
    values: [],
    problems: [],
    ...over,
  }) as unknown as RunOutcome;

/** The calls to Slack from here on. */
const from = () => {
  const start = fake.calls.length;
  return () => fake.calls.slice(start);
};

/** The messages in Slack marked as this run's answer. */
const answers = (runId: string) =>
  fake.messages.filter(
    (m) =>
      m.metadata?.event_type === REPLY_EVENT &&
      m.metadata.event_payload.run === runId &&
      m.metadata.event_payload.part === "answer",
  );

const until = async (ok: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const reply = async (runId: string) => {
  const [r] = await s.t.owner<{ status: string; attempt: number; failures: number; error: string | null }[]>`
    select status, attempt, failures, error from app.slack_reply where run_id = ${runId}`;
  return r;
};

describe("the status line", () => {
  it("shows the latest step at most every so often, says a long one again, and stops at clear", async () => {
    let clock = 0;
    const calls: unknown[][] = [];
    const line = statusLine(
      {
        startTyping: async (_t: string, status?: string) => void calls.push(["status", status]),
        endTyping: async () => void calls.push(["end"]),
      },
      "slack:D1:1.1",
      { minGapMs: 2_000, refreshMs: 60_000, now: () => clock },
    );
    await line.begin("Reading your question…");
    line.set("Reading the table plans…"); // too soon: waits for its turn…
    line.set("Running “Plans”…"); // …and the latest wins it
    await new Promise((r) => setTimeout(r, 2_100));
    clock = 2_500;
    line.set("Running “Plans”…"); // the same line, not said again
    clock = 70_000;
    line.set("Running “Plans”…"); // a minute on: said again, so Slack keeps it
    await line.clear();
    line.set("Too late");
    expect(calls).toEqual([
      ["status", undefined],
      ["status", "Reading your question…"],
      ["status", "Running “Plans”…"],
      ["status", "Running “Plans”…"],
      ["end"],
    ]);
  });
});

describe("a run's reply in Slack", () => {
  it("shows its steps as task cards in one message, and puts the answer in as the stream stops, marked", async () => {
    const q = await question();
    const calls = from();
    const delivered = deliverSlackReply(deps, bot, slack, q.job);
    await q.event("tool_started", { callId: "c1", tool: "sql_query", input: { title: "Plans", sql: "select 1" } });
    await until(() => calls().some((c) => c.method === "chat.appendStream"));
    await q.event("tool_result", { callId: "c1", tool: "sql_query", status: "succeeded", rows: 2 });
    await q.end(answer("Hi! Ask me about your plans."));
    expect(await delivered).toBe("done");

    // One message streamed to the asker in plan mode, its steps as cards.
    const [start] = calls().filter((c) => c.method === "chat.startStream");
    expect(start?.args).toMatchObject({
      channel: "C0REV",
      thread_ts: q.ts,
      task_display_mode: "plan",
      recipient_user_id: "UPRIYA",
      recipient_team_id: "T0ACME",
    });
    const cards = calls()
      .filter((c) => c.method === "chat.appendStream")
      .flatMap((c) => c.args.chunks as Record<string, unknown>[]);
    expect(cards.filter((c) => c.type === "task_update").map((c) => [c.id, c.status, c.output])).toEqual([
      ["question", "complete", undefined],
      ["c1", "in_progress", undefined],
      ["c1", "complete", "2 rows"],
    ]);
    // The answer put in as the stream stops, with its mark and its buttons under it (the way into OpenDash, 👍/👎);
    // one answer in Slack; nothing posted beside it (no numbers, no PDF); 👀 swapped for ✅.
    const [stop] = calls().filter((c) => c.method === "chat.stopStream");
    expect(stop?.args).toMatchObject({
      // Only the asker's conversation is in the thread: no need to name them.
      markdown_text: "Hi! Ask me about your plans.",
      metadata: { event_type: REPLY_EVENT, event_payload: { run: q.runId, part: "answer" } },
    });
    const under = JSON.stringify(stop?.args.blocks);
    for (const part of ['"opendash:open"', `/ask/${q.threadId}`, '"feedback_buttons"', `up:${q.runId}`]) {
      expect(under).toContain(part);
    }
    expect(answers(q.runId)).toHaveLength(1);
    expect(calls().some((c) => c.method === "chat.postMessage")).toBe(false);
    expect(
      calls()
        .filter((c) => c.method.startsWith("reactions."))
        .map((c) => [c.method, c.args.name]),
    ).toEqual([
      ["reactions.remove", "eyes"],
      ["reactions.add", "white_check_mark"],
    ]);
    expect(await reply(q.runId)).toMatchObject({ status: "done", attempt: 1, failures: 0 });

    // Done once: a retried job sends nothing.
    const again = from();
    expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("skipped");
    expect(again()).toEqual([]);
  });

  it("posts no answer to someone who left while it ran, though the reply had begun", async () => {
    const q = await question("And the quarter before?");
    await q.end(answer("Plans grew by 4."));
    const calls = from();
    // Their link goes once the run is followed, just before the answer would be posted.
    const leaving = {
      ...deps,
      checkpoint: async (step: string) => {
        if (step === "followed") {
          await s.t.owner`delete from app.slack_identity where org_id = ${s.orgId} and slack_user_id = 'UPRIYA'`;
        }
      },
    };
    try {
      expect(await deliverSlackReply(leaving, bot, slack, q.job)).toBe("skipped");
      expect(JSON.stringify(calls())).not.toContain("Plans grew by 4");
      expect(await reply(q.runId)).toMatchObject({ status: "failed" });
    } finally {
      await s.t.owner`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
        values (${s.orgId}, ${TEAM.teamId}, 'UPRIYA', ${s.userId}) on conflict do nothing`;
    }
  });

  it("posts nothing to someone whose Slack link went with their membership while it ran", async () => {
    const q = await question("And last month?");
    await s.t.owner`delete from app.slack_identity where org_id = ${s.orgId} and slack_user_id = 'UPRIYA'`;
    try {
      const calls = from();
      expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("skipped");
      expect(calls().filter((c) => c.method !== "auth.test")).toEqual([]);
      expect(await reply(q.runId)).toMatchObject({ status: "failed" });
    } finally {
      await s.t.owner`insert into app.slack_identity (org_id, team_id, slack_user_id, user_id)
        values (${s.orgId}, ${TEAM.teamId}, 'UPRIYA', ${s.userId})`;
    }
  });

  it("shows its steps on the status line where Slack refuses the cards; posts the answer marked, then the files", async () => {
    const q = await question();
    const queryRunId = uuidv7();
    await s.t.owner`insert into app.query_run (id, org_id, connection_id, requester_type, requester_id, mode, path,
        engine, title, compiled_sql, sql_hash, status, rows, truncated, result_schema, preview, sanity, created_at)
      values (${queryRunId}, ${s.orgId}, ${s.connectionId}, 'run', ${q.runId}, 'execute', 'raw_sql', 'agent_sql', 'Plans',
        'select name from plans', 'h', 'succeeded', 2, false, ${s.t.owner.json([{ name: "name", type: "text" }])},
        ${s.t.owner.json([["Growth"], ["Scale"]])}, '[]'::jsonb, now())`;
    fake.answer("chat.startStream", () => ({ ok: false, error: "not_allowed" }));
    const calls = from();
    try {
      const delivered = deliverSlackReply(deps, bot, slack, q.job);
      await q.event("tool_started", { callId: "c1", tool: "sql_query", input: { title: "Plans" } });
      await until(() =>
        calls().some((c) => c.method === "assistant.threads.setStatus" && c.args.status === "Running “Plans”…"),
      );
      await q.event("tool_result", { callId: "c1", tool: "sql_query", status: "succeeded", rows: 2, queryRunId });
      await q.end(
        answer("There are **2** plans.", {
          interpretation: ["All plans"],
          citations: [{ queryRunId }],
          charts: [
            {
              type: "bar",
              title: "Accounts by plan",
              horizontal: false,
              axis: { compact: true },
              categories: ["Growth", "Scale"],
              series: [
                {
                  name: "Accounts",
                  points: [12, 7].map((value, row) => ({
                    value,
                    display: String(value),
                    cell: { alias: "q1", queryRunId, row, column: "accounts" },
                  })),
                },
              ],
            },
          ],
        }),
      );
      expect(await delivered).toBe("done");
    } finally {
      fake.answer("chat.startStream", null);
    }
    const statuses = calls()
      .filter((c) => c.method === "assistant.threads.setStatus")
      .map((c) => c.args.status);
    expect(statuses.slice(0, 2)).toEqual(["Reading your question…", "Running “Plans”…"]);
    // The answer, posted the plain way with its mark: its words as a markdown block, what was checked under it, and
    // its buttons; then the PDF (named after the question) and the rows as CSV.
    const [posted] = calls().filter((c) => c.method === "chat.postMessage");
    expect(posted?.args).toMatchObject({
      channel: "C0REV",
      thread_ts: q.ts,
      metadata: { event_type: REPLY_EVENT, event_payload: { run: q.runId, part: "answer" } },
      // A link it holds isn't fetched by Slack on nobody's click (sent form-encoded, so as text).
      unfurl_links: "false",
      unfurl_media: "false",
    });
    const [body, checked] = (posted?.args.blocks ?? []) as {
      type: string;
      text?: string;
      elements?: { text: string }[];
    }[];
    expect(body?.type).toBe("markdown");
    expect(body?.text).toMatch(/^There are \*\*2\*\* plans\./);
    expect(checked?.elements?.[0]?.text).toBe("Every number checked against its query");
    expect(
      calls()
        .filter((c) => c.method === "files.getUploadURLExternal")
        .map((c) => c.args.filename),
    ).toEqual(["accounts-by-plan.png", "how-many-plans-are-there.pdf", "plans.csv"]);
    // Its chart as an image first, its values as its alt text; then the PDF and the CSV.
    const [image] = calls().filter((c) => c.method === "files.getUploadURLExternal");
    expect(image?.args.alt_text).toBe("Accounts by plan. Growth 12, Scale 7.");
    expect(answers(q.runId)).toHaveLength(1);
  });

  it("gives a question's options buttons of their own ids, and leaves the answer as it is when Slack refuses them", async () => {
    const q = await question("Which plans matter?");
    await q.end({ kind: "clarify", question: "Which do you mean?", options: ["Paying plans", "All plans"] });
    const said: unknown[][] = [];
    fake.answer("chat.postMessage", (a) => (a.blocks ? { ok: false, error: "invalid_blocks" } : null));
    const calls = from();
    try {
      expect(await deliverSlackReply({ ...deps, log: (msg, f) => void said.push([msg, f]) }, bot, slack, q.job)).toBe(
        "done",
      );
    } finally {
      fake.answer("chat.postMessage", null);
    }
    const [form] = calls().filter((c) => c.method === "chat.postMessage");
    const ids = JSON.stringify(form?.args.blocks).match(/opendash:option:\d/g);
    expect(ids).toEqual(["opendash:option:0", "opendash:option:1"]);
    expect(said).toContainEqual([
      "slack reply: its questions' choices weren't posted",
      { runId: q.runId, why: "invalid_blocks" },
    ]);
    expect(answers(q.runId)).toHaveLength(1);
  });

  it("puts plain 👍/👎 under the answer where Slack refuses its own feedback buttons", async () => {
    const q = await question();
    await q.end(answer("Rated the plain way."));
    fake.answer("chat.stopStream", (a) =>
      JSON.stringify(a.blocks ?? "").includes("feedback_buttons") ? { ok: false, error: "invalid_blocks" } : null,
    );
    const calls = from();
    try {
      expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
    } finally {
      fake.answer("chat.stopStream", null);
    }
    const stops = calls().filter((c) => c.method === "chat.stopStream");
    expect(stops).toHaveLength(2);
    expect(JSON.stringify(stops[1]?.args.blocks)).toContain('"opendash:rate:down"');
    expect(answers(q.runId)).toHaveLength(1);
  });

  it("asks several questions as one form with Send, marked as the reply's questions", async () => {
    const q = await question("How is adoption going?");
    await q.end({
      kind: "clarify",
      questions: [
        { question: "Which measure?", options: ["Orders", "Customers"], multiple: true },
        { question: "Which window?", options: ["Last year", "Last 3 months"] },
      ],
    });
    const calls = from();
    expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
    const [stop] = calls().filter((c) => c.method === "chat.stopStream");
    expect(String(stop?.args.markdown_text)).toMatch(/^A few questions before I answer:/);
    const [form] = calls().filter((c) => c.method === "chat.postMessage");
    expect(form?.args).toMatchObject({
      channel: "C0REV",
      thread_ts: q.ts,
      metadata: { event_payload: { run: q.runId, part: "questions" } },
    });
    const blocks = JSON.stringify(form?.args.blocks);
    for (const part of ['"checkboxes"', '"radio_buttons"', '"opendash:send"', q.runId]) expect(blocks).toContain(part);
  });
});

describe("a reply posted once", () => {
  // Where an attempt can stop (a worker killed, a deploy): each followed by a new attempt, which must leave exactly
  // one answer in Slack, and one message of steps (the new attempt carries on in the one the first started).
  const stops = ["began", "followed", "claimed answer", "posted answer", "recorded answer"];
  for (const at of stops) {
    it(`posts one answer when an attempt stopped once it had ${at}`, async () => {
      const q = await question();
      await q.end(answer(`Stopped once it had ${at}.`));
      const all = from();
      let reached = false;
      // The first attempt never comes back from the step: as good as a process killed there.
      void deliverSlackReply(
        {
          ...deps,
          checkpoint: (step) => {
            if (step !== at) return;
            reached = true;
            return new Promise<void>(() => {});
          },
        },
        bot,
        slack,
        q.job,
      );
      await until(() => reached);
      const calls = from();
      expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
      expect(answers(q.runId)).toHaveLength(1);
      expect(await reply(q.runId)).toMatchObject({ status: "done", attempt: 2 });
      expect(all().filter((c) => c.method === "chat.startStream")).toHaveLength(1);
      // One that may have posted it already looked in the thread first, and found it; the cards were stopped (Slack
      // had stopped them with the answer already).
      if (at === "posted answer") {
        expect(calls().some((c) => c.method === "conversations.replies" && c.args.include_all_metadata)).toBe(true);
        expect(calls().some((c) => c.method === "chat.stopStream" && c.args.markdown_text)).toBe(false);
        expect(calls().filter((c) => c.method === "chat.stopStream")).toHaveLength(1);
      }
    });
  }

  it("trusts a mark in the thread only when OpenDash's own bot posted it", async () => {
    const q = await question();
    await q.end(answer("The real answer."));
    // An earlier attempt claimed the answer and stopped; meanwhile someone else's app put OpenDash's mark on a message.
    await s.t
      .owner`insert into app.slack_reply_message (org_id, run_id, part) values (${s.orgId}, ${q.runId}, 'answer')`;
    fake.messages.push({
      channel: "C0REV",
      ts: "1791799999.000100",
      thread_ts: q.ts,
      user: "UMALLORY",
      text: "Nothing to see here.",
      metadata: { event_type: REPLY_EVENT, event_payload: { run: q.runId, part: "answer" } },
    });
    const calls = from();
    expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
    // The run had ended (its answer was begun) and no steps were shown: none now.
    expect(calls().some((c) => c.method === "chat.startStream")).toBe(false);
    // The answer was posted all the same, by OpenDash.
    const ours = answers(q.runId).filter((m) => m.user === "U0BOT");
    expect(ours).toHaveLength(1);
    expect(ours[0]?.text).toContain("The real answer.");
  });

  it("fences out an older attempt that comes back after a newer one finished", async () => {
    const q = await question();
    await q.end(answer("Only once."));
    let resume: () => void = () => {};
    let reached = false;
    const older = deliverSlackReply(
      {
        ...deps,
        checkpoint: (step) => {
          if (step !== "followed") return;
          reached = true;
          return new Promise<void>((r) => {
            resume = r;
          });
        },
      },
      bot,
      slack,
      q.job,
    );
    await until(() => reached);
    expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
    resume();
    expect(await older).toBe("skipped");
    expect(answers(q.runId)).toHaveLength(1);
  });

  it("hands off at a shutdown without saying anything went wrong, and the next attempt answers", async () => {
    const q = await question();
    const drain = new AbortController();
    const calls = from();
    const handing = deliverSlackReply(deps, bot, slack, q.job, drain.signal);
    await until(() => calls().some((c) => c.method === "chat.startStream"));
    drain.abort();
    await expect(handing).rejects.toBeInstanceOf(SlackReplyHandOff);
    // Nothing said; the steps left open for the next attempt; not a failure.
    expect(calls().some((c) => c.method === "chat.postMessage")).toBe(false);
    expect(calls().some((c) => c.method === "chat.stopStream")).toBe(false);
    expect(await reply(q.runId)).toMatchObject({ status: "streaming", failures: 0 });
    await q.end(answer("Answered after the hand-off."));
    expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
    expect(answers(q.runId)).toHaveLength(1);
    // The next attempt carried on in the same message, and put the answer in it.
    const ours = fake.messages.filter((m) => m.thread_ts === q.ts && m.user === "U0BOT");
    expect(ours).toHaveLength(1);
    expect(calls().filter((c) => c.method === "chat.startStream")).toHaveLength(1);
    const [stop] = calls().filter((c) => c.method === "chat.stopStream" && c.args.markdown_text);
    expect(stop?.args.ts).toBe(ours[0]?.ts);
  });

  it("starts a new message of steps when Slack closed the earlier attempt's meanwhile", async () => {
    const q = await question();
    await q.end(answer("Answered in a new message."));
    const all = from();
    let reached = false;
    void deliverSlackReply(
      {
        ...deps,
        checkpoint: (step) => {
          if (step !== "followed") return;
          reached = true;
          return new Promise<void>(() => {});
        },
      },
      bot,
      slack,
      q.job,
    );
    await until(() => reached);
    fake.answer("chat.appendStream", () => ({ ok: false, error: "message_not_in_streaming_state" }));
    try {
      expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("done");
    } finally {
      fake.answer("chat.appendStream", null);
    }
    const started = all().filter((c) => c.method === "chat.startStream");
    expect(started).toHaveLength(2);
    expect(answers(q.runId)).toHaveLength(1);
    // The answer in the second message, which the next attempt would carry on in.
    const [stop] = all().filter((c) => c.method === "chat.stopStream" && c.args.markdown_text);
    const [steps] = await s.t.owner<{ ts: string }[]>`
      select ts from app.slack_reply_message where run_id = ${q.runId} and part = 'steps'`;
    expect(stop?.args.ts).toBe(steps?.ts);
    expect(answers(q.runId)[0]?.ts).toBe(steps?.ts);
  });

  it("gives up after three real failures, saying once where the answer is", async () => {
    const q = await question();
    await q.end(answer("Slack keeps refusing this."));
    // Slack fails the answer every time (the stream too), but not a plain message.
    fake.answer("chat.startStream", () => ({ ok: false, error: "not_allowed" }));
    fake.answer("chat.postMessage", (a) =>
      JSON.stringify(a.blocks ?? "").includes("Slack keeps") ? { ok: false, error: "internal_error" } : null,
    );
    try {
      for (let i = 0; i < 2; i++) await expect(deliverSlackReply(deps, bot, slack, q.job)).rejects.toThrow();
      expect(await reply(q.runId)).toMatchObject({ status: "streaming", failures: 2, error: "internal_error" });
      expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("failed");
    } finally {
      fake.answer("chat.startStream", null);
      fake.answer("chat.postMessage", null);
    }
    expect(await reply(q.runId)).toMatchObject({ status: "failed", failures: 3 });
    const told = fake.messages.filter(
      (m) => m.metadata?.event_payload.part === "gave_up" && m.metadata.event_payload.run === q.runId,
    );
    expect(told).toHaveLength(1);
    expect(told[0]?.text).toContain(`https://opendash.example/ask/${q.threadId}`);
  });

  it("ends when Slack refuses it for good", async () => {
    const q = await question();
    await q.end(answer("Nowhere to go."));
    fake.answer("chat.startStream", () => ({ ok: false, error: "channel_not_found" }));
    fake.answer("chat.postMessage", () => ({ ok: false, error: "channel_not_found" }));
    try {
      expect(await deliverSlackReply(deps, bot, slack, q.job)).toBe("failed");
    } finally {
      fake.answer("chat.startStream", null);
      fake.answer("chat.postMessage", null);
    }
    expect(await reply(q.runId)).toMatchObject({ status: "failed", failures: 0 });
  });

  it("tells the person where the answer is when the queue gives up on the reply, once", async () => {
    const q = await question();
    // An attempt handed off with its steps open, and none came after.
    const drain = new AbortController();
    const handing = deliverSlackReply(deps, bot, slack, q.job, drain.signal);
    const calls = from();
    await until(() => calls().some((c) => c.method === "chat.startStream"));
    drain.abort();
    await expect(handing).rejects.toBeInstanceOf(SlackReplyHandOff);
    await q.end(answer("Never posted."));
    expect(await abandonSlackReply(deps, bot, slack, q.job)).toBe(true);
    // Its steps stopped as they were.
    const [steps] = await s.t.owner<{ ts: string }[]>`
      select ts from app.slack_reply_message where run_id = ${q.runId} and part = 'steps'`;
    expect(calls().some((c) => c.method === "chat.stopStream" && c.args.ts === steps?.ts)).toBe(true);
    expect(await reply(q.runId)).toMatchObject({ status: "failed" });
    const told = fake.messages.filter(
      (m) => m.metadata?.event_payload.part === "gave_up" && m.metadata.event_payload.run === q.runId,
    );
    expect(told).toHaveLength(1);
    // Finished: the dead letter coming twice says nothing more.
    expect(await abandonSlackReply(deps, bot, slack, q.job)).toBe(false);
  });
});

describe("what the answer remembered", () => {
  it("is said under it, with Undo, for its asker", async () => {
    const q = await question();
    const who = { orgId: s.orgId, userId: s.userId };
    const kept = await withTenantOn(s.t.app, who, (tx) =>
      rememberFact(tx, who, { fact: "Plans means the paid plans", why: "correction", about: "plans", runId: q.runId }),
    );
    const calls = from();
    const delivered = deliverSlackReply(deps, bot, slack, q.job);
    await q.end(answer("There are 2 paid plans."));
    expect(await delivered).toBe("done");
    const [stop] = calls().filter((c) => c.method === "chat.stopStream");
    const under = JSON.stringify(stop?.args.blocks);
    expect(under).toContain("Remembered for its asker: “Plans means the paid plans”");
    expect(under).toContain(kept.id);
  });
});

describe("a reply in a channel's thread", () => {
  it("names its asker when someone else has a conversation in the same thread", async () => {
    const q = await question();
    await s.t.owner`insert into app.slack_conversation (org_id, team_id, slack_thread_id, slack_user_id, thread_id)
      values (${s.orgId}, ${TEAM.teamId}, ${`slack:C0REV:${q.ts}`}, 'UOTHER', ${q.threadId})`;
    const calls = from();
    const delivered = deliverSlackReply(deps, bot, slack, q.job);
    await q.end(answer("There are 2 plans."));
    expect(await delivered).toBe("done");
    const [stop] = calls().filter((c) => c.method === "chat.stopStream");
    expect(stop?.args.markdown_text).toBe("<@UPRIYA> There are 2 plans.");
  });

  it("starts by naming its asker, on its own line before a heading, a list, a table, a quote or code", () => {
    expect(addressed("UPRIYA", "MRR grew 4%.")).toBe("<@UPRIYA> MRR grew 4%.");
    for (const start of ["## Top plans", "- Growth", "1. Growth", "| Plan |", "> Note", "```sql"]) {
      expect(addressed("UPRIYA", start)).toBe(`<@UPRIYA>\n\n${start}`);
    }
  });
});

// A run's steps as Slack task cards (after the first live test), with a stand-in for Slack's stream calls:
// each tool call a card, in progress then complete (or failed), a query's rows as its output; one streamed message
// in plan mode, to the asker in a channel; the answer in at the end and the stream stopped; a new message after
// the stream's age, replaying what's still open; and Slack refusing the stream said plainly.
import { describe, expect, it } from "vitest";
import { cardsAfter, cardTitle, type StreamClient, taskCards } from "../src/progress";

const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ seq, type, data });

describe("a run's steps as cards", () => {
  it("are one card a tool call, in progress then complete or failed, a query's rows its output", () => {
    const titles = new Map<string, string>();
    expect(
      cardsAfter(
        [
          ev(1, "tool_started", { callId: "c1", tool: "sql_query", input: { title: "Customers by users" } }),
          ev(2, "tool_result", { callId: "c1", tool: "sql_query", status: "succeeded", rows: 42 }),
          ev(3, "tool_started", { callId: "c2", tool: "read", input: { path: "/sources/w/tables/orgs.md" } }),
          ev(4, "input_joined", {}),
          ev(5, "tool_result", { callId: "c2", tool: "read", status: "failed" }),
          ev(6, "delta", { text: "…" }),
        ],
        titles,
      ),
    ).toEqual([
      { type: "task_update", id: "c1", title: "Running “Customers by users”", status: "in_progress" },
      { type: "task_update", id: "c1", title: "Running “Customers by users”", status: "complete", output: "42 rows" },
      { type: "task_update", id: "c2", title: "Reading the table orgs", status: "in_progress" },
      { type: "task_update", id: "input-4", title: "Reading your follow-up", status: "complete" },
      {
        type: "task_update",
        id: "c2",
        title: "Reading the table orgs",
        status: "complete",
        output: "Didn't work, trying another way",
      },
    ]);
    expect(cardTitle(`${"x".repeat(300)}…`)).toHaveLength(256);
  });
});

/** A stand-in for Slack's chat stream calls, recording them; `refuse` makes Slack refuse a call. */
function slackStream(refuse: Partial<Record<"start" | "append" | "stop", string>> = {}) {
  const calls: [string, Record<string, unknown>][] = [];
  let n = 0;
  const fail = (code: string) => Object.assign(new Error(code), { data: { error: code } });
  const client: StreamClient = {
    chat: {
      startStream: async (args) => {
        calls.push(["start", args]);
        if (refuse.start) throw fail(refuse.start);
        n += 1;
        return { ts: `9.${n}` };
      },
      appendStream: async (args) => {
        calls.push(["append", args]);
        if (refuse.append) {
          const code = refuse.append;
          delete refuse.append;
          throw fail(code);
        }
        return {};
      },
      stopStream: async (args) => {
        calls.push(["stop", args]);
        if (refuse.stop) throw fail(refuse.stop);
        return {};
      },
    },
  };
  return { client, calls };
}

const where = { channel: "C0REV", threadTs: "1.1", recipientUserId: "UPRIYA", recipientTeamId: "T0ACME" };
const task = (id: string, status: string) => ({ type: "task_update", id, title: id, status });

describe("the cards' message", () => {
  it("is one streamed message in plan mode, to the asker in a channel, the answer in as it stops", async () => {
    const { client, calls } = slackStream();
    const cards = taskCards(client, where);
    expect(await cards.open()).toEqual({ ok: true });
    cards.update([task("c1", "in_progress")] as never);
    cards.update([task("c1", "complete"), task("c2", "in_progress")] as never);
    const meta = { event_type: "opendash_reply", event_payload: { run: "r1", part: "answer" } };
    expect(await cards.finish("There are **2** plans.", { metadata: meta })).toBe("9.1");
    expect(calls).toEqual([
      [
        "start",
        {
          channel: "C0REV",
          thread_ts: "1.1",
          task_display_mode: "plan",
          recipient_user_id: "UPRIYA",
          recipient_team_id: "T0ACME",
          chunks: [{ type: "task_update", id: "question", title: "Reading your question", status: "in_progress" }],
        },
      ],
      ["append", { channel: "C0REV", ts: "9.1", chunks: [task("c1", "in_progress")] }],
      ["append", { channel: "C0REV", ts: "9.1", chunks: [task("c1", "complete"), task("c2", "in_progress")] }],
      // What's still open is done; then the answer, all at once, with its mark, as the stream stops.
      [
        "append",
        {
          channel: "C0REV",
          ts: "9.1",
          chunks: [
            { type: "task_update", id: "question", title: "Reading your question", status: "complete" },
            { ...task("c2", "complete") },
          ],
        },
      ],
      ["stop", { channel: "C0REV", ts: "9.1", markdown_text: "There are **2** plans.", metadata: meta }],
    ]);
  });

  it("needs no recipient in a DM, and says so when Slack refuses the stream", async () => {
    const dm = slackStream();
    expect(await taskCards(dm.client, { ...where, channel: "D0PRIYA" }).open()).toEqual({ ok: true });
    expect(dm.calls[0]?.[1]).not.toHaveProperty("recipient_user_id");
    // Refused, with Slack's reason, for the worker's log.
    const refused = slackStream({ start: "not_allowed_token_type" });
    expect(await taskCards(refused.client, where).open()).toEqual({ ok: false, error: "not_allowed_token_type" });
  });

  it("goes on in a new message after the stream's age, or once Slack has closed it, replaying what's open", async () => {
    let clock = 0;
    const { client, calls } = slackStream();
    const cards = taskCards(client, where, { maxAgeMs: 1_000, now: () => clock });
    await cards.open();
    cards.update([task("c1", "in_progress")] as never);
    // Updates go out in order, each after the one before: let this one out before the clock moves on.
    await new Promise((r) => setTimeout(r, 0));
    clock = 1_500;
    cards.update([task("c2", "in_progress")] as never);
    await cards.finish("Done.");
    const kinds = calls.map(([k, a]) => `${k} ${String(a.ts ?? "")}`.trim());
    // The first message stopped (the session kept busy), a second started with the open cards and the new one, the
    // answer in it as it stops.
    expect(kinds).toEqual(["start", "append 9.1", "stop 9.1", "start", "append 9.2", "stop 9.2"]);
    expect(calls[5]?.[1]).toMatchObject({ markdown_text: "Done." });
    expect(calls[2]?.[1]).toMatchObject({ session_status: "processing" });
    expect(((calls[3]?.[1].chunks ?? []) as { id: string }[]).map((c) => c.id)).toEqual(["question", "c1", "c2"]);

    // A batch that only completes cards, after the age: the new message starts with them, never with nothing.
    let later = 0;
    const done = slackStream();
    const finishing = taskCards(done.client, where, { maxAgeMs: 1_000, now: () => later });
    await finishing.open();
    finishing.update([{ type: "task_update", id: "question", title: "q", status: "complete" }] as never);
    await new Promise((r) => setTimeout(r, 0));
    later = 1_500;
    finishing.update([task("c1", "complete")] as never);
    await finishing.finish("Done.");
    const restarted = done.calls.filter(([k]) => k === "start")[1]?.[1].chunks;
    expect(restarted).toEqual([task("c1", "complete")]);

    // Slack closed it early: the append is refused as not streaming, and a new message carries on.
    const closed = slackStream();
    const again = taskCards(closed.client, where);
    await again.open();
    closed.calls.length = 0;
    (closed as { client: StreamClient }).client.chat.appendStream = async (args) => {
      closed.calls.push(["append", args]);
      throw Object.assign(new Error("closed"), { data: { error: "message_not_in_streaming_state" } });
    };
    await again.finish("Done.");
    expect(closed.calls.map(([k]) => k)).toEqual(["append", "start", "stop"]);
    expect(closed.calls[2]?.[1]).toMatchObject({ markdown_text: "Done." });
  });

  it("throws when the answer didn't go in, so the caller looks for it and posts it the plain way", async () => {
    const { client } = slackStream({ stop: "rate_limited" });
    const cards = taskCards(client, where);
    await cards.open();
    await expect(cards.finish("Done.")).rejects.toThrow("rate_limited");
  });

  it("leaves its message open at a hand-off, and a later attempt carries on in it", async () => {
    const { client, calls } = slackStream();
    const started: string[] = [];
    const cards = taskCards(client, where, { onStart: async (ts) => void started.push(ts) });
    await cards.open();
    await cards.close({ handOff: true });
    expect(calls.map(([kind]) => kind)).toEqual(["start"]);
    expect(started).toEqual(["9.1"]);

    // The next attempt: nothing new started, its cards and answer in the same message.
    const again = taskCards(client, where, { resume: { ts: "9.1", startedAt: Date.now() } });
    expect(await again.open()).toEqual({ ok: true });
    again.update([{ type: "task_update", id: "c1", title: "Running “Plans”", status: "complete" }]);
    expect(await again.finish("Done.")).toBe("9.1");
    expect(calls.filter(([kind]) => kind === "start")).toHaveLength(1);
  });

  it("starts a new message when the one it carries on in is refused, whatever Slack says", async () => {
    const { client, calls } = slackStream({ append: "message_not_found" });
    const started: string[] = [];
    const cards = taskCards(client, where, {
      resume: { ts: "8.1", startedAt: Date.now() },
      onStart: async (ts) => void started.push(ts),
    });
    await cards.open();
    expect(await cards.finish("Done.")).toBe("9.1");
    expect(started).toEqual(["9.1"]);
    expect(calls.map(([kind]) => kind)).toEqual(["append", "start", "stop"]);
  });
});

// Which of Slack's events carry a question, recorded before Slack hears it arrived: a DM, a mention and
// its twin (one key for both), a press of the bot's own buttons; never a channel message not addressed to it, a bot's
// post, an edit, or a tick in a question's form. The key a handler marks is the key the gate recorded, and a request
// to the event route reads as the envelope the socket would have sent.
import { describe, expect, it } from "vitest";
import { DEDUPE_TTL_MS, envelopeOfRequest, homeOpenedOf, inboundKeyOf, inboundOf, REPLAY_AFTER_MS } from "../src";

const BOT = "U0BOT";
const message = (event: Record<string, unknown>) => ({
  eventType: "events_api",
  body: { type: "event_callback", team_id: "T1", event: { type: "message", user: "UPRIYA", ...event } },
});
const press = (actionId: string, extra: Record<string, unknown> = {}) => ({
  eventType: "interactive",
  body: {
    type: "block_actions",
    trigger_id: "1234.5678.abcd",
    team: { id: "T1" },
    user: { id: "UPRIYA" },
    channel: { id: "C1" },
    message: { ts: "1791700001.000200", thread_ts: "1791700000.000100" },
    actions: [{ action_id: actionId, value: "x" }],
    ...extra,
  },
});

describe("a question from Slack", () => {
  it("is a DM, a mention, or its twin naming the bot, under one key for the twins", () => {
    const dm = inboundOf(message({ channel: "D1", channel_type: "im", ts: "1791700000.000100", text: "MRR?" }), BOT);
    expect(dm).toEqual({
      teamId: "T1",
      key: "m:D1:1791700000.000100",
      kind: "message",
      slackThreadId: "slack:D1:1791700000.000100",
      slackUserId: "UPRIYA",
    });
    const mention = {
      eventType: "events_api",
      body: {
        type: "event_callback",
        team_id: "T1",
        event: {
          type: "app_mention",
          user: "UPRIYA",
          channel: "C1",
          ts: "1791700002.000300",
          thread_ts: "1791700000.000100",
          text: `<@${BOT}> churn?`,
        },
      },
    };
    const twin = message({
      channel: "C1",
      channel_type: "channel",
      ts: "1791700002.000300",
      thread_ts: "1791700000.000100",
      text: `<@${BOT}> churn?`,
    });
    expect(inboundOf(mention, BOT)?.key).toBe("m:C1:1791700002.000300");
    expect(inboundOf(twin, BOT)).toEqual(inboundOf(mention, BOT));
    expect(inboundOf(mention, BOT)?.slackThreadId).toBe("slack:C1:1791700000.000100");
  });

  it("is never a channel message not addressed to the bot, a bot's post, an edit, or a team-less event", () => {
    const at = { channel: "C1", channel_type: "channel", ts: "1791700003.000400" };
    expect(inboundOf(message({ ...at, text: "lunch?" }), BOT)).toBeNull();
    expect(inboundOf(message({ ...at, text: `<@${BOT}> hi`, bot_id: "B1" }), BOT)).toBeNull();
    expect(inboundOf(message({ ...at, text: `<@${BOT}> hi`, subtype: "message_changed" }), BOT)).toBeNull();
    // A file shared with the question is still someone writing.
    expect(inboundOf(message({ ...at, text: `<@${BOT}> this`, subtype: "file_share" }), BOT)).not.toBeNull();
    expect(
      inboundOf({ eventType: "events_api", body: { type: "event_callback", event: { type: "message" } } }, BOT),
    ).toBeNull();
    // A team OpenDash doesn't know has no bot to name: only a DM or a mention still reads as a question.
    expect(inboundOf(message({ ...at, text: `<@${BOT}> hi` }), "")).toBeNull();
  });

  it("is a press of the bot's own buttons, keyed by the press, never a tick in a form or another app's button", () => {
    expect(inboundOf(press("opendash:option:1"), BOT)).toEqual({
      teamId: "T1",
      key: "a:1234.5678.abcd",
      kind: "press",
      slackThreadId: "slack:C1:1791700000.000100",
      slackUserId: "UPRIYA",
    });
    expect(inboundOf(press("opendash:send"), BOT)?.key).toBe("a:1234.5678.abcd");
    expect(inboundOf(press("opendash:pick:0"), BOT)).toBeNull();
    expect(inboundOf(press("someone-else:button"), BOT)).toBeNull();
    // 👍/👎, the way into OpenDash and App Home's buttons ask nothing; a follow-up does.
    for (const id of ["opendash:feedback", "opendash:rate:up", "opendash:open", "opendash:home:link"]) {
      expect(inboundOf(press(id), BOT)).toBeNull();
    }
    expect(inboundOf(press("opendash:next:0"), BOT)?.kind).toBe("press");
  });

  it("is marked by the handler under the key it was recorded with", () => {
    const dm = message({ channel: "D1", channel_type: "im", ts: "1791700000.000100", text: "MRR?" });
    expect(inboundKeyOf(dm.body.event)).toBe(inboundOf(dm, BOT)?.key);
    const pressed = press("opendash:option:0");
    expect(inboundKeyOf(pressed.body)).toBe(inboundOf(pressed, BOT)?.key);
    expect(inboundKeyOf({})).toBeNull();
  });

  it("reads a request to the event route as the envelope the socket would send", () => {
    const callback = { type: "event_callback", team_id: "T1", event: { type: "app_mention" } };
    expect(envelopeOfRequest("application/json", JSON.stringify(callback))).toEqual({
      eventType: "events_api",
      body: callback,
    });
    const payload = { type: "block_actions", trigger_id: "t" };
    const form = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    expect(envelopeOfRequest("application/x-www-form-urlencoded", form)).toEqual({
      eventType: "interactive",
      body: payload,
    });
    // Slack's address check and anything unreadable go to the bot as they are.
    expect(envelopeOfRequest("application/json", JSON.stringify({ type: "url_verification" }))).toBeNull();
    expect(envelopeOfRequest("application/json", "{")).toBeNull();
  });

  it("is handed to the bot again only once Chat SDK has forgotten it", () => {
    expect(REPLAY_AFTER_MS).toBeGreaterThan(DEDUPE_TTL_MS);
  });

  it("reads App Home's tab opening, never its Messages tab", () => {
    const opened = (tab: string) => ({
      eventType: "events_api",
      body: { type: "event_callback", team_id: "T1", event: { type: "app_home_opened", tab, user: "UPRIYA" } },
    });
    expect(homeOpenedOf(opened("home"))).toEqual({ teamId: "T1", userId: "UPRIYA" });
    expect(homeOpenedOf(opened("messages"))).toBeNull();
  });
});

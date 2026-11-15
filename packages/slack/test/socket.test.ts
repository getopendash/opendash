// OpenDash's own Socket Mode connection, without Slack: Slack taking the app back recorded there, then
// acknowledged (not acknowledged when it couldn't be, so Slack sends it again), never forwarded; a question recorded
// (the gate) before it's acknowledged, a retry or twin of one recorded not handed on, one that couldn't be recorded
// left unacknowledged; anything else acknowledged and handed to the adapter's forwarded-event entry, signed with the
// forwarding secret, the work it starts kept.
import { describe, expect, it } from "vitest";
import { socketHandler } from "../src";

describe("an event over OpenDash's socket", () => {
  it("records a removal, then acknowledges it; acknowledges anything else, then forwards it to the adapter", async () => {
    const log: unknown[][] = [];
    const forwarded: { headers: Record<string, string>; body: unknown }[] = [];
    const removals: unknown[] = [];
    const tracked: Promise<unknown>[] = [];
    const handle = socketHandler(
      {
        forwardingSecret: "the-secret",
        slack: {
          handleWebhook: async (request: Request, options?: { waitUntil?: (task: Promise<unknown>) => void }) => {
            forwarded.push({ headers: Object.fromEntries(request.headers), body: await request.json() });
            options?.waitUntil?.(Promise.resolve("work"));
            return new Response("ok");
          },
        } as never,
        onRemoval: async (removal) => void removals.push(removal),
        gate: async () => "forward",
        log: (msg, fields) => void log.push([msg, fields]),
      },
      (task) => void tracked.push(task),
    );
    const order: string[] = [];
    const ack = async () => void order.push("ack");

    await handle({
      ack: async () => void order.push(`ack after ${removals.length} recorded`),
      type: "events_api",
      body: { type: "event_callback", team_id: "T1", event: { type: "app_uninstalled" } },
    });
    expect(removals).toEqual([{ teamId: "T1", why: "uninstalled", eventTime: null }]);
    expect(order).toEqual(["ack after 1 recorded"]);
    expect(forwarded).toHaveLength(0);
    order.length = 0;

    const mention = { type: "event_callback", team_id: "T1", event: { type: "app_mention", text: "hi" } };
    await handle({ ack, type: "events_api", body: mention, retry_num: 1 });
    await handle({ ack, type: "interactive", body: { type: "block_actions" } });
    expect(order).toEqual(["ack", "ack"]);
    expect(forwarded.map((f) => f.headers["x-slack-socket-token"])).toEqual(["the-secret", "the-secret"]);
    expect(forwarded[0]?.body).toMatchObject({
      type: "socket_event",
      eventType: "events_api",
      body: mention,
      retryNum: 1,
    });
    expect(forwarded[1]?.body).toMatchObject({ eventType: "interactive", body: { type: "block_actions" } });
    // The work each forwarded event started is kept, so stopping waits for it.
    expect(tracked).toHaveLength(2);
    expect(log).toEqual([]);
  });

  it("says when the adapter didn't take an event, and leaves a removal it couldn't record unacknowledged", async () => {
    const log: string[] = [];
    let acked = 0;
    const handle = socketHandler(
      {
        forwardingSecret: "s",
        slack: { handleWebhook: async () => new Response("no", { status: 401 }) } as never,
        onRemoval: async () => {
          throw new Error("database down");
        },
        gate: async () => "forward",
        log: (msg) => void log.push(msg),
      },
      () => {},
    );
    await handle({
      ack: async () => {},
      type: "events_api",
      body: { type: "event_callback", team_id: "T1", event: {} },
    });
    await handle({
      ack: async () => void acked++,
      type: "events_api",
      body: { type: "event_callback", team_id: "T1", event: { type: "app_uninstalled" } },
    });
    expect(log).toEqual(["slack event not handled", "slack removal not recorded"]);
    // Slack sends an unacknowledged event again: the removal gets another chance.
    expect(acked).toBe(0);
  });

  it("records a question before acknowledging it, hands on only its first delivery, and waits on a failed record", async () => {
    const order: string[] = [];
    const forwarded: unknown[] = [];
    const verdicts: ("forward" | "skip" | "fail")[] = ["forward", "skip", "fail"];
    const log: string[] = [];
    const handle = socketHandler(
      {
        forwardingSecret: "s",
        slack: {
          handleWebhook: async (request: Request) => {
            forwarded.push(await request.json());
            return new Response("ok");
          },
        } as never,
        onRemoval: async () => {},
        gate: async () => {
          const verdict = verdicts.shift();
          order.push(`gate ${verdict}`);
          if (verdict === "fail") throw new Error("database down");
          return verdict ?? "forward";
        },
        log: (msg) => void log.push(msg),
      },
      () => {},
    );
    const dm = { type: "event_callback", team_id: "T1", event: { type: "message", channel_type: "im" } };
    for (let i = 0; i < 3; i++) await handle({ ack: async () => void order.push("ack"), type: "events_api", body: dm });
    // Recorded, then acknowledged; the retry acknowledged and dropped; the one not recorded left for Slack to resend.
    expect(order).toEqual(["gate forward", "ack", "gate skip", "ack", "gate fail"]);
    expect(forwarded).toHaveLength(1);
    expect(log).toEqual(["slack question not recorded"]);
  });

  it("publishes App Home's tab for the team the event names, and still hands the event on", async () => {
    const homes: unknown[] = [];
    let forwarded = 0;
    const tracked: Promise<unknown>[] = [];
    const handle = socketHandler(
      {
        forwardingSecret: "s",
        slack: {
          handleWebhook: async () => {
            forwarded += 1;
            return new Response("ok");
          },
        } as never,
        onRemoval: async () => {},
        gate: async () => "forward",
        onHome: async (home) => void homes.push(home),
        log: () => {},
      },
      (task) => void tracked.push(task),
    );
    const opened = (tab: string) => ({
      type: "event_callback",
      team_id: "T1",
      event: { type: "app_home_opened", tab, user: "UPRIYA" },
    });
    await handle({ ack: async () => {}, type: "events_api", body: opened("home") });
    await handle({ ack: async () => {}, type: "events_api", body: opened("messages") });
    await Promise.all(tracked);
    expect(homes).toEqual([{ teamId: "T1", userId: "UPRIYA" }]);
    expect(forwarded).toBe(2);
  });
});

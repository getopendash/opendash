/**
 * Slack over Socket Mode, OpenDash's own connection: one per deployment, for every workspace that added the
 * app (Slack sends each event with its team, and the bot's token for that team is looked up then). OpenDash reads each
 * event first: Slack taking the app back is heard, and a question is recorded before it's acknowledged (§4). Then it
 * hands the event to Chat SDK through its forwarded-event entry, the same path its own socket listener uses. The work
 * an event starts is kept, so stopping waits for it.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import { BUDGETS, type SlackEnvelope } from "@opendash/core";
import { SocketModeClient } from "@slack/socket-mode";
import { type SlackRemoval, slackRemovalOf } from "./events";
import { homeOpenedOf } from "./home";
import { forwardToBot } from "./inbound";

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export interface SlackSocketOptions {
  appToken: string;
  /** The adapter's `socketForwardingSecret`: what lets a forwarded event in. */
  forwardingSecret: string;
  slack: Pick<SlackAdapter, "handleWebhook">;
  onRemoval: (removal: SlackRemoval) => Promise<void>;
  /** Records a question and says whether to hand the event on (`gateSlackEvent`). */
  gate: (envelope: SlackEnvelope) => Promise<"forward" | "skip">;
  /** Someone opened App Home's tab: published for them (`publishSlackHome`), the team read from the event. */
  onHome?: (home: { teamId: string; userId: string }) => Promise<unknown>;
  log: Log;
  /** A stand-in for Slack's API (tests). */
  slackApiUrl?: string;
  /** How long the worker waits for the first connection before going on (it keeps trying). */
  connectWaitMs?: number;
}

/** What Socket Mode hands each listener. */
export interface SocketEvent {
  ack: () => Promise<void>;
  type: string;
  body: unknown;
  retry_num?: number;
}

/**
 * One event. A removal is recorded here, then acknowledged; a question recorded (the gate), then acknowledged, and
 * handed on only by the delivery that made its record. Either one that couldn't be recorded isn't acknowledged, so
 * Slack sends it again. Anything else is acknowledged, then forwarded to the adapter.
 */
export function socketHandler(
  options: Omit<SlackSocketOptions, "appToken" | "slackApiUrl" | "connectWaitMs">,
  track: Track,
) {
  return async ({ ack, type, body, retry_num }: SocketEvent) => {
    const removal = type === "events_api" ? slackRemovalOf(body) : null;
    if (removal) {
      try {
        await options.onRemoval(removal);
      } catch (error) {
        options.log("slack removal not recorded", { teamId: removal.teamId, error: String(error) });
        return;
      }
      await ack();
      return;
    }
    let verdict: "forward" | "skip";
    try {
      verdict = await options.gate({ eventType: type, body });
    } catch (error) {
      options.log("slack question not recorded", { type, error: String(error) });
      return;
    }
    await ack();
    const home = homeOpenedOf({ eventType: type, body });
    if (home && options.onHome) track(options.onHome(home));
    if (verdict === "skip") return;
    const response = await forwardToBot(
      options.slack,
      options.forwardingSecret,
      { eventType: type, body, ...(retry_num === undefined ? {} : { retryNum: retry_num }) },
      track,
    );
    if (!response.ok) options.log("slack event not handled", { type, status: response.status });
  };
}

type Track = (task: Promise<unknown>) => void;

export async function startSlackSocket(options: SlackSocketOptions): Promise<{ stop: () => Promise<void> }> {
  const pending = new Set<Promise<unknown>>();
  const track: Track = (task) => {
    const kept = task.catch((error: unknown) => options.log("slack event failed", { error: String(error) }));
    pending.add(kept);
    void kept.finally(() => pending.delete(kept));
  };
  const client = new SocketModeClient({
    appToken: options.appToken,
    ...(options.slackApiUrl ? { clientOptions: { slackApiUrl: options.slackApiUrl } } : {}),
  });
  const handle = socketHandler(options, track);
  client.on("slack_event", (event: SocketEvent) => track(handle(event)));
  // Connecting retries on its own for as long as Slack can't be reached; the worker waits a bounded time, then goes on
  // (the client keeps trying, its failure logged, and stop() disconnects it), so nothing registered after Slack waits
  // on Slack. Stopping doesn't wait on it: a disconnected attempt may never settle. The race only stops the waiting,
  // never the connecting, which is meant to go on.
  const started = client.start().then(
    () => true,
    (error: unknown) => {
      options.log("slack socket didn't connect", { error: String(error) });
      return false;
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const connected = await Promise.race([
    started,
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), options.connectWaitMs ?? BUDGETS.slack.socketConnectWaitMs);
    }),
  ]);
  clearTimeout(timer);
  if (connected === null) options.log("slack socket still connecting");
  return {
    stop: async () => {
      await client.disconnect().catch(() => {});
      await Promise.allSettled([...pending]);
    },
  };
}

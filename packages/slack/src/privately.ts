/**
 * Saying something to one person only (Slack's ephemeral message), where Slack shows it. Slack shows a private
 * message posted in a thread only once that thread is active: posted under a channel message nobody has replied to,
 * it's hidden, though Slack says it was sent. A message said in the channel names its thread after itself, so a
 * private word about it goes in the channel, right under it; one about a message in a thread stays in the thread. In
 * a direct message it's said in the thread, as anything else is.
 */
import type { AdapterPostableMessage, ChatElement, Thread } from "chat";

/** Says `message` to `userId` only. `threadShown`: the thread already has replies (`threadShownFor`). */
export async function tellPrivately(
  thread: Thread<unknown>,
  userId: string,
  message: AdapterPostableMessage | ChatElement,
  threadShown: boolean,
): Promise<void> {
  if (thread.isDM) await thread.post(message);
  else if (threadShown) await thread.postEphemeral(userId, message, { fallbackToDM: true });
  else await thread.channel.postEphemeral(userId, message, { fallbackToDM: true });
}

const isTs = (v: unknown): v is string => typeof v === "string" && v !== "";

/**
 * Whether what a handler was given (a message's Slack event, or a press's payload) sits in a thread Slack shows. A
 * press is on a reply in a thread, or on a message with replies (Slack then gives the message its own ts as its
 * thread's); a press on a message nobody replied to has neither. A message is a reply in a thread, or it was said in
 * the channel and starts none. Anything else (a box submitted from an answer) belongs to the answer's thread, which
 * the answer started.
 */
export function threadShownFor(raw: unknown): boolean {
  const r = (raw ?? {}) as {
    type?: unknown;
    ts?: unknown;
    thread_ts?: unknown;
    message?: { thread_ts?: unknown };
    container?: { thread_ts?: unknown };
  };
  if (r.type === "block_actions") return isTs(r.message?.thread_ts) || isTs(r.container?.thread_ts);
  if (isTs(r.ts)) return isTs(r.thread_ts) && r.thread_ts !== r.ts;
  return true;
}

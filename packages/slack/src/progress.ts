/**
 * A run's steps as Slack task cards (after the first live test): Slack's status-line text only shows in
 * OpenDash's own threads, so in a channel thread a reply showed only "Stop opendash". Slack's way for agents is a
 * streamed message in plan mode: each step a task card (in progress, then complete), in channels and DMs alike. The
 * answer goes in at the end, all at once, once every number is checked: in the call that stops the stream, with the
 * metadata that lets a resumed reply find it, so the answer and its mark go in together or not at all.
 * Slack expires a stream after about five minutes, so a longer run continues in a new message that replays its open
 * steps.
 */
import { type Event, stepStatus } from "./reply";

/** One step's card in a streamed message (Slack's `task_update` chunk). */
export interface TaskUpdateChunk {
  type: "task_update";
  id: string;
  title: string;
  status: "pending" | "in_progress" | "complete" | "error";
  output?: string;
}

/** What a streamed message carries: step cards, and at the end the answer's text. */
type AnyChunk = TaskUpdateChunk | { type: "markdown_text"; text: string } | { type: "plan_update"; title: string };

/** What the cards need from Slack's web client (the adapter's, with the workspace's token). */
export interface StreamClient {
  chat: {
    startStream(args: Record<string, unknown>): Promise<{ ts?: string }>;
    appendStream(args: Record<string, unknown>): Promise<unknown>;
    stopStream(args: Record<string, unknown>): Promise<unknown>;
  };
}

export interface CardsWhere {
  channel: string;
  threadTs: string;
  /** Outside a DM, Slack streams to one person: the asker. */
  recipientUserId: string;
  recipientTeamId: string;
}

/** Slack's error for an append to a stream it has already closed (its five minutes passed). */
const EXPIRED = "message_not_in_streaming_state";
const errorCode = (error: unknown) =>
  (error as { data?: { error?: unknown } } | null)?.data?.error ?? (error as { code?: unknown } | null)?.code;

/** Slack's error code for a refused call, also when the adapter wrapped it (its cause); null when it isn't Slack's. */
const slackCodeOf = (error: unknown): string | null => {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = (error as { data?: { error?: unknown } } | null)?.data?.error ?? errorCode(cause) ?? errorCode(error);
  return typeof code === "string" && code ? code : null;
};

/** Slack's reason for refusing a call, for the log: its error code, or the error's message. */
export const slackError = (error: unknown): string =>
  slackCodeOf(error) ?? String(error instanceof Error ? error.message : error);

/** Why a call failed, to keep: Slack's code, or the error's name, never what an error says. */
export const failureCode = (error: unknown): string =>
  slackCodeOf(error) ?? (error instanceof Error ? error.name : "error");

/** A step's title for its card: the status line's words, without its trailing ellipsis, within Slack's 256. */
export const cardTitle = (status: string) => status.replace(/…$/, "").slice(0, 256);

/** The first card, before any step: Slack's plan opens with it. */
export const READING = { id: "question", title: "Reading your question" } as const;

/**
 * The card changes these events make: each tool call a card keyed by its call, in progress when it starts and
 * complete when its result comes, a query's rows as its output; a follow-up read meanwhile its own card. A step that
 * failed is complete too, saying it didn't work: the analyst retries, and Slack puts "Something went wrong" over a
 * message as soon as any card is an `error`, which an answer that then succeeds never clears. A run that really fails
 * says so in its reply instead. `titles` keeps each call's title for its result.
 */
export function cardsAfter(events: Event[], titles: Map<string, string>): TaskUpdateChunk[] {
  const cards: TaskUpdateChunk[] = [];
  for (const e of events) {
    const callId = typeof e.data.callId === "string" ? e.data.callId : null;
    if (e.type === "tool_started" && callId) {
      const title = cardTitle(stepStatus(String(e.data.tool), (e.data.input ?? {}) as Record<string, unknown>));
      titles.set(callId, title);
      cards.push({ type: "task_update", id: callId, title, status: "in_progress" });
    } else if (e.type === "tool_result" && callId) {
      const title = titles.get(callId) ?? cardTitle(stepStatus(String(e.data.tool)));
      const failed = e.data.status !== "succeeded" || Boolean(e.data.failed);
      const rows = typeof e.data.rows === "number" ? e.data.rows : null;
      cards.push({
        type: "task_update",
        id: callId,
        title,
        status: "complete",
        ...(failed
          ? { output: "Didn't work, trying another way" }
          : rows !== null
            ? { output: `${rows} ${rows === 1 ? "row" : "rows"}` }
            : {}),
      });
    } else if (e.type === "input_joined") {
      cards.push({ type: "task_update", id: `input-${e.seq}`, title: "Reading your follow-up", status: "complete" });
    }
  }
  return cards;
}

/** Where the cards go on from, and what's told of each message they start. */
export interface CardsOptions {
  maxAgeMs?: number;
  now?: () => number;
  /** The message an earlier attempt started: carried on in, while Slack keeps it open. */
  resume?: { ts: string; startedAt: number } | null;
  /** A message started (the first, or the next): recorded, so a later attempt carries on in it. */
  onStart?: (ts: string) => Promise<unknown>;
}

/**
 * The cards of one reply. `open` starts the stream, or takes up the one an earlier attempt started (false when Slack
 * refuses it: the caller falls back to the status line); `update` sends card changes, in order; `finish` puts the
 * answer in and stops the stream. Every Slack call is the client's own (bounded by its timeout); a card is never
 * worth failing a reply for, but the answer is.
 */
export function taskCards(client: StreamClient, where: CardsWhere, options: CardsOptions = {}) {
  const maxAge = options.maxAgeMs ?? 240_000;
  const now = options.now ?? Date.now;
  const dm = where.channel.startsWith("D");
  let ts: string | null = null;
  let startedAt = 0;
  // Taken up from an earlier attempt and not yet sent to: whatever Slack says to the first send, a new message.
  let unproven = false;
  const open = new Map<string, TaskUpdateChunk>();
  let chain: Promise<void> = Promise.resolve();

  const remember = (cards: TaskUpdateChunk[]) => {
    for (const c of cards) {
      if (c.status === "complete" || c.status === "error") open.delete(c.id);
      else open.set(c.id, c);
    }
  };
  /** Starts a new message with these chunks: its ts. */
  const start = async (chunks: AnyChunk[]): Promise<string> => {
    const started = await client.chat.startStream({
      channel: where.channel,
      thread_ts: where.threadTs,
      task_display_mode: "plan",
      ...(dm ? {} : { recipient_user_id: where.recipientUserId, recipient_team_id: where.recipientTeamId }),
      chunks,
    });
    if (!started.ts) throw new Error("Slack didn't start the stream.");
    ts = started.ts;
    startedAt = now();
    await options.onStart?.(started.ts).catch(() => {});
    return started.ts;
  };
  /**
   * What a new message starts with, carrying on: the steps still open, then this batch's (its cards' latest state
   * replacing theirs, its text after). Never nothing, which Slack refuses: a plan title then.
   */
  const replay = (chunks: AnyChunk[]): AnyChunk[] => {
    const tasks = new Map<string, TaskUpdateChunk>(open);
    const rest: AnyChunk[] = [];
    for (const c of chunks) {
      if (c.type === "task_update") tasks.set(c.id, c);
      else rest.push(c);
    }
    const all = [...tasks.values(), ...rest];
    return all.length ? all : [{ type: "plan_update", title: "Working on it" }];
  };
  /** Stops the current message, the session kept busy: the reply goes on in the next. */
  const stopCurrent = async () => {
    const was = ts;
    ts = null;
    if (was) {
      await client.chat.stopStream({ channel: where.channel, ts: was, session_status: "processing" }).catch(() => {});
    }
  };
  /** Sends a batch: in this message while it's young enough, else (or once Slack has closed it) in a new one. */
  const send = async (chunks: AnyChunk[]) => {
    if (ts && now() - startedAt >= maxAge) await stopCurrent();
    if (ts) {
      try {
        await client.chat.appendStream({ channel: where.channel, ts, chunks });
        unproven = false;
        return;
      } catch (error) {
        if (!unproven && errorCode(error) !== EXPIRED) throw error;
        ts = null;
        unproven = false;
      }
    }
    await start(replay(chunks));
  };

  return {
    /** Starts the message. Slack refusing it (an app without the agent feature, say) gives its error, for the log. */
    async open(): Promise<{ ok: true } | { ok: false; error: string }> {
      const first: TaskUpdateChunk = { type: "task_update", ...READING, status: "in_progress" };
      // Carried on: nothing sent yet (the run's steps come again, each card in place); done by the end all the same.
      if (options.resume) {
        ts = options.resume.ts;
        startedAt = options.resume.startedAt;
        unproven = true;
        remember([first]);
        return { ok: true };
      }
      try {
        await start([first]);
        remember([first]);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(errorCode(error) ?? (error instanceof Error ? error.message : error)) };
      }
    },
    update(cards: TaskUpdateChunk[]) {
      if (!cards.length) return;
      chain = chain
        .then(async () => {
          await send(cards);
          remember(cards);
        })
        .catch(() => {});
    },
    /**
     * The answer, all at once, as the stream stops (with `extra`: its metadata, and blocks under it, or the whole
     * answer as blocks when `markdown` is null): the open cards
     * done first, so none spins on. Returns the message's ts. Throws when Slack didn't take it (the caller looks for
     * it, then posts it the plain way).
     */
    async finish(markdown: string | null, extra: Record<string, unknown> = {}): Promise<string> {
      await chain;
      const done = open.size ? [...open.values()].map((c): TaskUpdateChunk => ({ ...c, status: "complete" })) : [];
      open.clear();
      // In this message, or a new one when it's too old, Slack closed it, or an earlier step couldn't start one.
      if (done.length || !ts || now() - startedAt >= maxAge) await send(done);
      const stop = (at: string) =>
        client.chat.stopStream({
          channel: where.channel,
          ts: at,
          ...(markdown === null ? {} : { markdown_text: markdown }),
          ...extra,
        });
      let at = ts ?? (await start(replay([])));
      try {
        await stop(at);
      } catch (error) {
        // Closed by Slack meanwhile: the answer goes in a new message of its own.
        if (errorCode(error) !== EXPIRED) throw error;
        at = await start(replay([]));
        await stop(at);
      }
      ts = null;
      return at;
    },
    /**
     * The cards stopped as they are: the run ended without an answer to put in. Handed off (`handOff`), the message
     * is left open for the next attempt to carry on in; Slack closes it itself if none comes in time.
     */
    async close(close: { handOff?: boolean } = {}): Promise<void> {
      await chain;
      if (ts && !close.handOff) await client.chat.stopStream({ channel: where.channel, ts }).catch(() => {});
      ts = null;
    },
  };
}

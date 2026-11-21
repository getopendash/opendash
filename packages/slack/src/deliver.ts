/**
 * slack.reply: one run's reply in Slack, from the worker. While the run works, its steps are
 * task cards in one streamed message (or the status line, where Slack refuses the stream), the 👀 on the question
 * saying it was picked up. Then the answer, put in that message once every number is checked; a question's options;
 * the session cleared; ✅ for the 👀; and, for an answer with numbers, the answer as a PDF (@opendash/pdf, as the
 * web app's) and each cited query's rows as CSV, in one message.
 *
 * Posted once, whatever stops it. Each attempt is fenced (it writes only while it's the latest), and each part is
 * claimed before it's posted and recorded after, carrying its run and part in Slack's message metadata: a resumed
 * attempt posts only what isn't there, and looks in the thread for a part it may have posted just before it stopped.
 * The answer and its questions are posted exactly once; the files at most once. A shutdown hands the reply to the
 * next attempt before anything is posted, rather than saying something went wrong. Slack refusing it for good
 * (its token revoked, the channel gone) ends it; any other failure is retried, and the third gives up, saying where
 * the answer is.
 */
import type { SlackAdapter } from "@chat-adapter/slack";
import {
  answerAbout,
  beginSlackReplyAttempt,
  checkSlackReplyAttempt,
  claimSlackReplyPart,
  finishSlackReplyAttempt,
  getQueryCard,
  getRun,
  type LedgerDeps,
  memoriesOfRun,
  onePress,
  type QueryCard,
  type ResolvedChart,
  runEvents,
  type SecretStore,
  SLACK_FOR_GOOD,
  SLACK_REPLY_FAILURES,
  SlackReplyFenced,
  type SlackReplyJob,
  slackBotToken,
  slackReplyFailed,
  slackReplyOf,
  slackReplyPartBegun,
  slackReplyPartPosted,
  slackReplySteps,
  slackReplyStepsAt,
} from "@opendash/core";
import type { PublicTx, TenantTx } from "@opendash/db";
import { answerBlocks, chartPng, packageFontDir, pdfFileName, renderPdf } from "@opendash/pdf";
import type { Chat } from "chat";
import { askBlocks, buttonText, spelledOut } from "./ask";
import { optionAction } from "./bot";
import { type AnswerCard, answerCard } from "./card";
import { cardsAfter, failureCode, READING, type StreamClient, slackError, taskCards } from "./progress";
import {
  cardCsv,
  chartAltText,
  type Event,
  fileStem,
  pdfAnswer,
  quiet,
  replyBlocks,
  replyText,
  statusAfter,
} from "./reply";

export interface DeliverDeps {
  withTenant: LedgerDeps["withTenant"];
  /** A transaction carrying the asker, to read what the answer remembered for them (their memory is theirs alone). */
  withUser?: <T>(orgId: string, userId: string, fn: (tx: TenantTx) => Promise<T>) => Promise<T>;
  withPublic: <T>(fn: (tx: PublicTx) => Promise<T>) => Promise<T>;
  secrets: SecretStore;
  webUrl: string;
  /** How often to read the run's new events while it works. */
  pollMs?: number;
  /** At most this many cited queries' rows as files. */
  maxFiles?: number;
  /** The status line's pacing (tests make it quick). */
  status?: { minGapMs?: number; refreshMs?: number };
  /** The task cards' stream age before a new message, and a clock (tests). */
  cards?: { maxAgeMs?: number; now?: () => number };
  /** Where a reply says something worth knowing that isn't an error (the worker's log). */
  log?: (msg: string, fields?: Record<string, unknown>) => void;
  /**
   * Each step's name, awaited as the reply reaches it (tests: an attempt that never comes back from one stopped
   * there, as a process killed there would).
   */
  checkpoint?: (step: string) => Promise<void> | void;
}

/** The reply goes on in another attempt: a shutdown came before anything was posted. pg-boss tries it again. */
export class SlackReplyHandOff extends Error {
  override name = "SlackReplyHandOff";
}

/**
 * Its asker left the workspace while the run worked (their Slack link went with the membership): nothing more is
 * posted to them, and the reply ends there.
 */
export class SlackReplyUnlinked extends Error {
  override name = "SlackReplyUnlinked";
}

/** Slack's refusals that no retry changes (the token gone, or the place to reply): the reply ends there. */
const FOR_GOOD = SLACK_FOR_GOOD;

/** Slack refusing a message's blocks: tried again with the plain ones. */
const REFUSED_BLOCKS = new Set(["invalid_blocks", "invalid_blocks_format", "invalid_arguments"]);

/** What a reply's parts are marked with in Slack (its message metadata): the run and the part, nothing said. */
export const REPLY_EVENT = "opendash_reply";

/**
 * The marks a reply leaves about its answer's card, each made before the send it's about: `card`, the answer was sent
 * as a card (so its charts aren't sent again as images); `card_refused`, Slack refused it, and the answer goes, and
 * goes again in any later attempt, without one (every chart an image). An answer with neither went as today's message.
 */
export const CARD_SENT = "card";
export const CARD_REFUSED = "card_refused";

/** The reply's own records failing while it sends the answer: never taken for Slack refusing it, so the job retries. */
class ReplyLedgerError extends Error {
  override name = "ReplyLedgerError";
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });

/** What the status line needs from the Slack adapter. */
export interface StatusAdapter {
  startTyping(threadId: string, status?: string, options?: { initiatorUserId?: string }): Promise<void>;
  endTyping(threadId: string): Promise<void>;
}

/**
 * A thread's status line. `begin` opens the agent session (Slack shows its stop button while it's processing) with a
 * first line; `set` shows a step, at most one change every `minGapMs` (the latest wins), and says it again every
 * `refreshMs` so Slack doesn't drop a long step's line; `clear` ends the session's processing. Slack's refusals are
 * the adapter's to log: a status line is never worth failing a reply for.
 */
export function statusLine(
  slack: StatusAdapter,
  threadId: string,
  options: {
    initiatorUserId?: string;
    minGapMs?: number;
    refreshMs?: number;
    now?: () => number;
    /** The session is open already: `begin` only says its first line. */
    opened?: boolean;
  } = {},
) {
  const minGap = options.minGapMs ?? 2_000;
  const refresh = options.refreshMs ?? 60_000;
  const now = options.now ?? Date.now;
  const who = options.initiatorUserId ? { initiatorUserId: options.initiatorUserId } : undefined;
  let shown: string | null = null;
  let shownAt = Number.NEGATIVE_INFINITY;
  let wanted: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const write = (text: string) => {
    shown = text;
    shownAt = now();
    chain = chain.then(() => slack.startTyping(threadId, text, who)).catch(() => {});
    return chain;
  };
  return {
    async begin(text: string) {
      if (!options.opened) await slack.startTyping(threadId, undefined, who).catch(() => {});
      await write(text);
    },
    set(text: string) {
      if (closed) return;
      wanted = text;
      if (text === shown && now() - shownAt < refresh) return;
      const wait = minGap - (now() - shownAt);
      if (wait <= 0) {
        void write(text);
      } else if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          if (!closed && wanted !== null && wanted !== shown) void write(wanted);
        }, wait);
      }
    },
    /** Stops changing it; `keep` leaves the session as it is (a hand-off), otherwise it's ended. */
    async clear(keep = false) {
      closed = true;
      if (timer) clearTimeout(timer);
      await chain;
      if (!keep) await slack.endTyping(threadId).catch(() => {});
    },
  };
}

/**
 * Follows a run until it ends, telling `onProgress` what happened each time it looks (its new events, the current
 * step); then the run. A shutdown (`signal`) before the run ends hands the reply off.
 */
export async function followRun(
  deps: Pick<DeliverDeps, "withTenant" | "pollMs">,
  viewer: { orgId: string; userId: string },
  runId: string,
  onProgress: (step: { events: Event[]; line: string | null; ended: boolean }) => void,
  signal?: AbortSignal,
) {
  const ledger = { withTenant: deps.withTenant };
  let seq = 0;
  let line: string | null = null;
  for (;;) {
    const events = await runEvents(ledger, viewer, runId, seq);
    for (const e of events) seq = Math.max(seq, e.seq);
    line = statusAfter(events) ?? line;
    const ended = events.some((e) => e.type === "run_end");
    onProgress({ events, line, ended });
    if (ended) break;
    if (signal?.aborted) throw new SlackReplyHandOff();
    await sleep(deps.pollMs ?? 500, signal);
  }
  return getRun(ledger, viewer, runId);
}

/** What the reply needs from Slack's web client (the adapter's, with the workspace's token). */
interface ReplyClient extends StreamClient {
  chat: StreamClient["chat"] & { postMessage(args: Record<string, unknown>): Promise<{ ts?: string }> };
  files: { uploadV2(args: Record<string, unknown>): Promise<unknown> };
  conversations: {
    replies(args: Record<string, unknown>): Promise<{
      messages?: {
        ts?: string;
        user?: string;
        metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
      }[];
      response_metadata?: { next_cursor?: string };
    }>;
  };
}

/**
 * A channel reply's first message, starting with its asker's mention: on the same line as plain text, on its own
 * before anything Markdown sets apart (a heading, a list, a table, a quote, code).
 */
export function addressed(slackUserId: string, markdown: string): string {
  const mention = `<@${slackUserId}>`;
  return /^(#|[-*+] |\d+[.)] |\||>|```)/.test(markdown) ? `${mention}\n\n${markdown}` : `${mention} ${markdown}`;
}

/** The part of the reply that says where the answer is, when the reply gives up. */
const gaveUpText = (url: string) => `I couldn't finish replying here. The answer is in OpenDash: ${url}`;

/** Delivers a run's reply. "skipped": nothing to send (not from Slack, finished already, or another attempt has it). */
export async function deliverSlackReply(
  deps: DeliverDeps,
  bot: Chat,
  slack: SlackAdapter,
  job: SlackReplyJob,
  signal?: AbortSignal,
): Promise<"done" | "skipped" | "failed"> {
  const target = await deps.withTenant(job.orgId, (tx) => slackReplyOf(tx, job.orgId, job.runId));
  if (target?.status !== "streaming" || !target.userId) return "skipped";
  const attempt = await deps.withTenant(job.orgId, (tx) => beginSlackReplyAttempt(tx, job.orgId, job.runId));
  if (attempt === null) return "skipped";
  await deps.checkpoint?.("began");
  const finish = (status: "done" | "failed") =>
    deps.withTenant(job.orgId, (tx) => finishSlackReplyAttempt(tx, job.orgId, job.runId, attempt, status));
  // Left the workspace while it ran (their Slack link went with the membership): nothing more is posted to them.
  if (!target.linked) {
    await finish("failed").catch(() => {});
    return "skipped";
  }
  // The workspace's own token: none once Slack took the app back, and then nothing is posted.
  const workspace = await slackBotToken(deps, target.teamId);
  const token = workspace?.token;
  if (!workspace || !token) {
    await finish("failed").catch(() => {});
    return "skipped";
  }
  const reply = new Reply(deps, bot, slack, job, { ...target, userId: target.userId }, attempt, workspace.botUserId);
  // Scoped to the workspace, so the adapter's cached profiles of one workspace never answer for another's.
  const scoped = (fn: () => Promise<void>) => slack.withBotToken(token, fn, { installationId: target.teamId });
  try {
    await scoped(() => reply.deliver(signal));
    return "done";
  } catch (error) {
    if (error instanceof SlackReplyHandOff) throw error;
    if (error instanceof SlackReplyFenced) return "skipped";
    if (error instanceof SlackReplyUnlinked) {
      await finish("failed").catch(() => {});
      return "skipped";
    }
    const why = failureCode(error);
    if (FOR_GOOD.has(why)) {
      deps.log?.("slack reply: Slack refused it for good", { runId: job.runId, why });
      await finish("failed").catch(() => {});
      return "failed";
    }
    const failures = await deps
      .withTenant(job.orgId, (tx) => slackReplyFailed(tx, job.orgId, job.runId, attempt, why))
      .catch((e: unknown) => (e instanceof SlackReplyFenced ? null : Promise.reject(e)));
    if (failures === null) return "skipped";
    if (failures < SLACK_REPLY_FAILURES) throw error;
    deps.log?.("slack reply: gave up", { runId: job.runId, why, failures });
    await scoped(() => reply.giveUp()).catch(() => {});
    return "failed";
  }
}

/**
 * The last word on a reply the queue gave up on (its dead letter): the person told where the answer is, if the reply
 * is still unfinished.
 */
export async function abandonSlackReply(
  deps: DeliverDeps,
  bot: Chat,
  slack: SlackAdapter,
  job: SlackReplyJob,
): Promise<boolean> {
  const target = await deps.withTenant(job.orgId, (tx) => slackReplyOf(tx, job.orgId, job.runId));
  if (target?.status !== "streaming" || !target.userId) return false;
  const attempt = await deps.withTenant(job.orgId, (tx) => beginSlackReplyAttempt(tx, job.orgId, job.runId));
  if (attempt === null) return false;
  if (!target.linked) {
    await deps.withTenant(job.orgId, (tx) => finishSlackReplyAttempt(tx, job.orgId, job.runId, attempt, "failed"));
    return true;
  }
  const workspace = await slackBotToken(deps, target.teamId);
  const token = workspace?.token;
  const reply = new Reply(
    deps,
    bot,
    slack,
    job,
    { ...target, userId: target.userId },
    attempt,
    workspace?.botUserId ?? "",
  );
  if (!token) {
    await deps.withTenant(job.orgId, (tx) => finishSlackReplyAttempt(tx, job.orgId, job.runId, attempt, "failed"));
    return true;
  }
  await slack.withBotToken(token, () => reply.giveUp(), { installationId: target.teamId });
  return true;
}

/** One attempt at a run's reply. */
class Reply {
  private readonly threadId: string;
  private readonly channel: string;
  private readonly threadTs: string;
  private readonly who: { initiatorUserId: string };
  /** What the answer remembered for its asker, shown under it with Undo. */
  private remembered: { id: string; fact: string; why: string }[] = [];
  /** Slack refused the answer's card in this attempt: it goes on without one. */
  private cardRefused = false;

  constructor(
    private readonly deps: DeliverDeps,
    private readonly bot: Chat,
    private readonly slack: SlackAdapter,
    private readonly job: SlackReplyJob,
    private readonly target: {
      teamId: string;
      slackThreadId: string;
      slackUserId: string;
      slackMessageTs: string | null;
      userId: string;
      shared: boolean;
    },
    private readonly attempt: number,
    /** The workspace's OpenDash bot: the only poster whose marks count. */
    private readonly botUserId: string,
  ) {
    this.threadId = target.slackThreadId;
    const { channel, threadTs } = slack.decodeThreadId(this.threadId);
    this.channel = channel;
    this.threadTs = threadTs;
    this.who = { initiatorUserId: target.slackUserId };
  }

  /** Slack's web client with the workspace's token: read where it's used, inside `withBotToken`. */
  private get client(): ReplyClient {
    return this.slack.webClient as unknown as ReplyClient;
  }

  private get url(): string {
    return this.deps.webUrl.replace(/\/$/, "");
  }

  /** Where a part sits in Slack: its run and part, as its message's metadata. */
  private marked(part: string) {
    return { event_type: REPLY_EVENT, event_payload: { run: this.job.runId, part } };
  }

  /**
   * A part posted by an earlier attempt that never said so: found in the thread by its metadata, or null. Only a
   * message OpenDash's own bot posted counts: any app in the workspace can put metadata on a message, so a mark from
   * anyone else could otherwise keep the answer from being posted.
   */
  private async find(part: string): Promise<string | null> {
    if (!this.threadTs) return null;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const found = await this.client.conversations.replies({
        channel: this.channel,
        ts: this.threadTs,
        include_all_metadata: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      const hit = (found.messages ?? []).find(
        (m) =>
          this.botUserId !== "" &&
          m.user === this.botUserId &&
          m.metadata?.event_type === REPLY_EVENT &&
          m.metadata.event_payload?.run === this.job.runId &&
          m.metadata.event_payload?.part === part,
      );
      if (hit?.ts) return hit.ts;
      cursor = found.response_metadata?.next_cursor || undefined;
      if (!cursor) return null;
    }
    return null;
  }

  /**
   * Posts a part once. Posted already: nothing. Claimed by an earlier attempt that stopped: looked for in the thread
   * first (`exactly`), or (an extra, a file) taken as posted, since it may have gone and twice is worse than not.
   */
  private async once(part: string, post: () => Promise<string | null>, exactly = true): Promise<string | null> {
    const { orgId, runId } = this.job;
    const claimed = await this.deps.withTenant(orgId, (tx) =>
      claimSlackReplyPart(tx, orgId, runId, this.attempt, part),
    );
    if (claimed.state === "posted") return claimed.ts;
    let ts: string | null = null;
    if (claimed.state === "unsure") {
      if (!exactly) return null;
      ts = await this.find(part);
    }
    await this.deps.checkpoint?.(`claimed ${part}`);
    if (ts === null) ts = await post();
    await this.deps.checkpoint?.(`posted ${part}`);
    await this.deps.withTenant(orgId, (tx) => slackReplyPartPosted(tx, orgId, runId, this.attempt, part, ts));
    await this.deps.checkpoint?.(`recorded ${part}`);
    return ts;
  }

  /**
   * Sends a message with what goes under the answer when it's the last (`replyBlocks`). With a card (`answerCard`),
   * the card first. Slack refusing the blocks: Slack's own 👍/👎 give way to plain buttons (Slack refuses its own in
   * some places), and then the card to today's message, again with Slack's buttons and then plain ones. So the answer
   * never waits on a button or a card, and a refused card isn't blamed on the buttons.
   */
  private async underneath<T>(
    said: ReturnType<typeof replyText>,
    last: boolean,
    send: (blocks: Record<string, unknown>[] | undefined, card: AnswerCard | null) => Promise<T>,
    card: AnswerCard | null = null,
  ): Promise<T> {
    if (!last) return send(undefined, null);
    const dm = this.channel.startsWith("D");
    const tries: { card: AnswerCard | null; feedback: "native" | "plain" }[] = [
      ...(card && !this.cardRefused
        ? [
            { card, feedback: "native" as const },
            { card, feedback: "plain" as const },
          ]
        : []),
      { card: null, feedback: "native" },
      { card: null, feedback: "plain" },
    ];
    const { orgId, runId } = this.job;
    for (let i = 0; ; i++) {
      const t = tries[i] as (typeof tries)[number];
      // Marked before it's sent as a card; and before every send, this attempt still the latest (a newer one may have
      // posted the answer meanwhile, while this one looked for it in the thread, say).
      if (t.card) await this.ledger(() => this.once(CARD_SENT, async () => null, false));
      await this.deps.checkpoint?.("sending answer");
      await this.ledger(() =>
        this.deps.withTenant(orgId, (tx) => checkSlackReplyAttempt(tx, orgId, runId, this.attempt)),
      );
      try {
        return await send(replyBlocks(said, runId, t.feedback, this.remembered, dm), t.card);
      } catch (error) {
        const why = failureCode(error);
        const next = tries[i + 1];
        if (!REFUSED_BLOCKS.has(why) || !next) throw error;
        if (t.card && !next.card) {
          // Marked before the answer goes without it: no attempt sends it as a card again, and every chart is an image.
          await this.ledger(() => this.once(CARD_REFUSED, async () => null, false));
          this.cardRefused = true;
          this.deps.log?.("slack reply: without its card", { runId, why });
        } else {
          this.deps.log?.("slack reply: plain feedback buttons", { runId, why });
        }
      }
    }
  }

  /** A write to the reply's own records while the answer is sent: its failure is the job's to retry, never a refusal. */
  private async ledger<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof SlackReplyFenced) throw error;
      throw new ReplyLedgerError(error instanceof Error ? error.message : String(error), { cause: error });
    }
  }

  /** One of the answer's messages, posted the plain way: its words as a markdown block (or its card), the last with its buttons. */
  private posted(
    part: string,
    markdown: string,
    said: ReturnType<typeof replyText>,
    last: boolean,
    card: AnswerCard | null = null,
  ) {
    return this.underneath(
      said,
      last,
      (blocks, withCard) =>
        this.post(part, {
          // What a notification shows, where blocks can't be.
          text: markdown.slice(0, 300),
          blocks: [...(withCard ? withCard.blocks : [{ type: "markdown", text: markdown }]), ...(blocks ?? [])],
        }),
      card,
    );
  }

  /**
   * A message in the reply's thread, marked as its part. Never unfurled: a link the answer holds isn't fetched by
   * Slack on nobody's click (it could carry the answer's values). A streamed answer's end takes no such option.
   */
  private async post(part: string, message: Record<string, unknown>): Promise<string | null> {
    const posted = await this.client.chat.postMessage({
      channel: this.channel,
      ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
      ...message,
      unfurl_links: false,
      unfurl_media: false,
      metadata: this.marked(part),
    });
    return posted.ts ?? null;
  }

  async deliver(signal?: AbortSignal): Promise<void> {
    const { slack, deps, job } = this;
    // The agent session, open while it works: Slack's Stop button.
    await slack.startTyping(this.threadId, undefined, this.who).catch(() => {});
    // Its steps as task cards in one streamed message, in channels and DMs alike (Slack's status-line text only shows
    // in OpenDash's own threads). Where Slack refuses the stream, the status line, as before. One message across
    // attempts: a later one carries on in the message an earlier one started (part `steps`); with none started and
    // the answer begun, the run has ended and there are no steps left to show.
    const shown = await deps.withTenant(job.orgId, (tx) => slackReplySteps(tx, job.orgId, job.runId));
    const late = !shown.steps && shown.answering;
    const steps =
      this.threadTs && !late
        ? taskCards(
            this.client,
            {
              channel: this.channel,
              threadTs: this.threadTs,
              recipientUserId: this.target.slackUserId,
              recipientTeamId: this.target.teamId,
            },
            {
              ...deps.cards,
              resume: shown.steps ? { ts: shown.steps.ts, startedAt: shown.steps.startedAt.getTime() } : null,
              // Kept as it goes: a later attempt that can't find it opens a message of its own, nothing worse.
              onStart: (ts) =>
                deps.withTenant(job.orgId, (tx) => slackReplyStepsAt(tx, job.orgId, job.runId, this.attempt, ts)),
            },
          )
        : null;
    const opened = steps ? await steps.open() : ({ ok: false, error: "no thread" } as const);
    const streaming = opened.ok;
    // Said, so a reply that shows only "Stop opendash" again can be told apart from one whose cards Slack refused.
    if (!opened.ok && !late)
      deps.log?.("slack reply: steps on the status line", { runId: job.runId, why: opened.error });
    const status =
      streaming || late ? null : statusLine(slack, this.threadId, { ...this.who, ...deps.status, opened: true });
    if (status) await status.begin("Reading your question…");
    const titles = new Map<string, string>();
    let questionRead = false;
    const viewer = { orgId: job.orgId, userId: this.target.userId };
    let run: Awaited<ReturnType<typeof followRun>>;
    try {
      run = await followRun(
        deps,
        viewer,
        job.runId,
        ({ events, line, ended }) => {
          if (status) {
            if (line && !ended) status.set(line);
            return;
          }
          const changes = cardsAfter(events, titles);
          // The first step started: the question is read.
          if (changes.length && !questionRead) {
            questionRead = true;
            changes.unshift({ type: "task_update", ...READING, status: "complete" });
          }
          steps?.update(changes);
        },
        signal,
      );
      await deps.checkpoint?.("followed");
      // A shutdown before the answer went: the next attempt posts it, the session kept busy meanwhile.
      if (signal?.aborted) throw new SlackReplyHandOff();
      // Checked again now the run is done: one who left meanwhile gets no answer.
      const now = await deps.withTenant(job.orgId, (tx) => slackReplyOf(tx, job.orgId, job.runId));
      if (!now?.linked) throw new SlackReplyUnlinked();
    } catch (error) {
      const handOff = error instanceof SlackReplyHandOff;
      await steps?.close({ handOff });
      if (status) await status.clear(handOff);
      else if (!handOff) await slack.endTyping(this.threadId).catch(() => {});
      throw error;
    }
    const ask = run?.thread_id ? `${this.url}/ask/${encodeURIComponent(run.thread_id)}` : this.url;
    const said = replyText(run?.outcome ?? null, run?.status ?? "failed", ask);
    const asker = this.target.userId;
    this.remembered = deps.withUser
      ? await deps
          .withUser(job.orgId, asker, (tx) => memoriesOfRun(tx, { orgId: job.orgId, userId: asker }, job.runId))
          .catch(() => [])
      : [];
    // In a channel's thread holding someone else's conversation too, a reply starts by naming its asker.
    const [lead, ...rest] = said.messages;
    const first = lead === undefined || !this.target.shared ? lead : addressed(this.target.slackUserId, lead);
    const lastPart = rest.length ? `answer:${rest.length + 1}` : "answer";
    // An answer that's one message, as a card: its table and charts Slack's own (null: today's message). Not once
    // Slack refused it, in an earlier attempt too.
    const begun = (part: string) =>
      deps.withTenant(job.orgId, (tx) => slackReplyPartBegun(tx, job.orgId, job.runId, part));
    const made = rest.length
      ? null
      : answerCard(run?.outcome, this.target.shared ? (md) => addressed(this.target.slackUserId, md) : undefined);
    const card = made && !(await begun(CARD_REFUSED)) ? made : null;
    // The answer, all at once: in the message that showed its steps, or the plain way when that didn't take it. The
    // last of its messages carries what was checked and its buttons.
    await this.once("answer", async () => {
      if (streaming && steps && first !== undefined) {
        const at = await this.underneath(
          said,
          lastPart === "answer",
          (blocks, withCard) =>
            steps.finish(withCard ? null : first, {
              metadata: this.marked("answer"),
              ...(withCard || blocks ? { blocks: [...(withCard?.blocks ?? []), ...(blocks ?? [])] } : {}),
            }),
          card,
        ).catch((error: unknown) => {
          // Slack not taking it is looked into below; the reply's own records failing is the job's to retry.
          if (error instanceof SlackReplyFenced) throw error;
          if (error instanceof ReplyLedgerError) throw error.cause;
          return null;
        });
        if (at) return at;
        // Slack may have taken it before the answer came back: looked for before it's posted again.
        const found = await this.find("answer");
        if (found) return found;
      }
      return this.posted("answer", first ?? "", said, lastPart === "answer", card);
    });
    // An earlier attempt posted it: the cards are stopped as they are (after `finish`, nothing is left open; one Slack
    // stopped already says so, harmlessly).
    await steps?.close();
    for (const [i, markdown] of rest.entries()) {
      const part = `answer:${i + 2}`;
      await this.once(part, () => this.posted(part, markdown, said, part === lastPart));
    }
    // Its charts, as images in the thread, each the page's own drawing with its values as alt text: those its card drew
    // aren't sent again, when the answer went as a card (marked so) and Slack didn't refuse it. An answer with no mark
    // (an attempt from before cards, say) has every chart as an image.
    const outcome = run?.outcome;
    if (outcome?.kind === "answer" && outcome.status === "answered" && outcome.charts?.length) {
      const asCard = card !== null && !this.cardRefused && (await begun(CARD_SENT)) && !(await begun(CARD_REFUSED));
      const drawn = new Set(asCard ? card.charts : []);
      const images = outcome.charts.filter((_, i) => !drawn.has(i));
      if (images.length)
        await this.charts(images).catch((error: unknown) => {
          if (error instanceof SlackReplyFenced) throw error;
          deps.log?.("slack reply: its charts weren't posted", { runId: job.runId, why: failureCode(error) });
        });
    }
    if (said.questions?.length) {
      const questions = said.questions;
      const only = questions.length === 1 ? questions[0] : undefined;
      // One question with one pick: its options as buttons, sent on the press. Otherwise one message of them, each
      // with its radio buttons or checkboxes, and Send. Slack refusing them leaves the answer as it is.
      await this.once("questions", () =>
        this.post(
          "questions",
          only && onePress(questions)
            ? {
                text: "Choose one:",
                blocks: [
                  // An option longer than its button is said in full: the press answers with all of it.
                  spelledOut(only.options, "Choose one:") ?? {
                    type: "section",
                    text: { type: "plain_text", text: "Choose one:" },
                  },
                  {
                    type: "actions",
                    elements: only.options.map((o, i) => ({
                      type: "button",
                      action_id: optionAction(i),
                      text: { type: "plain_text", text: buttonText(o) },
                      // The run and the option's place: the press reads what it says from the run.
                      value: JSON.stringify({ r: job.runId, i }),
                    })),
                  },
                ],
              }
            : askBlocks(questions, { runId: job.runId, channel: !this.channel.startsWith("D") }),
        ),
      ).catch((error: unknown) => {
        if (error instanceof SlackReplyFenced) throw error;
        deps.log?.("slack reply: its questions' choices weren't posted", { runId: job.runId, why: slackError(error) });
      });
    }
    if (status) await status.clear();
    else await slack.endTyping(this.threadId).catch(() => {});
    const ts = this.target.slackMessageTs;
    if (ts) {
      await slack.removeReaction(this.threadId, ts, "eyes").catch(() => {});
      if (said.answered) await slack.addReaction(this.threadId, ts, "check").catch(() => {});
    }
    await this.files(said.cited, run?.outcome).catch((error: unknown) => {
      if (error instanceof SlackReplyFenced) throw error;
    });
    await this.deps.withTenant(job.orgId, (tx) =>
      finishSlackReplyAttempt(tx, job.orgId, job.runId, this.attempt, "done"),
    );
  }

  /**
   * The answer's charts as images in the thread (at most four), at most once: each drawn as the page draws it
   * (@opendash/pdf's `chartPng`, the light theme), its title and values as alt text. One that can't be drawn is left
   * out, and the PDF still has it.
   */
  private async charts(charts: ResolvedChart[]) {
    await this.once(
      "charts",
      async () => {
        const drawn = [];
        for (const chart of charts.slice(0, 4)) {
          const image = await chartPng(chart, packageFontDir()).catch((error: unknown) => {
            this.deps.log?.("slack reply: a chart wasn't drawn", { runId: this.job.runId, why: failureCode(error) });
            return null;
          });
          if (image) drawn.push({ chart, image });
        }
        if (!drawn.length) return null;
        await this.client.files.uploadV2({
          channel_id: this.channel,
          ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
          file_uploads: drawn.map(({ chart, image }) => ({
            file: Buffer.from(image.png),
            filename: `${fileStem(chart.title)}.png`,
            title: chart.title,
            alt_text: chartAltText(chart),
          })),
        });
        return null;
      },
      false,
    );
  }

  /**
   * The queries behind the answer, as the asker sees them in OpenDash (query cards): their rows as CSV, their names in
   * the PDF's appendix; and the answer as a PDF, when it has numbers. One message, at most once.
   */
  private async files(citedIds: string[], outcome: Parameters<typeof pdfAnswer>[0]): Promise<void> {
    const { deps, job } = this;
    const viewer = { orgId: job.orgId, userId: this.target.userId };
    const cited = (
      await Promise.all(citedIds.slice(0, 20).map((id) => getQueryCard({ withTenant: deps.withTenant }, viewer, id)))
    ).filter((c): c is QueryCard => c !== null && c.status === "succeeded");
    const cards = cited.filter((c) => c.preview.length > 0).slice(0, deps.maxFiles ?? 3);
    const answer = pdfAnswer(outcome);
    if (!answer && !cards.length) return;
    await this.once(
      "files",
      async () => {
        const pdf = answer
          ? await (async () => {
              const about = await deps.withTenant(job.orgId, (tx) => answerAbout(tx, job.orgId, job.runId));
              if (!about) return null;
              const blocks = answerBlocks(answer, {
                ...about,
                note: `Asked in Slack, answered from ${about.sourceName}. Each number is listed at the end with the query cell it was read from.`,
                names: new Map(cited.map((c) => [c.id, { alias: c.alias, title: c.title }])),
              });
              return {
                filename: pdfFileName(about.question),
                data: Buffer.from(
                  await renderPdf(blocks, about.question, undefined, {
                    onChartError: (error) =>
                      deps.log?.("slack reply: a chart drawn as a table", { runId: job.runId, why: String(error) }),
                  }),
                ),
              };
            })().catch(() => null)
          : null;
        if (!pdf && !cards.length) return null;
        // Left the workspace while the files were made: they aren't sent (the answer went while they were a member).
        const still = await deps.withTenant(job.orgId, (tx) => slackReplyOf(tx, job.orgId, job.runId));
        if (!still?.linked) return null;
        const rows = cards.length === 1 ? "the rows behind it as CSV" : "the rows behind it as CSV, a file a query";
        const sent = await this.bot.thread(this.threadId).post({
          markdown: pdf
            ? cards.length
              ? `The answer as a PDF, and ${rows}.`
              : "The answer as a PDF."
            : `${rows[0]?.toUpperCase()}${rows.slice(1)}.`,
          files: [
            ...(pdf ? [{ filename: pdf.filename, data: pdf.data, mimeType: "application/pdf" }] : []),
            ...cards.map((c) => {
              const csv = cardCsv(c);
              return { filename: csv.filename, data: csv.data, mimeType: "text/csv" };
            }),
          ],
        });
        return (sent as { id?: string } | undefined)?.id ?? null;
      },
      false,
    );
  }

  /** The reply ends without its answer: the person told where it is (once), the session and 👀 cleared. */
  async giveUp(): Promise<void> {
    const { slack, job } = this;
    const run = await getRun(
      { withTenant: this.deps.withTenant },
      { orgId: job.orgId, userId: this.target.userId },
      job.runId,
    );
    const url = run?.thread_id ? `${this.url}/ask/${encodeURIComponent(run.thread_id)}` : this.url;
    await this.once("gave_up", () => this.post("gave_up", { markdown_text: quiet(gaveUpText(url)) })).catch(
      (error: unknown) => {
        if (error instanceof SlackReplyFenced) throw error;
      },
    );
    // Its steps, if a handed-off attempt left them open, stopped as they are.
    const shown = await this.deps.withTenant(job.orgId, (tx) => slackReplySteps(tx, job.orgId, job.runId));
    if (shown.steps) await this.client.chat.stopStream({ channel: this.channel, ts: shown.steps.ts }).catch(() => {});
    await slack.endTyping(this.threadId).catch(() => {});
    const ts = this.target.slackMessageTs;
    if (ts) await slack.removeReaction(this.threadId, ts, "eyes").catch(() => {});
    await this.deps.withTenant(job.orgId, (tx) =>
      finishSlackReplyAttempt(tx, job.orgId, job.runId, this.attempt, "failed"),
    );
  }
}

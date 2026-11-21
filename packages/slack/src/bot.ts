/**
 * The OpenDash bot in Slack: Chat SDK with the Slack adapter in agent view. It hears a question in
 * a direct message, the Agents tab, or a channel where it's mentioned; finds who's asking; asks as that member; and
 * leaves the reply to the worker's slack.reply job, which follows the run. Every message and action handler is thin.
 */
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import {
  answeredAll,
  approveLearning,
  askFromSlack,
  BUDGETS,
  clarifyAnswer,
  confirmedSlackEmail,
  connectedSlackTeam,
  type DeploymentKeys,
  dismissInsight,
  enqueue,
  type FeedbackDeps,
  giveFeedback,
  type LedgerDeps,
  rejectLearning,
  revertLearning,
  type SecretStore,
  slackAnswerOf,
  slackAsker,
  slackAskOf,
  slackBotToken,
  slackFilesQueue,
  slackInboundHandled,
  slackSuggestions,
  startInvestigation,
  startSlackLink,
  stopSlackRunFor,
  suggestLearning,
  undoRemember,
  unlinkSlackIdentity,
} from "@opendash/core";
import type { PublicTx } from "@opendash/db";
import { Actions, Button, Card, CardText, Chat, LinkButton, type StateAdapter, type Thread } from "chat";
import type { PgBoss } from "pg-boss";
import { answeredText, picksOf, SEND_ACTION } from "./ask";
import { type IncomingFile, readFiles } from "./files";
import { HOME_LINK, HOME_UNLINK, publishSlackHome } from "./home";
import { DEDUPE_TTL_MS, inboundKeyOf, teamOf } from "./inbound";
import { LEARNING_APPROVE, LEARNING_REJECT, LEARNING_REVERT, LEARNING_SUGGEST, REVERTED } from "./learning";
import { tellPrivately, threadShownFor } from "./privately";
import { DOWNLOAD_ACTION, FEEDBACK_ACTION, MEMORY_UNDO, NEXT_ACTIONS, quiet, RATE_ACTIONS } from "./reply";
import { findingChoice, ROUTINE_FINDING } from "./routine";

export interface SlackBotDeps {
  withTenant: LedgerDeps["withTenant"];
  /** A transaction carrying the person too: a correction given with 👎 is kept as their own memory. */
  withUser?: FeedbackDeps["withUser"];
  withPublic: <T>(fn: (tx: PublicTx) => Promise<T>) => Promise<T>;
  secrets: SecretStore;
  boss: () => Promise<PgBoss>;
  deploymentKeys: DeploymentKeys;
  /** The web app's origin, for links into OpenDash. */
  webUrl: string;
}

export interface SlackBotConfig {
  /** Slack's signing secret: what an event over HTTPS must be signed with. */
  signingSecret: string;
  /**
   * What lets an event in that OpenDash's own Socket Mode connection read first (socket.ts), in the worker. The web
   * app gets a random one nobody knows, so nothing forwarded is ever taken there.
   */
  forwardingSecret: string;
  state: StateAdapter;
  /** A stand-in for Slack's API (tests). */
  apiUrl?: string;
}

/** A suggested prompt's label: the question, cut at a word to fit a button. */
export function promptTitle(question: string, max = 40): string {
  if (question.length <= max) return question;
  const cut = question.slice(0, max - 1);
  // Ends at a word already, or else back to the last whole word (unless that leaves too little).
  const space = /\s/.test(question[max - 1] ?? "") ? cut.length : cut.lastIndexOf(" ");
  return `${cut.slice(0, space > max / 2 ? space : cut.length).trimEnd()}…`;
}

/** The question without the bot's mention. */
export const questionText = (text: string) =>
  text
    .replace(/<@[A-Z0-9]+>/g, "")
    .replace(/^\s*@\S+\s*/, "")
    .trim();

/** A conversation's title from its question, as OpenDash names it (`submitQuestion`): the question, cut at 80. */
export const conversationTitle = (text: string) => {
  const question = questionText(text);
  return question.length > 80 ? `${question.slice(0, 79)}…` : question;
};

/** What a question needs from a Slack message (or a button press that stands for one). */
interface Asked {
  raw: unknown;
  author: { userId: string; fullName?: string; userName?: string; email?: string };
  id: string;
  text: string;
  attachments?: unknown[];
}

/** A button's value as JSON ({r: run, i: place}), or null (a button from before values carried them). */
/** What a press carries: a run (`r`), a place (`i`), a memory (`m`), a proposal (`p`), a file (`f`, or a query `q`). */
type PressValue = { r?: unknown; i?: unknown; m?: unknown; p?: unknown; f?: unknown; q?: unknown };
const buttonValue = (value: string | undefined): PressValue | null => {
  try {
    const v = JSON.parse(value ?? "") as unknown;
    return v && typeof v === "object" ? (v as PressValue) : null;
  } catch {
    return null;
  }
};

/** The 👎's box: what the answer should have said. Slack keeps a box's title to 24 characters. */
export const FEEDBACK_MODAL = "opendash:feedback";

/** The run a Send press answers, from its button's value. */
const sentRun = (value: string | undefined): string | null => {
  try {
    const r = (JSON.parse(value ?? "{}") as { r?: unknown }).r;
    return typeof r === "string" ? r : null;
  } catch {
    return null;
  }
};

/** A Slack message's id (its ts); a button press stands for a message with an id of its own. */
const SLACK_TS = /^\d{6,12}\.\d{1,9}$/;

const SOURCE_ACTION = "opendash:source";
const OPTION_ACTION = "opendash:option";
/**
 * A button's id: each its own, since Slack refuses a message whose buttons share one (`invalid_blocks`). The bare ids
 * are kept for buttons posted before.
 */
export const sourceAction = (i: number) => `${SOURCE_ACTION}:${i}`;
export const optionAction = (i: number) => `${OPTION_ACTION}:${i}`;
const SOURCE_ACTIONS = [SOURCE_ACTION, ...Array.from({ length: 5 }, (_, i) => sourceAction(i))];
const OPTION_ACTIONS = [OPTION_ACTION, ...Array.from({ length: 4 }, (_, i) => optionAction(i))];

/**
 * p-retry's hook for the chat client's own retries: a rate limit (the client throws a plain error once it has waited
 * Slack out) goes again; a request that failed or timed out, or any answer Slack gave, stops there. The reply's job
 * tries again, looking for what it posted first, where the client's own retry could post twice.
 */
export function onlyRateLimits(error: Error): void {
  if ((error as { code?: unknown }).code !== undefined) throw error;
}

/**
 * The chat client's requests (replies, App Home, notices): each bounded by the Slack budget, and only a rate limit
 * tried again. p-retry reads `onFailedAttempt` from the client's retryConfig, though its types don't list it.
 */
export const slackClientOptions = {
  timeout: BUDGETS.slack.apiMs,
  retryConfig: {
    retries: BUDGETS.slack.rateLimitRetries,
    factor: 2,
    minTimeout: 1_000,
    maxTimeout: 5_000,
    onFailedAttempt: onlyRateLimits,
  },
};

export function createSlackBot(deps: SlackBotDeps, config: SlackBotConfig): { bot: Chat; slack: SlackAdapter } {
  const slack = createSlackAdapter({
    agentView: true,
    webClientOptions: slackClientOptions,
    // Events reach the adapter over HTTPS, or forwarded from OpenDash's own socket: never its own socket.
    mode: "webhook",
    signingSecret: config.signingSecret,
    socketForwardingSecret: config.forwardingSecret,
    ...(config.apiUrl ? { apiUrl: config.apiUrl } : {}),
    // Each workspace's token, decrypted from OpenDash: every install is Add to Slack's, so there's no single
    // token. The SDK's own storage isn't used.
    installationProvider: {
      getInstallation: async (teamId: string) => {
        const found = await slackBotToken(deps, teamId);
        return found?.token ? { botToken: found.token, botUserId: found.botUserId } : null;
      },
    },
    // The Slack session's title is the OpenDash conversation's: the question, named the same way.
    sessionTitle: ({ text }: { text: string }) => conversationTitle(text),
    // When someone opens OpenDash in Slack: questions from their own data, as the empty Ask page suggests; without
    // them (not linked yet, several sources), the manifest's own.
    suggestedPrompts: async ({ teamId, userId }: { teamId?: string; userId: string }) => {
      const questions = teamId ? await slackSuggestions(deps, teamId, userId).catch(() => null) : null;
      return questions
        ? { title: "Try asking", prompts: questions.map((q) => ({ title: promptTitle(q), message: q })) }
        : null;
    },
  } as Parameters<typeof createSlackAdapter>[0]);
  /** A Slack user's email, read fresh with their workspace's token, when Slack confirmed it's theirs (else null). */
  const confirmedEmailOf = async (teamId: string, slackUserId: string): Promise<string | null> => {
    const found = await slackBotToken(deps, teamId);
    if (!found?.token) return null;
    let email: string | null = null;
    await slack.withBotToken(
      found.token,
      async () => {
        const users = (
          slack.webClient as unknown as { users: { info(a: { user: string }): Promise<{ user?: unknown }> } }
        ).users;
        const read = await users.info({ user: slackUserId }).catch(() => null);
        email = confirmedSlackEmail(read?.user as Parameters<typeof confirmedSlackEmail>[0]);
      },
      { installationId: teamId },
    );
    return email;
  };

  const bot = new Chat({
    userName: "opendash",
    adapters: { slack },
    state: config.state,
    // Every message handled, none dropped for one being handled in its thread: Postgres orders them (a quick second
    // question is a follow-up). Its memory of messages handled is what a replay waits out (inbound.ts).
    concurrency: "concurrent",
    dedupeTtlMs: DEDUPE_TTL_MS,
  });

  /** Says something to the asker only: privately in a channel, where Slack shows it; in a direct message, as usual. */
  const tell = async (thread: Thread<unknown>, message: Asked, text: string) =>
    tellPrivately(thread, message.author.userId, text, threadShownFor(message.raw));

  /**
   * A handler's question, marked handled once it's done: one that asked was marked in the asking, and
   * one whose handler failed is left for the replay.
   */
  async function handling(raw: unknown, work: () => Promise<void>) {
    await work();
    const key = inboundKeyOf(raw);
    const teamId = teamOf(raw);
    if (!key || !teamId) return;
    const team = await connectedSlackTeam(deps, teamId);
    if (team) await slackInboundHandled(deps, team.orgId, teamId, key);
  }

  async function ask(
    thread: Thread<unknown>,
    message: Asked,
    options: { connectionId?: string; inboundKey?: string | null } = {},
  ) {
    const teamId = teamOf(message.raw);
    const slackUserId = message.author.userId;
    if (!teamId) return;
    const asker = await slackAsker(deps, teamId, slackUserId);
    if (asker.kind === "unconnected") {
      await tell(
        thread,
        message,
        "OpenDash isn't added to this Slack workspace yet. An owner or admin adds it in OpenDash, Settings → Slack.",
      );
      return;
    }
    if (asker.kind === "unlinked") {
      // Their Slack email goes with the link (users:read.email): confirming checks it's the signed-in person's own. It's
      // read fresh from Slack, and only an address Slack confirmed is theirs counts (slackConfirmedEmail).
      const profile = message.author.fullName ? message.author : await slack.getUser(slackUserId).catch(() => null);
      const slackUser = {
        name: profile?.fullName || profile?.userName || message.author.fullName || message.author.userName || null,
        email: await confirmedEmailOf(teamId, slackUserId),
      };
      const token = await deps.withTenant(asker.orgId, (tx) =>
        startSlackLink(tx, asker.orgId, teamId, slackUserId, slackUser),
      );
      const link = Card({
        children: [
          CardText(
            "Link your Slack account to OpenDash, so you ask as yourself, with your access. The link works once, for 10 minutes.",
          ),
          // The token is the link's fragment: it never reaches a server's logs.
          Actions([LinkButton({ label: "Link account", url: `${deps.webUrl}/slack/link#${token}`, style: "primary" })]),
        ],
      });
      await tellPrivately(thread, message.author.userId, link, threadShownFor(message.raw));
      return;
    }
    // Its record, marked asked as it's asked: a message's own, or the press it stands for.
    const inboundKey = options.inboundKey === undefined ? inboundKeyOf(message.raw) : options.inboundKey;
    const files = await readFiles((message.attachments ?? []) as IncomingFile[]);
    // A note names the file, and a file can be named anything: it's said as plain text.
    if (files.notes.length) await tell(thread, message, quiet(files.notes.join("\n")));
    const text = questionText(message.text);
    if (!text && !files.read.length) return;
    const result = await askFromSlack(
      { withTenant: deps.withTenant, boss: await deps.boss(), deploymentKeys: deps.deploymentKeys },
      {
        orgId: asker.orgId,
        userId: asker.userId,
        role: asker.role,
        teamId,
        slackThreadId: thread.id,
        slackUserId,
        slackMessageId: message.id,
        text: text || "What does this file say?",
        files: files.read,
        ...(options.connectionId ? { connectionId: options.connectionId } : {}),
        ...(inboundKey ? { inboundKey } : {}),
      },
    );
    if (result.kind === "refused") {
      await tell(thread, message, result.message);
      return;
    }
    // The answer being worked on here reads it next, and its reply covers both.
    if (result.kind === "queued") {
      await tell(thread, message, "Added to what I'm working on.");
      return;
    }
    if (result.kind === "choose_source") {
      await thread.post(
        Card({
          children: [
            CardText("Which data should I use?"),
            Actions(
              result.sources.slice(0, 5).map((s, i) =>
                Button({
                  id: sourceAction(i),
                  label: s.name.slice(0, 70),
                  // The source and the message it answers: Slack keeps the message, so it's read again from there.
                  value: JSON.stringify({ c: s.id, m: message.id }),
                }),
              ),
            ),
          ],
        }),
      );
      return;
    }
    // Picked up: 👀 on the question and the status line, at once (the worker's job takes over both in a moment).
    // Neither is worth failing a question for.
    if (SLACK_TS.test(message.id)) await thread.adapter.addReaction(thread.id, message.id, "eyes").catch(() => {});
    await thread.startTyping("Reading your question…").catch(() => {});
    // Follow-ups in a channel's thread reach the bot once it's subscribed; the reply comes from the worker.
    if (!thread.isDM) await thread.subscribe();
  }

  bot.onDirectMessage(async (thread, message) => handling(message.raw, () => ask(thread, message)));
  bot.onNewMention(async (thread, message) => handling(message.raw, () => ask(thread, message)));
  bot.onSubscribedMessage(async (thread, message) => {
    // In a channel's thread, only what's addressed to it (nothing else was recorded).
    if (message.isMention) await handling(message.raw, () => ask(thread, message));
  });

  bot.onAction(SOURCE_ACTIONS, async (event) =>
    handling(event.raw, async () => {
      const { c, m } = JSON.parse(event.value ?? "{}") as { c?: string; m?: string };
      if (!c || !m || !event.thread) return;
      const found = await event.thread.adapter.fetchMessages(event.thread.id, { limit: 50 });
      const original = found.messages.find((x) => x.id === m);
      // The question asked is the original message's; the record is the press's. The buttons then say which.
      if (original && original.author.userId === event.user.userId) {
        await ask(event.thread, original, { connectionId: c, inboundKey: inboundKeyOf(event.raw) });
        const chosen = (event.raw as { actions?: { text?: { text?: unknown } }[] } | null)?.actions?.[0]?.text?.text;
        if (typeof chosen === "string" && chosen) {
          await event.adapter
            .editMessage(event.threadId, event.messageId, { markdown: quiet(`Using **${chosen}**.`) })
            .catch(() => {});
        }
      }
    }),
  );

  bot.onAction(OPTION_ACTIONS, async (event) =>
    handling(event.raw, async () => {
      const thread = event.thread;
      const teamId = teamOf(event.raw);
      if (!thread || !teamId || !event.value) return;
      const value = buttonValue(event.value);
      if (!value) {
        // A button from before its value named the run: the option itself, asked as the person's answer.
        await ask(thread, {
          raw: event.raw,
          author: event.user,
          id: `${event.messageId}:${event.value}`,
          text: event.value,
        });
        return;
      }
      // The chosen option, asked as the person's answer, in the same conversation: by the person who asked, while
      // it's the latest ask, once (the form's own id). The buttons then show what was chosen.
      const pressed: Asked = { raw: event.raw, author: event.user, id: `${event.messageId}:answer`, text: "" };
      const asker = await slackAsker(deps, teamId, event.user.userId);
      if (asker.kind === "unconnected" || typeof value.r !== "string" || typeof value.i !== "number") return;
      const runId = value.r;
      const place = value.i;
      const asked = await deps.withTenant(asker.orgId, (tx) => slackAskOf(tx, asker.orgId, runId));
      const option = asked?.questions[0]?.options[place];
      if (!asked || option === undefined) return;
      if (asked.slackUserId !== event.user.userId) {
        await tell(thread, pressed, "Only the person who asked can answer these.");
        return;
      }
      if (!asked.latest) {
        await tell(thread, pressed, "This was answered already.");
        return;
      }
      await ask(thread, { ...pressed, text: option });
      await event.adapter
        .editMessage(event.threadId, event.messageId, { markdown: quiet(answeredText(asked.questions, [[place]])) })
        .catch(() => {});
    }),
  );

  // A follow-up the answer offered, asked in the same conversation: by the person who asked, while the
  // answer is still the conversation's latest, once (one follow-up an answer).
  bot.onAction(NEXT_ACTIONS, async (event) =>
    handling(event.raw, async () => {
      const thread = event.thread;
      const teamId = teamOf(event.raw);
      const value = buttonValue(event.value);
      if (!thread || !teamId || typeof value?.r !== "string" || typeof value.i !== "number") return;
      const runId = value.r;
      const place = value.i;
      const pressed: Asked = { raw: event.raw, author: event.user, id: `next:${runId}`, text: "" };
      const asker = await slackAsker(deps, teamId, event.user.userId);
      if (asker.kind === "unconnected") return;
      const answer = await deps.withTenant(asker.orgId, (tx) => slackAnswerOf(tx, asker.orgId, runId));
      const followUp = answer?.next[place];
      if (!answer || followUp === undefined) return;
      if (answer.slackUserId !== event.user.userId) {
        await tell(thread, pressed, "Only the person who asked can take its follow-ups here. Ask in your own words.");
        return;
      }
      if (!answer.latest) {
        await tell(thread, pressed, "This answer was followed up already. Ask in your own words.");
        return;
      }
      await ask(thread, { ...pressed, text: followUp });
    }),
  );

  // A file from an answer's Download menu (its PDF, a cited query's rows as CSV): by the person who asked, as
  // they see it; the worker makes it and posts it in the thread.
  bot.onAction(DOWNLOAD_ACTION, async (event) =>
    handling(event.raw, async () => {
      const thread = event.thread;
      const teamId = teamOf(event.raw);
      const value = buttonValue(event.value);
      if (!thread || !teamId || typeof value?.r !== "string") return;
      const runId = value.r;
      const file = value.f === "pdf" ? "pdf" : typeof value.q === "string" ? (`csv:${value.q}` as const) : null;
      if (!file) return;
      const pressed: Asked = { raw: event.raw, author: event.user, id: `download:${runId}`, text: "" };
      const asker = await slackAsker(deps, teamId, event.user.userId);
      if (asker.kind === "unconnected") return;
      const answer = await deps.withTenant(asker.orgId, (tx) => slackAnswerOf(tx, asker.orgId, runId));
      if (!answer) return;
      if (answer.slackUserId !== event.user.userId || asker.kind !== "member") {
        await tell(thread, pressed, "Only the person who asked can download its files here. Open it in OpenDash.");
        return;
      }
      const boss = await deps.boss();
      await deps.withTenant(asker.orgId, (tx) =>
        enqueue(boss, tx, slackFilesQueue, { orgId: asker.orgId, runId, file }),
      );
    }),
  );

  // Undo of what an answer remembered for its asker: only the memory's owner can, as on the web; the ones it
  // replaced are kept again.
  bot.onAction(MEMORY_UNDO, async (event) => {
    const id = buttonValue(event.value)?.m;
    const teamId = teamOf(event.raw);
    const thread = event.thread;
    if (typeof id !== "string" || !teamId || !thread || !deps.withUser) return;
    const pressed: Asked = { raw: event.raw, author: event.user, id: `undo:${id}`, text: "" };
    const asker = await slackAsker(deps, teamId, event.user.userId);
    if (asker.kind !== "member") return;
    const undone = await deps.withUser(asker.orgId, asker.userId, (tx) =>
      undoRemember(tx, { orgId: asker.orgId, userId: asker.userId }, id),
    );
    await tell(
      thread,
      pressed,
      undone
        ? "Forgotten. Your earlier memory about it, if any, is back."
        : "Only the person it was remembered for can undo it, once.",
    );
  });

  // A learning: an owner's or admin's one tap, Not this, or Revert, checked again here; and Suggest for the
  // team, someone sharing their own correction. The answer is told privately.
  bot.onAction(
    [LEARNING_APPROVE, LEARNING_REJECT, LEARNING_REVERT, LEARNING_SUGGEST, `${LEARNING_SUGGEST}:1`],
    async (event) => {
      const teamId = teamOf(event.raw);
      const thread = event.thread;
      if (!teamId || !thread) return;
      const pressed: Asked = { raw: event.raw, author: event.user, id: `learning:${event.actionId}`, text: "" };
      const asker = await slackAsker(deps, teamId, event.user.userId);
      if (asker.kind !== "member") {
        if (asker.kind === "unlinked") await tell(thread, pressed, "Link your Slack account to OpenDash first.");
        return;
      }
      const who = { orgId: asker.orgId, userId: asker.userId };
      const v = buttonValue(event.value);
      if (event.actionId.startsWith(LEARNING_SUGGEST)) {
        const memoryId = typeof v?.m === "string" ? v.m : "";
        const made = deps.withUser
          ? await deps.withUser(asker.orgId, asker.userId, (tx) => suggestLearning(tx, who, memoryId))
          : null;
        await tell(
          thread,
          pressed,
          made
            ? "Suggested for the team: OpenDash checks it on your data, and an admin can make it everyone's."
            : "Only the person it was remembered for can suggest it.",
        );
        return;
      }
      if (asker.role !== "owner" && asker.role !== "admin") {
        await tell(thread, pressed, "Only owners and admins make a learning the team's.");
        return;
      }
      const id = typeof v?.p === "string" ? v.p : "";
      if (event.actionId === LEARNING_REVERT) {
        const reverted = await deps.withTenant(asker.orgId, (tx) => revertLearning(tx, who, id));
        await tell(thread, pressed, REVERTED[reverted]);
        return;
      }
      const done = await deps.withTenant(asker.orgId, (tx) =>
        event.actionId === LEARNING_APPROVE ? approveLearning(tx, who, id) : rejectLearning(tx, who, id),
      );
      const said =
        event.actionId === LEARNING_APPROVE
          ? done
            ? "Done: it's a team learning now. Every analyst on this source uses it."
            : "That learning isn't waiting any more."
          : done
            ? "Left out: it won't be the team's."
            : "That learning isn't waiting any more.";
      await tell(thread, pressed, said);
    },
  );

  // A routine's finding in a channel: Investigate (anyone who can ask, as on the web) or Dismiss with why
  // (owners and admins), each checked again here as the presser's own act, in their workspace. Told privately.
  bot.onAction(ROUTINE_FINDING, async (event) => {
    const teamId = teamOf(event.raw);
    const thread = event.thread;
    if (!teamId || !thread) return;
    const pressed: Asked = { raw: event.raw, author: event.user, id: `finding:${event.actionId}`, text: "" };
    const asker = await slackAsker(deps, teamId, event.user.userId);
    if (asker.kind !== "member") {
      if (asker.kind === "unlinked") await tell(thread, pressed, "Link your Slack account to OpenDash first.");
      return;
    }
    const choice = findingChoice(event.value);
    if (!choice) return;
    if (choice.action === "investigate") {
      if (asker.role === "viewer") {
        await tell(thread, pressed, "Your role can't start investigations.");
        return;
      }
      const out = await startInvestigation(
        { withTenant: deps.withTenant, boss: await deps.boss(), deploymentKeys: deps.deploymentKeys },
        { orgId: asker.orgId, insightId: choice.insightId, requestedBy: asker.userId },
      );
      await tell(
        thread,
        pressed,
        out.status === "not_investigable"
          ? "Only an open finding about a metric's change can be investigated."
          : out.status === "held"
            ? "It can't be investigated now: this month's background budget is spent. An admin can raise it."
            : out.status === "queued" || out.status === "running"
              ? "Investigating. The verdict shows on it in Insights."
              : "It's been investigated: the verdict is on it in Insights.",
      );
      return;
    }
    if (asker.role !== "owner" && asker.role !== "admin") {
      await tell(thread, pressed, "Only owners and admins dismiss findings.");
      return;
    }
    const done = await deps.withTenant(asker.orgId, (tx) =>
      dismissInsight(
        tx,
        { orgId: asker.orgId, userId: asker.userId, canManage: true },
        choice.insightId,
        choice.reason,
      ),
    );
    await tell(thread, pressed, done ? "Dismissed for everyone, with why." : "It isn't open any more.");
  });

  // 👍/👎 under an answer, Slack's own buttons or the plain ones: the asker's feedback, as the web's
  // (one a person a run, changed in place, so a press again is the same). 👎 asks what it should have said first, in a
  // box opened at once (Slack's trigger lives three seconds); what's written there is a correction, as on the web.
  const feedbackDeps: FeedbackDeps = {
    withTenant: deps.withTenant,
    ...(deps.withUser ? { withUser: deps.withUser } : {}),
  };
  /** The presser as the asker of `runId`'s answer: their OpenDash membership, or why not (said to them). */
  async function rater(thread: Thread<unknown>, raw: unknown, author: Asked["author"], runId: string) {
    const teamId = teamOf(raw);
    if (!teamId) return null;
    const pressed: Asked = { raw, author, id: `rate:${runId}`, text: "" };
    const asker = await slackAsker(deps, teamId, author.userId);
    if (asker.kind === "unconnected") return null;
    const answer = await deps.withTenant(asker.orgId, (tx) => slackAnswerOf(tx, asker.orgId, runId));
    if (!answer) return null;
    if (answer.slackUserId !== author.userId) {
      await tell(thread, pressed, "Only the person who asked can rate this answer.");
      return null;
    }
    if (asker.kind !== "member") {
      await tell(thread, pressed, "Link your Slack account to OpenDash to rate answers.");
      return null;
    }
    return { viewer: { orgId: asker.orgId, userId: asker.userId }, pressed };
  }
  bot.onAction([FEEDBACK_ACTION, ...RATE_ACTIONS], async (event) => {
    const m = /^(up|down):(.+)$/.exec(event.value ?? "");
    const thread = event.thread;
    if (!m || !thread) return;
    const [, kind, runId = ""] = m;
    const who = await rater(thread, event.raw, event.user, runId);
    if (!who) return;
    if (kind === "down") {
      await event.openModal({
        type: "modal",
        callbackId: FEEDBACK_MODAL,
        title: "Feedback",
        submitLabel: "Send",
        privateMetadata: JSON.stringify({ r: runId }),
        children: [
          {
            type: "text_input",
            id: "correction",
            label: "What should it have said?",
            placeholder: "It should leave out refunds.",
            multiline: true,
            optional: true,
            maxLength: 2_000,
          },
        ],
      });
      return;
    }
    const given = await giveFeedback(feedbackDeps, who.viewer, { runId, kind: "up" });
    await tell(thread, who.pressed, given ? "Thanks, noted." : "This answer can't be rated any more.");
  });
  bot.onModalSubmit(FEEDBACK_MODAL, async (event) => {
    const r = buttonValue(event.privateMetadata)?.r;
    const thread = event.relatedThread;
    if (typeof r !== "string" || !thread) return;
    const who = await rater(thread as Thread<unknown>, event.raw, event.user, r);
    if (!who) return;
    const correction = event.values.correction?.trim();
    const given = await giveFeedback(feedbackDeps, who.viewer, {
      runId: r,
      kind: "down",
      ...(correction ? { correction } : {}),
    });
    await tell(
      thread as Thread<unknown>,
      who.pressed,
      !given
        ? "This answer can't be rated any more."
        : given.correction
          ? "Thanks. I'll keep that in mind for your next questions, and an admin can make it a guide for everyone."
          : "Thanks, noted.",
    );
  });

  // The questions' Send: every pick from the press's state, asked as the person's answer: by the person
  // who asked, while it's the conversation's latest ask, once (the press's own id). The form then shows what was
  // picked, with nothing left to press.
  bot.onAction(SEND_ACTION, async (event) => handling(event.raw, () => send(event)));

  async function send(event: Parameters<Parameters<typeof bot.onAction>[1]>[0]) {
    const thread = event.thread;
    const teamId = teamOf(event.raw);
    const runId = sentRun(event.value);
    if (!thread || !teamId || !runId) return;
    const pressed: Asked = { raw: event.raw, author: event.user, id: `${event.messageId}:answer`, text: "" };
    const asker = await slackAsker(deps, teamId, event.user.userId);
    if (asker.kind === "unconnected") return;
    const asked = await deps.withTenant(asker.orgId, (tx) => slackAskOf(tx, asker.orgId, runId));
    if (!asked) return;
    if (asked.slackUserId !== event.user.userId) {
      await tell(thread, pressed, "Only the person who asked can answer these.");
      return;
    }
    if (!asked.latest) {
      await tell(thread, pressed, "These were answered already.");
      return;
    }
    const picks = picksOf((event.raw as { state?: unknown } | null)?.state, asked.questions);
    if (!answeredAll(asked.questions, picks)) {
      await tell(thread, pressed, "Pick an answer for each question, then Send. Or reply in your own words.");
      return;
    }
    await ask(thread, { ...pressed, text: clarifyAnswer(asked.questions, picks) });
    await event.adapter
      .editMessage(event.threadId, event.messageId, { markdown: quiet(answeredText(asked.questions, picks)) })
      .catch(() => {});
  }

  // App Home's own buttons: Unlink, or Link account (a link made now, shown on the tab). The tab is
  // published again either way.
  bot.onAction([HOME_LINK, HOME_UNLINK], async (event) => {
    const teamId = teamOf(event.raw);
    const slackUserId = event.user.userId;
    if (!teamId) return;
    const asker = await slackAsker(deps, teamId, slackUserId);
    if (asker.kind === "unconnected") return;
    let link: string | null = null;
    if (event.actionId === HOME_UNLINK) {
      await deps.withTenant(asker.orgId, (tx) => unlinkSlackIdentity(tx, asker.orgId, slackUserId));
    } else if (asker.kind === "unlinked") {
      const profile = await slack.getUser(slackUserId).catch(() => null);
      const email = await confirmedEmailOf(teamId, slackUserId);
      const token = await deps.withTenant(asker.orgId, (tx) =>
        startSlackLink(tx, asker.orgId, teamId, slackUserId, {
          name: profile?.fullName || profile?.userName || null,
          email,
        }),
      );
      // The token is the link's fragment: it never reaches a server's logs.
      link = `${deps.webUrl}/slack/link#${token}`;
    }
    await publishSlackHome(deps, slack, teamId, slackUserId, link);
  });

  bot.onAgentSessionStopped(async (event) => {
    await stopSlackRunFor({ ...deps, boss: await deps.boss() }, event.threadId, event.userId);
  });

  return { bot, slack };
}

export { OPTION_ACTION, OPTION_ACTIONS, SOURCE_ACTION, SOURCE_ACTIONS };

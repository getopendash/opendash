/**
 * OpenDash in Slack, the worker's part: with an app-level token (SLACK_APP_TOKEN) it holds OpenDash's own
 * Socket Mode connection, one for every workspace that added the app, so Slack reaches OpenDash with no public address
 * (local, self-host). Either way it runs slack.reply, following each run asked from Slack back there, and every minute
 * hands the bot again any question nothing handled in time (slack.inbound.check), whichever way it came in. Off
 * when the deployment has no Slack app.
 */
import { randomBytes } from "node:crypto";
import {
  deploymentKeys,
  loggableError,
  type SecretStore,
  type SlackFilesJob,
  type SlackReplyJob,
  slackFilesQueue,
  slackInboundDeadLetter,
  slackInboundQueue,
  slackRemovedBySlack,
  slackReplyDeadLetter,
  slackReplyQueue,
} from "@opendash/core";
import { withPublic, withSystem, withTenant } from "@opendash/db";
import { emailLinkOrigin } from "@opendash/email";
import {
  abandonSlackReply,
  createSlackBot,
  deliverSlackFile,
  deliverSlackReply,
  gateSlackEvent,
  publishSlackHome,
  replaySlackInbound,
  SlackReplyHandOff,
  slackSetup,
  slackState,
  startSlackSocket,
  tellLearning,
} from "@opendash/slack";
import type { PgBoss } from "pg-boss";

type Log = (msg: string, fields?: Record<string, unknown>) => void;

export async function startSlack(ctx: {
  boss: PgBoss;
  secrets: SecretStore;
  log: Log;
  /** Raised at a shutdown: a reply still following its run hands off to the next attempt. */
  drain: AbortSignal;
}): Promise<{
  stopListening: () => Promise<void>;
  stop: () => Promise<void>;
  tellLearning: (orgId: string, proposalId: string) => Promise<number>;
} | null> {
  const env = process.env;
  const setup = slackSetup(env);
  if (setup.kind === "off") {
    // Said only when it looks half set up: a deployment with no Slack at all stays quiet.
    if (setup.legacyToken || setup.missing.length < 3) {
      ctx.log("slack off: Add to Slack needs the app's keys", {
        missing: setup.missing,
        ...(setup.legacyToken ? { note: "SLACK_BOT_TOKEN isn't used any more" } : {}),
      });
    }
    return null;
  }
  const systemUrl = env.DATABASE_SYSTEM_URL?.trim();
  const webUrl = emailLinkOrigin();
  if (!systemUrl || !webUrl) {
    ctx.log("slack off: set DATABASE_SYSTEM_URL and BETTER_AUTH_URL (the web app's https origin in production)");
    return null;
  }
  const tenant = <T>(orgId: string, fn: Parameters<typeof withTenant<T>>[1]) => withTenant({ orgId }, fn);
  const deps = {
    withTenant: tenant,
    // A correction given with 👎 is kept as the person's own memory, in a transaction that carries them.
    withUser: <T>(orgId: string, userId: string, fn: Parameters<typeof withTenant<T>>[1]) =>
      withTenant({ orgId, userId }, fn),
    withPublic,
    secrets: ctx.secrets,
    boss: async () => ctx.boss,
    deploymentKeys: deploymentKeys(),
    webUrl,
  };
  const { state, close } = slackState(systemUrl);
  // What lets an event OpenDash's own socket read first into the adapter: this process's alone.
  const forwardingSecret = randomBytes(32).toString("hex");
  const { bot, slack } = createSlackBot(deps, {
    signingSecret: env.SLACK_SIGNING_SECRET?.trim() ?? "",
    forwardingSecret,
    state,
  });
  await bot.initialize();
  const socket = setup.socket
    ? await startSlackSocket({
        appToken: env.SLACK_APP_TOKEN?.trim() ?? "",
        forwardingSecret,
        slack,
        onRemoval: async (removal) => {
          if (await slackRemovedBySlack(deps, removal)) ctx.log("slack removed the app", { ...removal });
        },
        gate: (envelope) => gateSlackEvent(deps, envelope),
        onHome: ({ teamId, userId }) =>
          publishSlackHome(deps, slack, teamId, userId).catch((error: unknown) =>
            ctx.log("slack home not published", { teamId, error: loggableError(error) }),
          ),
        log: ctx.log,
      })
    : null;
  // What a replay starts is kept, like the socket's events, so stopping waits for it.
  const replays = new Set<Promise<unknown>>();
  const track = (task: Promise<unknown>) => {
    const kept = task.catch((error: unknown) => ctx.log("slack replay failed", { error: loggableError(error) }));
    replays.add(kept);
    void kept.finally(() => replays.delete(kept));
  };
  await ctx.boss.work(slackInboundQueue.name, async () => {
    const done = await replaySlackInbound({ ...deps, withSystem }, bot, slack, forwardingSecret, track);
    if (done.replayed || done.lost) ctx.log("slack questions handed to the bot again", done);
  });
  await ctx.boss.work(slackInboundDeadLetter.name, async () => {
    ctx.log("slack question replay failed");
  });
  await ctx.boss.schedule(slackInboundQueue.name, "* * * * *");
  await ctx.boss.work<SlackReplyJob>(slackReplyQueue.name, { localConcurrency: 4 }, async ([job]) => {
    if (!job) return;
    const signal = AbortSignal.any([job.signal, ctx.drain]);
    try {
      const status = await deliverSlackReply({ ...deps, log: ctx.log }, slack, job.data, signal);
      ctx.log("slack reply", { runId: job.data.runId, status });
    } catch (error) {
      // Thrown, so pg-boss gives it to the next attempt: a hand-off at a shutdown, or a failure to try again.
      if (error instanceof SlackReplyHandOff) ctx.log("slack reply handed off", { runId: job.data.runId });
      throw error;
    }
  });
  // A file asked for from an answer's Download menu, posted in its thread.
  await ctx.boss.work<SlackFilesJob>(slackFilesQueue.name, { localConcurrency: 2 }, async ([job]) => {
    if (!job) return;
    const status = await deliverSlackFile({ ...deps, log: ctx.log }, bot, slack, job.data);
    ctx.log("slack file", { runId: job.data.runId, file: job.data.file.startsWith("csv:") ? "csv" : "pdf", status });
  });
  // The queue gave up on it: the person is told where the answer is, if the reply is still unfinished.
  await ctx.boss.work<SlackReplyJob>(slackReplyDeadLetter.name, async ([job]) => {
    if (!job) return;
    // Thrown, the dead letter's own retries tell them; the reply's attempt fence keeps it to one notice.
    const told = await abandonSlackReply({ ...deps, log: ctx.log }, slack, job.data);
    ctx.log("slack reply failed", { runId: job.data.runId, told });
  });
  ctx.log("slack ready", { events: setup.socket ? "socket" : "https" });
  return {
    // A learning decided: told privately in the Slack threads its corrections came from.
    tellLearning: (orgId: string, proposalId: string) => tellLearning(deps, slack, orgId, proposalId),
    // Slack's events stop coming in, and what they started finishes; the bot stays for replies still posting.
    stopListening: async () => {
      await socket?.stop().catch(() => {});
      await Promise.allSettled([...replays]);
    },
    stop: async () => {
      await socket?.stop().catch(() => {});
      await Promise.allSettled([...replays]);
      await bot.shutdown().catch(() => {});
      await close().catch(() => {});
    },
  };
}

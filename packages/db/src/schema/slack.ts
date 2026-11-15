import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { member, user } from "./auth";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { run, thread } from "./runs";
import { secret } from "./sources";

/**
 * A Slack workspace that added OpenDash, for one OpenDash workspace, by its owner or an admin with
 * Add to Slack. Its bot token is a secret (kind `oauth`), envelope-encrypted like a source's password. One Slack
 * workspace per OpenDash workspace, and the other way round. When Slack takes the app back (uninstalled there, or its
 * token revoked) the row stays, `removed_at` set and the token deleted, so Settings can say so.
 */
export const slackWorkspace = app
  .table(
    "slack_workspace",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      teamId: text("team_id").notNull(),
      teamName: text("team_name").notNull(),
      teamDomain: text("team_domain"),
      botUserId: text("bot_user_id").notNull(),
      /** The bot token's secret; null once Slack took the app back. */
      secretId: uuid("secret_id"),
      connectedBy: uuid("connected_by").references(() => user.id, { onDelete: "set null" }),
      connectedAt: timestamp("connected_at", { withTimezone: true }).notNull().defaultNow(),
      /** When Slack took the app back, and how: `uninstalled` there, or `tokens_revoked`. */
      removedAt: timestamp("removed_at", { withTimezone: true }),
      removedWhy: text("removed_why"),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.teamId] }),
      uniqueIndex("slack_workspace_team_uq").on(t.teamId),
      uniqueIndex("slack_workspace_org_uq").on(t.orgId),
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }),
      check(
        "slack_workspace_removed_check",
        sql`(${t.removedAt} is null and ${t.removedWhy} is null) or (${t.removedAt} is not null and ${t.removedWhy} in ('uninstalled', 'tokens_revoked') and ${t.secretId} is null)`,
      ),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A Slack account proven to belong to an OpenDash member (was slack_person): they confirmed a link signed in, with the Slack account's email their own. They ask as
 * that member while they are one: removing the member deletes this row, by its foreign key to the membership.
 */
export const slackIdentity = app
  .table(
    "slack_identity",
    {
      orgId: uuid("org_id").notNull(),
      teamId: text("team_id").notNull(),
      slackUserId: text("slack_user_id").notNull(),
      userId: uuid("user_id").notNull(),
      /** Their name in Slack when they linked: what Settings lists them as. */
      slackUserName: text("slack_user_name"),
      linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.teamId, t.slackUserId] }),
      /** One Slack account per person per workspace: linking again replaces it. */
      uniqueIndex("slack_identity_user_uq").on(t.orgId, t.userId),
      foreignKey({
        columns: [t.orgId, t.teamId],
        foreignColumns: [slackWorkspace.orgId, slackWorkspace.teamId],
      }).onDelete("cascade"),
      foreignKey({
        name: "slack_identity_member_fk",
        columns: [t.orgId, t.userId],
        foreignColumns: [member.organizationId, member.userId],
      }).onDelete("cascade"),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * An Add to Slack on its way: started by an owner or admin signed in, held when Slack comes back, connected
 * only when the same person, in the same browser, confirms it. Slack returns to OpenDash's public address (a tunnel
 * locally), where that browser's session isn't, so the callback can only hold what Slack gave: the bot token,
 * encrypted, and the team. The browser that started it keeps a secret (a cookie, its hash here); the one Slack sent
 * back gets a code (its hash here). Ten minutes; used once.
 */
export const slackInstall = app
  .table(
    "slack_install",
    {
      orgId: uuid("org_id").notNull(),
      id: uuid("id").notNull(),
      /**
       * Who started it, checked again when it's confirmed. No foreign key: a deleted user's cascade would leave the
       * held token behind; the row lives ten minutes and is purged with its token.
       */
      userId: uuid("user_id").notNull(),
      /** sha256 of the secret the starting browser keeps, hex. */
      browserHash: text("browser_hash").notNull(),
      /** `started` until Slack comes back, then `returned`, holding the token and team until it's confirmed. */
      status: text("status").notNull().default("started"),
      /** sha256 of the code the browser coming back from Slack carries, hex. */
      confirmHash: text("confirm_hash"),
      secretId: uuid("secret_id"),
      team: jsonb("team").$type<{ teamId: string; teamName: string; teamDomain: string | null; botUserId: string }>(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId], foreignColumns: [org.id] }).onDelete("cascade"),
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }),
      check("slack_install_status_check", sql`${t.status} in ('started', 'returned')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** A link sent privately to a Slack user to confirm their account: hashed, used once, 10 minutes. */
export const slackLink = app
  .table(
    "slack_link",
    {
      orgId: uuid("org_id").notNull(),
      id: uuid("id").notNull(),
      teamId: text("team_id").notNull(),
      slackUserId: text("slack_user_id").notNull(),
      /** Their name in Slack when the link was sent, so the page can say who's linking. */
      slackUserName: text("slack_user_name"),
      /**
       * Their Slack account's email (lowercase), when the link was sent: confirming needs it to be the signed-in
       * person's own, so a link forwarded to someone else can't tie their OpenDash account to this Slack account.
       */
      slackUserEmail: text("slack_user_email"),
      /** sha256 of the token, hex; the token is only in the link. */
      tokenHash: text("token_hash").notNull(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      usedAt: timestamp("used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      uniqueIndex("slack_link_token_uq").on(t.tokenHash),
      foreignKey({
        columns: [t.orgId, t.teamId],
        foreignColumns: [slackWorkspace.orgId, slackWorkspace.teamId],
      }).onDelete("cascade"),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * Which OpenDash conversation a person's questions in a Slack thread continue: one per Slack thread and person, so two
 * people asking in the same channel thread each ask with their own access.
 */
export const slackConversation = app
  .table(
    "slack_conversation",
    {
      orgId: uuid("org_id").notNull(),
      teamId: text("team_id").notNull(),
      /** Chat SDK's thread id (slack:<channel>:<thread ts>). */
      slackThreadId: text("slack_thread_id").notNull(),
      slackUserId: text("slack_user_id").notNull(),
      threadId: uuid("thread_id").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.teamId, t.slackThreadId, t.slackUserId] }),
      foreignKey({ columns: [t.orgId, t.threadId], foreignColumns: [thread.orgId, thread.id] }).onDelete("cascade"),
      foreignKey({
        columns: [t.orgId, t.teamId],
        foreignColumns: [slackWorkspace.orgId, slackWorkspace.teamId],
      }).onDelete("cascade"),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A run's reply in Slack, recorded once, so a retried reply job never posts twice: each attempt fenced by
 * its number, and each part of it recorded in `slack_reply_message`.
 */
export const slackReply = app
  .table(
    "slack_reply",
    {
      orgId: uuid("org_id").notNull(),
      runId: uuid("run_id").notNull(),
      teamId: text("team_id").notNull(),
      slackThreadId: text("slack_thread_id").notNull(),
      /** Who asked: Slack streams a reply in a channel to its asker. */
      slackUserId: text("slack_user_id").notNull(),
      /** The asker's message (its Slack ts), for the 👀 while it works and the ✅ once answered; null for a button. */
      slackMessageTs: text("slack_message_ts"),
      status: text("status").notNull().default("streaming"),
      /** The attempt replying now: each takes the next number, and writes only while it's still the latest. */
      attempt: integer("attempt").notNull().default(0),
      /** Real failures so far (a hand-off at a shutdown isn't one); the third gives up and says where the answer is. */
      failures: integer("failures").notNull().default(0),
      /** Why the last attempt failed, for the log: Slack's error code, never what was said. */
      error: text("error"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.runId] }),
      foreignKey({ columns: [t.orgId, t.runId], foreignColumns: [run.orgId, run.id] }).onDelete("cascade"),
      check("slack_reply_status_check", sql`${t.status} in ('streaming', 'done', 'failed')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A question from Slack, recorded before Slack hears it arrived: a message to the bot, or a press of one
 * of its buttons, keyed by Slack's own ids, so a retried or twin delivery is the same row and only its first is handled.
 * One never handled (the process stopped first) is handed to the bot again; after three tries the person is told it
 * was lost. What Slack sent is kept only until it's handled, and the row goes after a week.
 */
export const slackInbound = app
  .table(
    "slack_inbound",
    {
      orgId: uuid("org_id").notNull(),
      teamId: text("team_id").notNull(),
      /** `m:<channel>:<ts>` for a message (its twins, `message` and `app_mention`, alike), `a:<trigger_id>` a press. */
      key: text("key").notNull(),
      kind: text("kind").notNull(),
      /** Chat SDK's thread id and the person: where to say it was lost. */
      slackThreadId: text("slack_thread_id").notNull(),
      slackUserId: text("slack_user_id").notNull(),
      /** What Slack sent, as the bot's forwarded-event entry takes it; null once handled. */
      envelope: jsonb("envelope").$type<{ eventType: string; body: unknown }>(),
      /** `received` until a handler is done with it: `asked` (with its run), `handled` (no question), or `lost`. */
      status: text("status").notNull().default("received"),
      /** How many times it was handed to the bot again. */
      replays: integer("replays").notNull().default(0),
      /** When it may be handed to the bot again, if it's still `received` then. */
      nextAt: timestamp("next_at", { withTimezone: true }).notNull(),
      /** The run it asked. No foreign key: the row is gone in a week, and a run's deletion needn't wait on it. */
      runId: uuid("run_id"),
      receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
      handledAt: timestamp("handled_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.teamId, t.key] }),
      foreignKey({
        columns: [t.orgId, t.teamId],
        foreignColumns: [slackWorkspace.orgId, slackWorkspace.teamId],
      }).onDelete("cascade"),
      check("slack_inbound_kind_check", sql`${t.kind} in ('message', 'press')`),
      check("slack_inbound_status_check", sql`${t.status} in ('received', 'handled', 'asked', 'lost')`),
      index("slack_inbound_due_idx").on(t.nextAt).where(sql`${t.status} = 'received'`),
      index("slack_inbound_received_idx").on(t.receivedAt),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * Each part of a run's reply in Slack: the answer, its later messages, its questions, its files. A part
 * is recorded as `posting` before it's posted and `posted` with its message's ts after, so a resumed attempt posts
 * only what isn't there. One left `posting` (the attempt stopped in between) is looked for in the thread by the
 * metadata each posted part carries (its run and part) before it's posted again.
 */
export const slackReplyMessage = app
  .table(
    "slack_reply_message",
    {
      orgId: uuid("org_id").notNull(),
      runId: uuid("run_id").notNull(),
      /** `answer`, `answer:2`…, `questions`, `files`, `gave_up`. */
      part: text("part").notNull(),
      status: text("status").notNull().default("posting"),
      /** The message's ts in Slack, once posted. */
      ts: text("ts"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      postedAt: timestamp("posted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.runId, t.part] }),
      foreignKey({
        columns: [t.orgId, t.runId],
        foreignColumns: [slackReply.orgId, slackReply.runId],
      }).onDelete("cascade"),
      check("slack_reply_message_status_check", sql`${t.status} in ('posting', 'posted')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

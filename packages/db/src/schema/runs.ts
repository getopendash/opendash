import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { project } from "./projects";
import { connection } from "./sources";

/**
 * Threads and runs. The Postgres transcript is canonical: the agent
 * loop holds nothing between attempts, and every attempt rebuilds its messages from these rows. Approvals, projects
 * and channels beyond web, api and eval come with their epics.
 */

/** A conversation about one source. */
export const thread = app
  .table(
    "thread",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      /** The project it's in, if any; `visibility = project` needs one. */
      projectId: uuid("project_id"),
      /** A folder of its project; cleared when it moves out of the project. */
      folderId: uuid("folder_id"),
      createdBy: uuid("created_by"),
      title: text("title").notNull(),
      channel: text("channel").notNull().default("web"),
      visibility: text("visibility").notNull().default("private"),
      /** The last message seq handed out; the next message takes msg_seq + 1 in the same transaction. */
      msgSeq: integer("msg_seq").notNull().default(0),
      /** The last query alias handed out (q1, q2…): aliases are per conversation, so answers cite them across runs. */
      querySeq: integer("query_seq").notNull().default(0),
      lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      archivedAt: timestamp("archived_at", { withTimezone: true }),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }),
      check(
        "thread_channel_check",
        sql`${t.channel} in ('web', 'api', 'eval', 'slack', 'insight', 'routine', 'modeler', 'curator')`,
      ),
      check("thread_visibility_check", sql`${t.visibility} in ('private', 'project', 'org')`),
      check("thread_project_visibility_check", sql`${t.visibility} <> 'project' or ${t.projectId} is not null`),
      foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [project.orgId, project.id] }),
      // The folder key checks nothing when project_id is null: a folder needs its project.
      check("thread_folder_project_check", sql`${t.folderId} is null or ${t.projectId} is not null`),
      foreignKey({
        name: "thread_folder_fk",
        columns: [t.orgId, t.projectId, t.folderId],
        foreignColumns: [project.orgId, project.parentId, project.id],
      }),
      index("thread_created_by_idx").on(t.orgId, t.createdBy, t.createdAt),
      index("thread_project_idx").on(t.orgId, t.projectId),
      // The conversation search, through app.search_threads (trigram matching can't use an index under RLS).
      index("thread_title_trgm_idx").using("gin", t.orgId, sql`${t.title} gin_trgm_ops`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One turn of the transcript. `content` is the AI SDK ModelMessage verbatim (reasoning parts and provider signatures
 * included), so a rebuilt transcript is exactly what the model saw.
 */
export const message = app
  .table(
    "message",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      threadId: uuid("thread_id").notNull(),
      runId: uuid("run_id"),
      seq: integer("seq"),
      role: text("role").notNull(),
      kind: text("kind").notNull().default("normal"),
      authorId: uuid("author_id"),
      clientMsgId: text("client_msg_id"),
      content: jsonb("content").notNull(),
      /**
       * What the asker attached to a question: `[{ kind, id }]`, a dashboard, metric, guide
       * or verified query, checked when it was asked and again by every run that reads it.
       */
      attachments: jsonb("attachments").notNull().default(sql`'[]'::jsonb`),
      /** Plain text for display and search: the user's question, or the assistant's text parts. */
      text: text("text"),
      usage: jsonb("usage"),
      model: text("model"),
      /** A queued follow-up's provider (a kind) and thinking level, for the run it becomes. */
      provider: text("provider"),
      reasoning: text("reasoning"),
      stopReason: text("stop_reason"),
      status: text("status").notNull().default("complete"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.threadId], foreignColumns: [thread.orgId, thread.id] }).onDelete("cascade"),
      check("message_role_check", sql`${t.role} in ('user', 'assistant', 'tool_result', 'system_note')`),
      // `report`: a note from OpenDash that reports (work picked up when a run resumed), never a nudge to end.
      check("message_kind_check", sql`${t.kind} in ('normal', 'compaction', 'queued_input', 'report')`),
      check("message_status_check", sql`${t.status} in ('queued', 'complete', 'interrupted')`),
      uniqueIndex("message_seq_uq").on(t.orgId, t.threadId, t.seq),
      uniqueIndex("message_client_msg_uq")
        .on(t.orgId, t.threadId, t.clientMsgId)
        .where(sql`${t.clientMsgId} is not null`),
      index("message_run_idx").on(t.orgId, t.runId),
      // Questions and answers only: tool results hold previews of customer data and aren't searched.
      index("message_text_trgm_idx")
        .using("gin", t.orgId, sql`${t.text} gin_trgm_ops`)
        .where(sql`${t.role} in ('user', 'assistant') and ${t.kind} = 'normal' and ${t.text} is not null`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One agent run: a question answered (or asked back). Every write during a run is fenced by `attempt` and `status`
 *, so an attempt pg-boss has given up on can't write.
 */
export const run = app
  .table(
    "run",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      threadId: uuid("thread_id").notNull(),
      /**
       * The source this question started from: a follow-up can switch it. Null for runs made before
       * this column existed, which started from their thread's.
       */
      connectionId: uuid("connection_id"),
      parentRunId: uuid("parent_run_id"),
      /**
       * What a child run was given by its parent: a drafter's tables, `{ tables: [...] }` sorted. One child
       * per task, so a parent that asks again after a crash finds the one it started.
       */
      task: jsonb("task"),
      trigger: text("trigger").notNull().default("user"),
      inputMessageId: uuid("input_message_id"),
      profile: text("profile").notNull().default("analyst"),
      model: text("model").notNull(),
      /** The provider it runs on, by kind, and how long it thinks. */
      provider: text("provider").notNull().default("opendash"),
      reasoning: text("reasoning").notNull().default("high"),
      /** queued → running → succeeded | failed | cancelled (cancelling while a cancel is in progress) */
      status: text("status").notNull().default("queued"),
      attempt: integer("attempt").notNull().default(0),
      workerId: text("worker_id"),
      attemptStartedAt: timestamp("attempt_started_at", { withTimezone: true }),
      cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
      usage: jsonb("usage").notNull().default({}),
      /**
       * What a person's run may spend (its ceiling, or what the workspace's limits leave), set when it's prepared: what
       * it reserves against those limits while it runs, instead of its profile's cap.
       */
      holdUsd: numeric("hold_usd", { precision: 12, scale: 2 }),
      /**
       * What its latest attempt was sent: each prompt layer's hash in app.prompt_text, the tools offered by
       * name, and what the conversation layer held by id and version, its memories as a count only.
       */
      prompt: jsonb("prompt"),
      /** How each attempt ended, as it recorded its end: `[{ attempt, started, ended, reason }]`. A crash records none. */
      attempts: jsonb("attempts").notNull().default(sql`'[]'::jsonb`),
      lastEventSeq: integer("last_event_seq").notNull().default(0),
      /** What the run produced: the gated answer, the clarifying question, or why it couldn't answer. */
      outcome: jsonb("outcome"),
      /**
       * The asker may try a skill's draft (an owner or admin when they asked, from the caller): a draft they chose in
       * the conversation is given to this run only then, so it's checked again on every question.
       */
      canTryDrafts: boolean("can_try_drafts").notNull().default(false),
      /**
       * A learning's test: the unreleased term it's tested with, `{ itemId, version }`, given to this run
       * alone. Only OpenDash sets it, and only on a run it starts to test a proposal (trigger `proposal`).
       */
      candidate: jsonb("candidate"),
      error: text("error"),
      queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.threadId], foreignColumns: [thread.orgId, thread.id] }).onDelete("cascade"),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }),
      check(
        "run_trigger_check",
        sql`${t.trigger} in ('user', 'api', 'eval', 'slack', 'insight', 'routine', 'proposal')`,
      ),
      // A drafter is the Modeler's helper on a group of tables: a child run, parent_run_id set. The Curator
      // turns corrections into a proposed learning.
      check(
        "run_profile_check",
        sql`${t.profile} in ('analyst', 'investigator', 'modeler', 'drafter', 'curator', 'composer')`,
      ),
      check("run_candidate_check", sql`${t.candidate} is null or ${t.trigger} = 'proposal'`),
      check(
        "run_provider_check",
        sql`${t.provider} in ('opendash', 'gateway', 'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex')`,
      ),
      check("run_reasoning_check", sql`${t.reasoning} in ('low', 'medium', 'high', 'xhigh', 'max')`),
      check(
        "run_status_check",
        sql`${t.status} in ('queued', 'running', 'cancelling', 'succeeded', 'failed', 'cancelled')`,
      ),
      // One active run per thread, enforced by the database rather than the queue.
      uniqueIndex("run_active_uq")
        .on(t.orgId, t.threadId)
        .where(sql`${t.parentRunId} is null and ${t.status} in ('queued', 'running', 'cancelling')`),
      index("run_thread_idx").on(t.orgId, t.threadId, t.queuedAt),
      uniqueIndex("run_child_task_uq").on(t.orgId, t.parentRunId, t.task).where(sql`${t.parentRunId} is not null`),
      index("run_running_idx").on(t.attemptStartedAt).where(sql`${t.status} = 'running'`),
      // The conversation search: what a reader sees of each outcome (the answer as shown, the question asked back, the reason).
      index("run_outcome_text_trgm_idx")
        .using(
          "gin",
          t.orgId,
          sql`(coalesce(${t.outcome}->>'rendered', ${t.outcome}->>'question', ${t.outcome}->>'reason')) gin_trgm_ops`,
        )
        .where(sql`${t.parentRunId} is null and ${t.outcome} is not null`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * The prompt layers runs were sent, each stored once by its SHA-256: an agent layer, a source layer, a
 * question's own block. A member's memory is never stored here, nor anything attached to a conversation (it's rebuilt
 * from its ids and versions). Read by the trace, and to send an earlier question again as it was sent.
 */
export const promptText = app
  .table(
    "prompt_text",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      sha256: text("sha256").notNull(),
      text: text("text").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.sha256] }), ...tenantPolicies()],
  )
  .enableRLS();

/**
 * The tool-call ledger: one row per AI SDK toolCallId. A call delivered again (a retried attempt, a rebuilt
 * transcript) finds its row and gets the stored result instead of running twice.
 */
export const toolCall = app
  .table(
    "tool_call",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      runId: uuid("run_id").notNull(),
      messageId: uuid("message_id"),
      callId: text("call_id").notNull(),
      tool: text("tool").notNull(),
      args: jsonb("args").notNull(),
      effectClass: text("effect_class").notNull().default("read"),
      status: text("status").notNull().default("started"),
      attempt: integer("attempt").notNull(),
      result: jsonb("result"),
      queryRunId: uuid("query_run_id"),
      error: text("error"),
      startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.runId], foreignColumns: [run.orgId, run.id] }).onDelete("cascade"),
      check("tool_call_effect_class_check", sql`${t.effectClass} in ('read', 'compute', 'internal', 'external')`),
      check("tool_call_status_check", sql`${t.status} in ('started', 'succeeded', 'failed', 'cancelled', 'unknown')`),
      uniqueIndex("tool_call_call_uq").on(t.orgId, t.runId, t.callId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

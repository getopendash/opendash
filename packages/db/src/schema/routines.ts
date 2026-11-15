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
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";

/**
 * Routines: everything that runs on its own. When (on a schedule, or when something is found),
 * what (send a dashboard, with or without a written summary; ask a question; send what was found; tell what was
 * found) and where (people by email, Slack channels, or nobody: Insights only), written as one sentence. The spec is
 * core's to validate (routines/spec.ts); the table keeps what the engine looks up.
 */
export const routine = app
  .table(
    "routine",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      /** A workspace's own routine: `watching`, where one-tap Watch adds metrics. Null for the rest. */
      key: text("key"),
      /** Its name, for a routine that watches ("Growth alerts"); a scheduled one is named by its sentence. */
      name: text("name"),
      /** Who looks after it: who made it, or the data owner for the workspace's own. */
      ownerId: uuid("owner_id").notNull(),
      trigger: text("trigger").notNull(),
      /** When, what and how (routines/spec.ts), its version inside. */
      spec: jsonb("spec").notNull(),
      /** The people it emails (members only; each can unsubscribe). */
      userIds: uuid("user_ids").array().notNull().default(sql`'{}'::uuid[]`),
      /** The Slack channels it posts to: `{ teamId, channelId, name }`. */
      slack: jsonb("slack").notNull().default([]),
      /** A scheduled routine's next run, in UTC; null for one that runs when something is found. */
      nextRunAt: timestamp("next_run_at", { withTimezone: true }),
      status: text("status").notNull().default("active"),
      /** Why it paused itself (four failed runs in a row), for its owner. */
      pausedReason: text("paused_reason"),
      failureStreak: integer("failure_streak").notNull().default(0),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("routine_trigger_check", sql`${t.trigger} in ('schedule', 'found')`),
      check("routine_status_check", sql`${t.status} in ('active', 'paused')`),
      uniqueIndex("routine_key_uq").on(t.orgId, t.key).where(sql`${t.key} is not null and ${t.deletedAt} is null`),
      index("routine_due_idx")
        .on(t.nextRunAt)
        .where(sql`${t.status} = 'active' and ${t.deletedAt} is null and ${t.nextRunAt} is not null`),
      index("routine_users_idx").using("gin", t.userIds),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One run of a routine, unique per trigger: `at:<due time>` on its schedule, `manual:<time>` for Run now,
 * `found:<insight>` to tell a finding, `roundup:<local date>` for the day's findings. A run that waits (a roundup, or
 * an investigation first) is a row with `due_at`, never a sleeping job. queued → running (its job) → writing (an
 * agent's part) → sending (its outbox rows) → delivered, failed or skipped; its status follows its sends.
 */
export const routineRun = app
  .table(
    "routine_run",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      routineId: uuid("routine_id").notNull(),
      triggerKey: text("trigger_key").notNull(),
      status: text("status").notNull().default("queued"),
      /**
       * Which attempt of its job holds it, counted at each claim: a retry takes a running run over (pg-boss hands a job
       * out again only after giving up on the last attempt), and an earlier attempt's late writes change nothing.
       */
      attempt: integer("attempt").notNull().default(0),
      /** When a waiting run is due: the roundup's 07:00, or the latest an investigation may take. */
      dueAt: timestamp("due_at", { withTimezone: true }),
      /** The routine's spec as it was when the run was made. */
      specSnapshot: jsonb("spec_snapshot").notNull().default({}),
      /** The findings it tells. */
      insightIds: uuid("insight_ids").array().notNull().default(sql`'{}'::uuid[]`),
      /** The agent run that writes its summary or answers its question. */
      runId: uuid("run_id"),
      error: text("error"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check(
        "routine_run_status_check",
        sql`${t.status} in ('queued', 'running', 'writing', 'waiting', 'sending', 'delivered', 'failed', 'skipped')`,
      ),
      uniqueIndex("routine_run_trigger_uq").on(t.orgId, t.routineId, t.triggerKey),
      index("routine_run_list_idx").on(t.orgId, t.routineId, t.createdAt.desc()),
      index("routine_run_waiting_idx").on(t.dueAt).where(sql`${t.status} = 'waiting'`),
      index("routine_run_agent_idx").on(t.orgId, t.runId).where(sql`${t.runId} is not null`),
      foreignKey({ columns: [t.orgId, t.routineId], foreignColumns: [routine.orgId, routine.id] }).onDelete("cascade"),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

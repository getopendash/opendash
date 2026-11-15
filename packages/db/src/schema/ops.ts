import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { systemRole } from "./roles";

/**
 * Observability v0: something that needs a person's attention, raised by
 * the dispatcher or a dead-letter handler. One open alert per kind and subject (its count and last-seen grow while it
 * holds); resolved when the condition clears. An alert about an organization carries its id and is that
 * organization's to read; one with none is the deployment's, and no tenant ever reads it (the tenant policy).
 */
export const opsAlert = app
  .table(
    "ops_alert",
    {
      id: uuid("id").notNull().primaryKey(),
      orgId: uuid("org_id").references(() => org.id, { onDelete: "cascade" }),
      /** stuck_run, lost_job, dead_letter, partitions_missing, spend (near a spend limit). */
      kind: text("kind").notNull(),
      /** What it's about: a run's id, a queue's name. */
      subject: text("subject").notNull(),
      /** For people: what happened and what to do; never secrets, query text or values. */
      message: text("message").notNull(),
      detail: jsonb("detail").notNull().default({}),
      count: integer("count").notNull().default(1),
      firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
      resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    },
    (t) => [
      check(
        "ops_alert_kind_check",
        sql`${t.kind} in ('stuck_run', 'lost_job', 'dead_letter', 'partitions_missing', 'spend')`,
      ),
      // One open alert per kind and subject, for an organization or the deployment.
      uniqueIndex("ops_alert_open_uq")
        .on(sql`coalesce(${t.orgId}, '00000000-0000-0000-0000-000000000000'::uuid)`, t.kind, t.subject)
        .where(sql`${t.resolvedAt} is null`),
      index("ops_alert_org_idx").on(t.orgId, t.lastSeenAt),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** When the dispatcher last ran, and what it found: the system's alone (`app.last_tick()` reads the time for others). */
export const opsTick = app
  .table(
    "ops_tick",
    {
      name: text("name").notNull().primaryKey(),
      at: timestamp("at", { withTimezone: true }).notNull(),
      result: jsonb("result").notNull().default({}),
    },
    () => [
      pgPolicy("system", { as: "permissive", for: "all", to: systemRole, using: sql`true`, withCheck: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * An organization that was deleted, written by a trigger on app.org as its row goes (so no deletion happens without
 * one), and the system's alone. Its foreign keys took everything they reach in that statement; the rows no foreign
 * key reaches (run_event, query_run, usage_event, audit_log, the audit chain, its queued jobs) are purged by the
 * worker from here, which then sets `purged_at`. Kept afterwards as the record that the deletion finished: an id and
 * two times, nothing of the organization's or of a person.
 */
export const orgDeletion = app
  .table(
    "org_deletion",
    {
      orgId: uuid("org_id").notNull().primaryKey(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }).notNull().defaultNow(),
      purgedAt: timestamp("purged_at", { withTimezone: true }),
    },
    (t) => [
      index("org_deletion_unpurged_idx").on(t.deletedAt).where(sql`${t.purgedAt} is null`),
      pgPolicy("system", { as: "permissive", for: "all", to: systemRole, using: sql`true`, withCheck: sql`true` }),
    ],
  )
  .enableRLS();

/**
 * Usage by day, rolled up from usage_event for the last 2 days, idempotently, so it outlives the events' 13
 * months. By organization, day (UTC), kind, model and whose key paid.
 */
export const usageDaily = app
  .table(
    "usage_daily",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      day: date("day").notNull(),
      kind: text("kind").notNull(),
      model: text("model").notNull(),
      keySource: text("key_source").notNull(),
      /** Events (model calls, for llm_tokens). */
      events: integer("events").notNull(),
      qty: bigint("qty", { mode: "number" }).notNull(),
      costUsd: numeric("cost_usd", { precision: 14, scale: 6 }).notNull(),
      /** Events without a price: while there are any, the cost is a lower bound. */
      unpriced: integer("unpriced").notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.day, t.kind, t.model, t.keySource] }), ...tenantPolicies()],
  )
  .enableRLS();

/**
 * Spend limits v0: what an organization lets AI spend on questions, a
 * calendar month and a day (UTC), counted from usage_event's priced calls on any key. Null is no limit; no row is none
 * at all. Background work (the Investigator, routines) has a budget of its
 * own, a month's, $10 unless an owner sets another (no row is $10 too); 0 turns it off.
 */
export const spendLimit = app
  .table(
    "spend_limit",
    {
      orgId: uuid("org_id")
        .notNull()
        .primaryKey()
        .references(() => org.id, { onDelete: "cascade" }),
      monthlyUsd: numeric("monthly_usd", { precision: 12, scale: 2 }),
      dailyUsd: numeric("daily_usd", { precision: 12, scale: 2 }),
      backgroundMonthlyUsd: numeric("background_monthly_usd", { precision: 12, scale: 2 }).notNull().default("10"),
      /**
       * Where a person's run in OpenDash pauses and asks to go on (a setting, not a cap); null:
       * it doesn't pause (the monthly and daily limits still hold). A workspace with no row has the default.
       */
      runCeilingUsd: numeric("run_ceiling_usd", { precision: 12, scale: 2 }).default("1.5"),
      updatedBy: uuid("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      check("spend_limit_monthly_check", sql`${t.monthlyUsd} is null or ${t.monthlyUsd} > 0`),
      check("spend_limit_daily_check", sql`${t.dailyUsd} is null or ${t.dailyUsd} > 0`),
      check("spend_limit_background_check", sql`${t.backgroundMonthlyUsd} >= 0`),
      check("spend_limit_run_ceiling_check", sql`${t.runCeilingUsd} is null or ${t.runCeilingUsd} > 0`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

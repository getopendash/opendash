import { sql } from "drizzle-orm";
import {
  boolean,
  check,
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
 * The effect outbox: every side effect OpenDash sends, written before it's sent. Its idempotency
 * key (what it's for + channel + recipient) is unique, so a retried job never sends twice; the interrupt index is the
 * push budget's, for when pushes come. Routines' runs write theirs: an email per person, a post per Slack channel.
 */
export const effect = app
  .table(
    "effect",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      purpose: text("purpose").notNull(),
      sourceType: text("source_type").notNull(),
      sourceId: uuid("source_id"),
      channel: text("channel").notNull(),
      integrationId: uuid("integration_id"),
      /** Who it's for: `user:<id>` for a person, `slack:<team>:<channel>` for a channel. */
      recipientKey: text("recipient_key").notNull(),
      payload: jsonb("payload").notNull().default({}),
      interrupt: boolean("interrupt").notNull().default(false),
      tier: text("tier"),
      idempotencyKey: text("idempotency_key").notNull(),
      approvalId: uuid("approval_id"),
      status: text("status").notNull().default("queued"),
      attempt: integer("attempt").notNull().default(0),
      /** The provider's id for what it sent (Resend's email id). */
      providerRef: text("provider_ref"),
      /** What happened: why it was suppressed, or the error. Never the message itself. */
      receipt: jsonb("receipt").notNull().default({}),
      sentAt: timestamp("sent_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("effect_purpose_check", sql`${t.purpose} in ('notify', 'action')`),
      check("effect_source_check", sql`${t.sourceType} in ('insight', 'routine_run', 'approval', 'todo', 'tool_call')`),
      check(
        "effect_channel_check",
        sql`${t.channel} in ('slack', 'teams', 'email', 'webhook', 'in_app', 'linear', 'jira', 'mcp')`,
      ),
      check(
        "effect_status_check",
        sql`${t.status} in ('queued', 'sending', 'sent', 'failed', 'suppressed', 'unknown')`,
      ),
      uniqueIndex("effect_idempotency_uq").on(t.orgId, t.idempotencyKey),
      index("effect_interrupt_idx").on(t.orgId, t.recipientKey, t.sentAt).where(sql`${t.interrupt}`),
      // A routine run's sends, read each time one settles (settleRun).
      index("effect_routine_run_idx").on(t.orgId, t.sourceId).where(sql`${t.sourceType} = 'routine_run'`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

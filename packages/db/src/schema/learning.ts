import { sql } from "drizzle-orm";
import { check, index, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";

/**
 * Feedback (explicit signals): what someone said about an answer or
 * one of its numbers. One row per person per target (and claim), changed in place when they change their mind. The
 * Curator that routes feedback into proposals comes later; until then admins read it (Knowledge → Feedback) and on
 * the definitions the answer used. v0 targets: `run` (an answer) and `query_run` (a number, with `claim_key` the
 * reference, q2:0:mrr).
 */
export const feedback = app
  .table(
    "feedback",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      targetType: text("target_type").notNull(),
      targetId: uuid("target_id").notNull(),
      /** For a number: the reference it was shown from. Empty for a whole answer. */
      claimKey: text("claim_key").notNull().default(""),
      /** The run whose answer it's about (for a number too), so it can be read in its conversation. */
      runId: uuid("run_id"),
      userId: uuid("user_id"),
      kind: text("kind").notNull(),
      reasonCode: text("reason_code"),
      comment: text("comment"),
      /** A correction: the value or definition the person says is right. */
      correction: jsonb("correction"),
      status: text("status").notNull().default("new"),
      route: text("route"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check(
        "feedback_target_check",
        sql`${t.targetType} in ('run', 'message', 'insight', 'todo', 'query_run', 'context_item', 'decision')`,
      ),
      check(
        "feedback_kind_check",
        sql`${t.kind} in ('up', 'down', 'wrong_number', 'wrong_definition', 'missing_context', 'correction', 'dismiss', 'edit')`,
      ),
      check("feedback_status_check", sql`${t.status} in ('new', 'routed', 'ignored')`),
      check(
        "feedback_route_check",
        sql`${t.route} is null or ${t.route} in ('personal', 'proposal', 'verified_candidate', 'eval_case', 'routine', 'discard')`,
      ),
      uniqueIndex("feedback_one_per_target_uq").on(t.orgId, t.userId, t.targetType, t.targetId, t.claimKey),
      index("feedback_status_idx").on(t.orgId, t.status, t.createdAt),
      index("feedback_run_idx").on(t.orgId, t.runId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A proposal (shape, the parts the Modeler's Make this a metric uses): definitions the Modeler drafted from one query, for an owner or admin to approve, edit or
 * reject. Its run's state first (drafting, held when background work's budget is spent, failed), then its review's
 * (open, approved, rejected with the reviewer's note, superseded by a newer draft of the same query). `items` are the
 * context items it drafted (each version's `proposal_id` points back here); `from` is the query it came from (an
 * answer's query run, and the dashboard tile when it was asked from one); `evidence` what its tests and its
 * comparison with the tile found.
 */
export const proposal = app
  .table(
    "proposal",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      kind: text("kind").notNull().default("create"),
      source: text("source").notNull().default("modeler"),
      status: text("status").notNull().default("drafting"),
      runId: uuid("run_id"),
      /** Who pressed Make this a metric. */
      requestedBy: uuid("requested_by"),
      /** The answer's query run it was drafted from. */
      fromQueryRunId: uuid("from_query_run_id"),
      /**
       * The Curator's: the topic its corrections are about ("term:paying account"), so a new one about it
       * joins the live proposal instead of starting another.
       */
      dedupeKey: text("dedupe_key"),
      /** The tables and views picked to draft from (Draft definitions on a source); empty for a draft from a query. */
      tables: text("tables").array().notNull().default(sql`'{}'::text[]`),
      title: text("title").notNull(),
      rationale: text("rationale"),
      evidence: jsonb("evidence").notNull().default({}),
      items: uuid("items").array().notNull().default(sql`'{}'::uuid[]`),
      heldReason: text("held_reason"),
      reviewerId: uuid("reviewer_id"),
      note: text("note"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      decidedAt: timestamp("decided_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("proposal_kind_check", sql`${t.kind} in ('create', 'update')`),
      check("proposal_source_check", sql`${t.source} in ('modeler', 'curator')`),
      // A learning is also evaluating (its check and test running), discarded (the Curator found nothing to
      // learn, with why) or reverted (released, then taken back).
      check(
        "proposal_status_check",
        sql`${t.status} in ('drafting', 'held', 'failed', 'evaluating', 'open', 'approved', 'rejected', 'superseded', 'discarded', 'reverted')`,
      ),
      // One live learning per topic.
      uniqueIndex("proposal_topic_live_uq")
        .on(t.orgId, t.dedupeKey)
        .where(sql`${t.source} = 'curator' and ${t.status} in ('drafting', 'held', 'evaluating', 'open')`),
      // One draft under way or in review per query: asking again shows the one there is.
      uniqueIndex("proposal_query_live_uq")
        .on(t.orgId, t.fromQueryRunId)
        .where(sql`${t.status} in ('drafting', 'open')`),
      // One draft run under way per source: its drafts can wait in review while the next tables are drafted.
      uniqueIndex("proposal_source_live_uq")
        .on(t.orgId, t.connectionId)
        .where(sql`${t.source} = 'modeler' and ${t.fromQueryRunId} is null and ${t.status} = 'drafting'`),
      // One batch held per source: automatic drafting waits there for the budget, and resumes it.
      uniqueIndex("proposal_source_held_uq")
        .on(t.orgId, t.connectionId)
        .where(sql`${t.source} = 'modeler' and ${t.fromQueryRunId} is null and ${t.status} = 'held'`),
      index("proposal_review_idx").on(t.orgId, t.status, t.createdAt.desc()),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

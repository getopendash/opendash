import { sql } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";

/**
 * A metric's checks: the engine's record of a watched metric, read and judged once per week or
 * month however many routines watch it. Nobody makes one: there's one for each metric and grain some active routine
 * watches, and it's soft-deleted when none does (its observations and the insights it found stay traceable).
 * Detection is deterministic: the metric's series against its own recent changes.
 */
export const metricCheck = app
  .table(
    "metric_check",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      metricId: uuid("metric_id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      /** The period it reads: week where the metric has one, month otherwise (trends and goal risk read months). */
      grain: text("grain").notNull(),
      /** When it next reads: 06:00 where the workspace is, once its period has closed; daily while data is late. */
      nextCheckAt: timestamp("next_check_at", { withTimezone: true }).notNull(),
      /** Its last check: when, how it went, the period it judged, and why it couldn't run. */
      state: jsonb("state").notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("metric_check_grain_check", sql`${t.grain} in ('week', 'month')`),
      uniqueIndex("metric_check_uq").on(t.orgId, t.metricId, t.grain).where(sql`${t.deletedAt} is null`),
      index("metric_check_due_idx").on(t.nextCheckAt).where(sql`${t.deletedAt} is null`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One period of a checked metric as judged: its value (a query-run cell), the usual range it was expected in at the
 * default sensitivity, and the range's width per unit of sensitivity (`spread`), so each routine can judge the same
 * read at its own.
 */
export const observation = app
  .table(
    "observation",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      checkId: uuid("check_id").notNull(),
      periodStart: date("period_start").notNull(),
      value: doublePrecision("value").notNull(),
      /** The usual range's centre and its edges at the default sensitivity; null while too few periods precede it. */
      expected: doublePrecision("expected"),
      expectedLo: doublePrecision("expected_lo"),
      expectedHi: doublePrecision("expected_hi"),
      /** Half the range's width at a sensitivity of 1 (in the metric's units); null without a range. */
      spread: doublePrecision("spread"),
      score: doublePrecision("score"),
      queryRunId: uuid("query_run_id"),
      /** The value's row in that run. */
      row: integer("row").notNull(),
      observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [primaryKey({ columns: [t.orgId, t.checkId, t.periodStart] }), ...tenantPolicies()],
  )
  .enableRLS();

/**
 * What a check found (insights): a period outside its usual range, a shift in a trend, a line crossed, a goal
 * at risk, or a source whose period hasn't landed (data_quality, one per source, holding back its metrics' other
 * findings). Open while new or seen; one open insight per dedupe key, so finding it again adds an occurrence. Filed
 * once, however many routines watch the metric; each routine then tells its own people. Its figures are claims on
 * query-run cells, never text.
 */
export const insight = app
  .table(
    "insight",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      /** The check that found it. */
      checkId: uuid("check_id"),
      connectionId: uuid("connection_id").notNull(),
      kind: text("kind").notNull(),
      metricId: uuid("metric_id"),
      direction: text("direction"),
      period: date("period").notNull(),
      /** Words only: every figure is in `claims`. */
      title: text("title").notNull(),
      summary: text("summary").notNull(),
      severity: smallint("severity").notNull(),
      score: doublePrecision("score"),
      dedupeKey: text("dedupe_key").notNull(),
      /**
       * Null: the workspace's. Set: only that person's, found for a routine that tells only them (a line they drew, or
       * a sensitivity no shared routine has); read through core, which shows it to them alone.
       */
      ownerId: uuid("owner_id"),
      status: text("status").notNull().default("new"),
      dismissReason: text("dismiss_reason"),
      statusBy: uuid("status_by"),
      statusAt: timestamp("status_at", { withTimezone: true }),
      /** The figures: the value (a query-run cell) and what it's judged against (derived, and said to be). */
      claims: jsonb("claims").notNull().default({}),
      queryRunIds: uuid("query_run_ids").array().notNull().default(sql`'{}'::uuid[]`),
      firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
      lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
      occurrences: integer("occurrences").notNull().default(1),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("insight_kind_check", sql`${t.kind} in ('anomaly', 'trend', 'threshold', 'goal_risk', 'data_quality')`),
      check("insight_status_check", sql`${t.status} in ('new', 'seen', 'dismissed', 'resolved')`),
      check(
        "insight_dismiss_check",
        sql`${t.dismissReason} is null or ${t.dismissReason} in ('not_a_problem', 'known_issue', 'wrong_data', 'not_my_area')`,
      ),
      uniqueIndex("insight_open_uq").on(t.orgId, t.dedupeKey).where(sql`${t.status} in ('new', 'seen')`),
      index("insight_feed_idx").on(t.orgId, t.status, t.lastSeenAt.desc()),
      index("insight_owner_idx").on(t.orgId, t.ownerId).where(sql`${t.ownerId} is not null`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * An insight's investigation: one per insight, the
 * background run that rechecks it another way and writes up why, in a thread of its own (channel `insight`, nobody's
 * conversation; its query cells readable by the organization, like the check's). It runs when someone presses
 * Investigate, or when a routine that tells people investigates first. `held` when background work's
 * budget was spent (or off) as it would have started, with the reason the card shows.
 */
export const investigation = app
  .table(
    "investigation",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      insightId: uuid("insight_id").notNull(),
      runId: uuid("run_id"),
      status: text("status").notNull().default("queued"),
      heldReason: text("held_reason"),
      /** Who pressed Investigate; null when a routine asked for it. */
      requestedBy: uuid("requested_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      uniqueIndex("investigation_insight_uq").on(t.orgId, t.insightId),
      foreignKey({ columns: [t.orgId, t.insightId], foreignColumns: [insight.orgId, insight.id] }).onDelete("cascade"),
      check(
        "investigation_status_check",
        sql`${t.status} in ('queued', 'running', 'confirmed', 'not_confirmed', 'failed', 'held')`,
      ),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

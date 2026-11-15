import { sql } from "drizzle-orm";
import {
  check,
  date,
  doublePrecision,
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
 * Tasks v0 (what the team decided to do about an
 * insight ("Task" in the UI). Done, it's checked over the whole months after it against what its metric would have
 * done on its trend (an outcome).
 */
export const todo = app
  .table(
    "todo",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      insightId: uuid("insight_id"),
      metricId: uuid("metric_id"),
      connectionId: uuid("connection_id"),
      title: text("title").notNull(),
      /** The insight it came from, as it read then: its id, title and value (a query-run cell). */
      whyNow: jsonb("why_now").notNull().default({}),
      /** `{ direction, horizonMonths }`: which way it should move the metric, judged over how many whole months. */
      expectedImpact: jsonb("expected_impact").notNull().default({}),
      ownerId: uuid("owner_id"),
      createdBy: uuid("created_by"),
      steps: jsonb("steps").notNull().default([]),
      status: text("status").notNull().default("accepted"),
      dueAt: date("due_at"),
      doneAt: timestamp("done_at", { withTimezone: true }),
      /** When its outcome is checked: the morning after the horizon's last month closes. */
      checkAt: timestamp("check_at", { withTimezone: true }),
      /** What the check judges (tasks/outcome.ts OutcomeSpec, with the metric). */
      checkSpec: jsonb("check_spec"),
      /** How many checks it has had (v0: one). */
      checkNo: integer("check_no").notNull().default(0),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check(
        "todo_status_check",
        sql`${t.status} in ('proposed', 'accepted', 'in_progress', 'done', 'dismissed', 'expired')`,
      ),
      index("todo_check_idx").on(t.checkAt).where(sql`${t.checkAt} is not null and ${t.status} = 'done'`),
      index("todo_list_idx").on(t.orgId, t.status, t.updatedAt.desc()),
      index("todo_insight_idx").on(t.orgId, t.insightId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** A done task's check: its metric's last horizon month against the projection from its trend, and the verdict. */
export const outcome = app
  .table(
    "outcome",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      todoId: uuid("todo_id").notNull(),
      checkNo: integer("check_no").notNull(),
      baseline: doublePrecision("baseline"),
      observed: doublePrecision("observed"),
      /** How the projection was made, its value, the cells read, and why it's inconclusive when it is. */
      counterfactual: jsonb("counterfactual").notNull().default({}),
      delta: doublePrecision("delta"),
      queryRunIds: uuid("query_run_ids").array().notNull().default(sql`'{}'::uuid[]`),
      verdict: text("verdict").notNull(),
      note: text("note"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("outcome_verdict_check", sql`${t.verdict} in ('improved', 'no_change', 'worsened', 'inconclusive')`),
      uniqueIndex("outcome_todo_uq").on(t.orgId, t.todoId, t.checkNo),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

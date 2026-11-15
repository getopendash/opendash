import { sql } from "drizzle-orm";
import {
  boolean,
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
 * The organization's evals (eval tables): its suite, the cases in it,
 * each run of it, and each case's result in a run. A case's expected answer is a reference spec recomputed at eval
 * time, never a stored number, because the customer's data changes.
 */
export const evalSuite = app
  .table(
    "eval_suite",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      name: text("name").notNull(),
      scope: text("scope").notNull().default("org"),
      /** What a run must reach to pass (the eval gate's thresholds). */
      gate: jsonb("gate").notNull().default({}),
      ownerId: uuid("owner_id"),
      /** A run every night (03:00 UTC). Off until an admin turns it on: a run costs model calls. */
      nightly: boolean("nightly").notNull().default(false),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("eval_suite_scope_check", sql`${t.scope} in ('global', 'org')`),
      // One suite of the organization's own.
      uniqueIndex("eval_suite_org_uq").on(t.orgId).where(sql`${t.scope} = 'org'`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

export const evalCase = app
  .table(
    "eval_case",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      suiteId: uuid("suite_id").notNull(),
      /** The source its reference runs against (a reference runs on a source). */
      connectionId: uuid("connection_id").notNull(),
      question: text("question").notNull(),
      phrasings: jsonb("phrasings").notNull().default([]),
      /** Of the source and the normalized question: the same question on another source is another case. */
      questionHash: text("question_hash").notNull(),
      /** Asked as of this time (a verified query's spec has the dates it ran with); null: as of the run. */
      asOf: timestamp("as_of", { withTimezone: true }),
      persona: text("persona"),
      /** A metric query (packages/core's MetricQuery), compiled and run at eval time. */
      referenceSpec: jsonb("reference_spec"),
      referenceSql: text("reference_sql"),
      /**
       * A structural case, graded on what the answer's queries read instead of its numbers:
       * `{ reads: [schema.table], compared?: { column, values }, not: [schema.table], term? }`.
       */
      expect: jsonb("expect"),
      compare: jsonb("compare").notNull().default({}),
      expectClarification: boolean("expect_clarification").notNull().default(false),
      expectRefusal: boolean("expect_refusal").notNull().default(false),
      category: text("category"),
      split: text("split").notNull().default("dev"),
      origin: text("origin").notNull(),
      /** What it was made from: a verified metric's or a verified query's item id. */
      originRef: uuid("origin_ref"),
      /** False once what it was made from is gone; its results stay. */
      active: boolean("active").notNull().default(true),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.suiteId], foreignColumns: [evalSuite.orgId, evalSuite.id] }).onDelete(
        "cascade",
      ),
      check("eval_case_split_check", sql`${t.split} in ('dev', 'holdout')`),
      check("eval_case_origin_check", sql`${t.origin} in ('benchmark', 'onboarding', 'correction', 'admin')`),
      check(
        "eval_case_reference_check",
        sql`${t.referenceSpec} is not null or ${t.referenceSql} is not null or ${t.expect} is not null`,
      ),
      uniqueIndex("eval_case_question_uq").on(t.orgId, t.suiteId, t.questionHash),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

export const evalRun = app
  .table(
    "eval_run",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      suiteId: uuid("suite_id").notNull(),
      contextReleaseId: uuid("context_release_id"),
      candidateReleaseId: uuid("candidate_release_id"),
      baselineRunId: uuid("baseline_run_id"),
      model: text("model").notNull(),
      /** The provider its cases run on (a kind) and how long they think: the workspace's default when it started. */
      provider: text("provider").notNull().default("opendash"),
      reasoning: text("reasoning").notNull().default("high"),
      trigger: text("trigger").notNull(),
      status: text("status").notNull().default("queued"),
      /** The cases it checks (fixed when it starts), and what it found: totals, untraced, model calls, cost. */
      caseIds: jsonb("case_ids").notNull().default([]),
      metrics: jsonb("metrics").notNull().default({}),
      requestedBy: uuid("requested_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.suiteId], foreignColumns: [evalSuite.orgId, evalSuite.id] }).onDelete(
        "cascade",
      ),
      check("eval_run_trigger_check", sql`${t.trigger} in ('proposal', 'release', 'schedule', 'manual', 'ci')`),
      check("eval_run_status_check", sql`${t.status} in ('queued', 'running', 'done', 'failed')`),
      // One run at a time per suite: a second Run now while one is going would only cost twice.
      uniqueIndex("eval_run_active_uq").on(t.orgId, t.suiteId).where(sql`${t.status} in ('queued', 'running')`),
      index("eval_run_suite_idx").on(t.orgId, t.suiteId, t.createdAt.desc()),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

export const evalResult = app
  .table(
    "eval_result",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      evalRunId: uuid("eval_run_id").notNull(),
      caseId: uuid("case_id").notNull(),
      attempt: integer("attempt").notNull().default(1),
      phrasingIdx: integer("phrasing_idx").notNull().default(0),
      /** The analyst's run that answered it, and the query runs behind the answer and the reference. */
      runId: uuid("run_id"),
      agentQrId: uuid("agent_qr_id"),
      referenceQrId: uuid("reference_qr_id"),
      verdict: text("verdict").notNull(),
      /** Why, and what the page shows: expected and cited numbers, the answer, its path, untraced, cost. */
      diff: jsonb("diff").notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.evalRunId, t.caseId, t.attempt, t.phrasingIdx] }),
      foreignKey({ columns: [t.orgId, t.evalRunId], foreignColumns: [evalRun.orgId, evalRun.id] }).onDelete("cascade"),
      foreignKey({ columns: [t.orgId, t.caseId], foreignColumns: [evalCase.orgId, evalCase.id] }).onDelete("cascade"),
      check("eval_result_verdict_check", sql`${t.verdict} in ('pass', 'fail', 'error', 'clarified_ok', 'refused_ok')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { connection } from "./sources";

/**
 * Learning a source: one run of reading the schema, profiling and indexing values. The worker writes each step
 * as it goes, in the same shape as connection_test.checks, and the page polls it.
 */
export const syncRun = app
  .table(
    "sync_run",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      /** queued → running → succeeded | failed */
      status: text("status").notNull().default("queued"),
      /**
       * Which delivery of its jobs is writing it: each claim counts one, and a write of an older one (an attempt that
       * stalled and was retried) changes nothing.
       */
      attempt: integer("attempt").notNull().default(0),
      steps: jsonb("steps").notNull().default([]),
      facts: jsonb("facts").notNull().default({}),
      message: text("message"),
      requestedBy: uuid("requested_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }).onDelete(
        "cascade",
      ),
      check("sync_run_status_check", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
      index("sync_run_connection_idx").on(t.orgId, t.connectionId, t.createdAt),
      // One learning run per source at a time, enforced here rather than by the queue.
      uniqueIndex("sync_run_active_uq").on(t.orgId, t.connectionId).where(sql`${t.status} in ('queued', 'running')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * What the schema looked like at one sync. The full JSON is inline until
 * object storage exists; the diff against the previous snapshot is what drift detection reads.
 */
export const schemaSnapshot = app
  .table(
    "schema_snapshot",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      syncRunId: uuid("sync_run_id"),
      contentHash: text("content_hash").notNull(),
      snapshot: jsonb("snapshot").notNull(),
      diff: jsonb("diff").notNull().default({}),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }).onDelete(
        "cascade",
      ),
      index("schema_snapshot_connection_idx").on(t.orgId, t.connectionId, t.id),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * Schemas, tables, views and columns as observed in a source, with their profile. Rows are kept when an object
 * disappears (removed_at), so definitions that used it can be flagged instead of silently breaking.
 */
export const catalogObject = app
  .table(
    "catalog_object",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      parentId: uuid("parent_id"),
      kind: text("kind").notNull(),
      /** schema, schema.table, schema.table.column */
      fqName: text("fq_name").notNull(),
      name: text("name").notNull(),
      dataType: text("data_type"),
      nullable: boolean("nullable"),
      comment: text("comment"),
      /** rows, ndv, null_frac, detected roles, joins, freshness: stats, never a column's values. */
      profile: jsonb("profile").notNull().default({}),
      sensitivity: text("sensitivity").notNull().default("none"),
      /** Set when an admin overrode the detected sensitivity; later syncs then keep the admin's choice. */
      sensitivitySetBy: uuid("sensitivity_set_by"),
      usageScore: real("usage_score").notNull().default(0),
      /** A table or view its admin picked for OpenDash to learn: profiled on every sync, drafted. */
      learn: boolean("learn").notNull().default(false),
      /**
       * How a table or view is built, from the schema read, for every table known: its engine and keys, and
       * a view's definition (literals and comments removed) and the tables it reads. Never data.
       */
      schemaInfo: jsonb("schema_info").notNull().default({}),
      firstSeenSnapshot: uuid("first_seen_snapshot"),
      lastSeenSnapshot: uuid("last_seen_snapshot"),
      removedAt: timestamp("removed_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }).onDelete(
        "cascade",
      ),
      foreignKey({ columns: [t.orgId, t.parentId], foreignColumns: [t.orgId, t.id] }).onDelete("cascade"),
      check("catalog_object_kind_check", sql`${t.kind} in ('schema', 'table', 'view', 'column')`),
      check("catalog_object_sensitivity_check", sql`${t.sensitivity} in ('none', 'pii', 'secret')`),
      uniqueIndex("catalog_object_fq_name_uq").on(t.orgId, t.connectionId, t.fqName),
      index("catalog_object_parent_idx").on(t.orgId, t.parentId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * Query history v0: the team's most-run reads of a source, from the
 * history its database keeps, normalized (no literal values), replaced at each mining. `tables` are the catalog's
 * `schema.table` names it read. Admins and the analyst read the text; people see counts.
 */
export const queryPattern = app
  .table(
    "query_pattern",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      connectionId: uuid("connection_id").notNull(),
      fingerprint: text("fingerprint").notNull(),
      sql: text("sql").notNull(),
      calls: bigint("calls", { mode: "number" }).notNull(),
      totalMs: bigint("total_ms", { mode: "number" }).notNull(),
      tables: jsonb("tables").notNull().default([]),
      minedAt: timestamp("mined_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.connectionId, t.fingerprint] }),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }).onDelete(
        "cascade",
      ),
      index("query_pattern_tables_idx").using("gin", t.tables),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

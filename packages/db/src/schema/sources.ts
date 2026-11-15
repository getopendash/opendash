import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  foreignKey,
  index,
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

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const DIALECTS = sql`('postgres', 'mysql', 'clickhouse', 'snowflake', 'bigquery', 'databricks', 'redshift', 'mssql', 'duckdb', 'motherduck', 'trino', 'lake')`;

/**
 * Encrypted secrets. AES-256-GCM under the org's DEK with
 * AAD = org_id|id|kind|key_version, so a ciphertext moved to another row, org or key version fails to decrypt.
 * Never returned to clients and never put in prompts.
 */
export const secret = app
  .table(
    "secret",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      kind: text("kind").notNull(),
      keyVersion: smallint("key_version").notNull(),
      nonce: bytea("nonce").notNull(),
      ciphertext: bytea("ciphertext").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      rotatedAt: timestamp("rotated_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("secret_kind_check", sql`${t.kind} in ('connection', 'oauth', 'llm_key', 'webhook', 'ssh', 'mcp')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** A customer data source. Non-secret settings in config; credentials in the referenced secret. */
export const connection = app
  .table(
    "connection",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      name: text("name").notNull(),
      dialect: text("dialect").notNull(),
      config: jsonb("config").notNull().default({}),
      secretId: uuid("secret_id"),
      network: jsonb("network").notNull().default({}),
      limits: jsonb("limits").notNull().default({}),
      readOnlyVerifiedAt: timestamp("read_only_verified_at", { withTimezone: true }),
      // Set when an admin connected a user that can change data, knowingly. OpenDash still only reads.
      writeAccessAcceptedAt: timestamp("write_access_accepted_at", { withTimezone: true }),
      writeAccessAcceptedBy: uuid("write_access_accepted_by"),
      allowEdits: boolean("allow_edits").notNull().default(false),
      status: text("status").notNull().default("ok"),
      lastError: text("last_error"),
      syncRrule: text("sync_rrule"),
      nextSyncAt: timestamp("next_sync_at", { withTimezone: true }),
      // When its admin chose what OpenDash learns, and who: null until then, for a source that isn't the
      // sample company. Its drafts are requested as that person.
      learningChosenAt: timestamp("learning_chosen_at", { withTimezone: true }),
      learningChosenBy: uuid("learning_chosen_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      // Composite FK: a connection can't point at another org's secret.
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }),
      check("connection_dialect_check", sql`${t.dialect} in ${DIALECTS}`),
      check("connection_status_check", sql`${t.status} in ('ok', 'error', 'disabled')`),
      uniqueIndex("connection_org_name_uq").on(t.orgId, sql`lower(${t.name})`).where(sql`${t.deletedAt} is null`),
      index("connection_next_sync_idx").on(t.nextSyncAt).where(sql`${t.deletedAt} is null`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One check of a database's settings: queued by the web app, run by a worker, which writes each step as it
 * goes. A passing (or knowingly accepted) test is what a connection is created from; its secret becomes the
 * connection's. The config is non-secret; the password is in the secret.
 */
export const connectionTest = app
  .table(
    "connection_test",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      dialect: text("dialect").notNull(),
      config: jsonb("config").notNull(),
      secretId: uuid("secret_id").notNull(),
      /** queued → running → passed | warning (can change data) | blocked (superuser and the like) | failed */
      status: text("status").notNull().default("queued"),
      checks: jsonb("checks").notNull().default([]),
      facts: jsonb("facts").notNull().default({}),
      message: text("message"),
      requestedBy: uuid("requested_by"),
      /**
       * connect: a check of typed settings, which a connection may be created from.
       * recheck: Test connection on an existing source, with its own settings and secret.
       * update: new settings or a new password for an existing source, applied only once it passes.
       */
      purpose: text("purpose").notNull().default("connect"),
      /**
       * connect: the connection created from this test (a test is used at most once). recheck and update: the source
       * checked.
       */
      connectionId: uuid("connection_id"),
      /** update: when its settings were applied to the source (once). */
      appliedAt: timestamp("applied_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      startedAt: timestamp("started_at", { withTimezone: true }),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }).onDelete("cascade"),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }),
      check("connection_test_dialect_check", sql`${t.dialect} in ${DIALECTS}`),
      check(
        "connection_test_status_check",
        sql`${t.status} in ('queued', 'running', 'passed', 'warning', 'blocked', 'failed')`,
      ),
      check("connection_test_purpose_check", sql`${t.purpose} in ('connect', 'recheck', 'update')`),
      // A connection is created from one test; it can be re-checked any number of times.
      uniqueIndex("connection_test_connection_uq").on(t.orgId, t.connectionId).where(sql`${t.purpose} = 'connect'`),
      index("connection_test_source_idx").on(t.orgId, t.connectionId, t.createdAt),
      index("connection_test_created_idx").on(t.orgId, t.createdAt),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

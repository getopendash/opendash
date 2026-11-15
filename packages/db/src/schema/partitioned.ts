import {
  bigint,
  boolean,
  customType,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { app } from "./identity";

/**
 * Partitioned tables, and the audit log's chain heads. Their DDL is a hand-written migration (RANGE(id) on uuidv7,
 * policies, partition helpers, triggers), so this file is NOT in drizzle.config.ts; the definitions here exist only for
 * typed queries.
 */

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const inet = customType<{ data: string }>({ dataType: () => "inet" });

/**
 * Who changed what that matters for security. Insert-only for the app role; a trigger lets ee/'s sealer set the chain
 * columns once. `fields` names what changed, never its values.
 */
export const auditLog = app.table("audit_log", {
  id: uuid("id").notNull(),
  orgId: uuid("org_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  actorType: text("actor_type").notNull(),
  actorId: uuid("actor_id"),
  actorName: text("actor_name"),
  action: text("action").notNull(),
  targetType: text("target_type"),
  targetId: uuid("target_id"),
  targetName: text("target_name"),
  fields: text("fields").array().notNull().default([]),
  detail: jsonb("detail").notNull().default({}),
  ip: inet("ip"),
  userAgent: text("user_agent"),
  seq: bigint("seq", { mode: "number" }),
  prevHash: bytea("prev_hash"),
  hash: bytea("hash"),
});

/** Each organization's audit chain head (ee/): the last sealed row, advanced by compare-and-set on `seq`. */
export const auditChain = app.table("audit_chain", {
  orgId: uuid("org_id").primaryKey(),
  seq: bigint("seq", { mode: "number" }).notNull().default(0),
  hash: bytea("hash"),
  sealedAt: timestamp("sealed_at", { withTimezone: true }),
  purgedAt: timestamp("purged_at", { withTimezone: true }),
});

/** Usage, written in the same transaction as the ledger row that caused it, so it's counted exactly once. */
export const usageEvent = app.table("usage_event", {
  id: uuid("id").notNull(),
  orgId: uuid("org_id").notNull(),
  kind: text("kind").notNull(),
  qty: doublePrecision("qty").notNull(),
  unit: text("unit").notNull(),
  model: text("model"),
  provider: text("provider"),
  /** Whose key paid for a model call: the organization's own (`org`) or the deployment's (`deployment`). */
  keySource: text("key_source"),
  costUsd: numeric("cost_usd", { precision: 14, scale: 6 }),
  credits: bigint("credits", { mode: "number" }),
  sourceType: text("source_type"),
  sourceId: uuid("source_id"),
  userId: uuid("user_id"),
  /** Background work's (the Investigator, routines): its own budget counts it, the questions' limits don't. */
  background: boolean("background").notNull().default(false),
});

/** One query OpenDash ran or checked on a source: the trace behind every number. */
export const queryRun = app.table("query_run", {
  id: uuid("id").notNull(),
  orgId: uuid("org_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  requesterType: text("requester_type").notNull(),
  requesterId: uuid("requester_id"),
  toolCallId: uuid("tool_call_id"),
  alias: text("alias"),
  mode: text("mode").notNull(),
  path: text("path").notNull(),
  engine: text("engine").notNull(),
  title: text("title"),
  compiledSql: text("compiled_sql").notNull(),
  /**
   * The statement as it was written (comments, line breaks), when what ran is the dialect's canonical form of it
   * (ClickHouse's formatQuerySingleLine). Null when they're the same text.
   */
  writtenSql: text("written_sql"),
  sqlHash: text("sql_hash").notNull(),
  /** [{ name, value }] for $1, $2…, in order. */
  params: jsonb("params"),
  /** For a metric query: the spec, and the definitions (item, version) it compiled from. */
  semantic: jsonb("semantic"),
  /**
   * What the statement read, from the gateway's own parse: its tables as the catalog names them, and the
   * values it compared columns with. Graded by a learning's test; the graph's "used" edges later. Null before 0072.
   */
  reads: jsonb("reads"),
  status: text("status").notNull(),
  error: jsonb("error"),
  rows: integer("rows"),
  truncated: boolean("truncated").notNull(),
  bytes: bigint("bytes", { mode: "number" }),
  durationMs: integer("duration_ms"),
  resultSchema: jsonb("result_schema"),
  preview: jsonb("preview"),
  resultHash: text("result_hash"),
  sanity: jsonb("sanity").notNull(),
  /** The result cache: set when a result may be reused within its freshness bucket (dashboards). */
  cacheKey: text("cache_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/** What a run did, in order: a buffer for the trace and for clients that poll. Dropped after 3 days. */
export const runEvent = app.table("run_event", {
  id: uuid("id").notNull(),
  orgId: uuid("org_id").notNull(),
  runId: uuid("run_id").notNull(),
  attempt: integer("attempt").notNull(),
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

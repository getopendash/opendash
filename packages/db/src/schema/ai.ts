import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, jsonb, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { secret } from "./sources";

/** The kinds of provider (packages/core/src/ai/kinds.ts); a new kind is a line here and in the migration. */
const PROVIDER_KINDS = sql`('opendash', 'gateway', 'openrouter', 'anthropic', 'openai', 'google', 'bedrock', 'vertex')`;
/** The standard effort levels: low, medium, high, extra high, max. */
const LEVELS = sql`('low', 'medium', 'high', 'xhigh', 'max')`;

/**
 * A workspace's default: the model, the provider it runs on (by kind) and how long it thinks, for a
 * question asked without choosing and for background work. No row: Sonnet 5.5 on OpenDash, Auto, while it can run.
 */
export const aiSettings = app
  .table(
    "ai_settings",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      defaultModel: text("default_model").notNull(),
      defaultProvider: text("default_provider").notNull().default("opendash"),
      defaultReasoning: text("default_reasoning").notNull().default("high"),
      updatedBy: uuid("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId] }),
      check("ai_settings_provider_check", sql`${t.defaultProvider} in ${PROVIDER_KINDS}`),
      check("ai_settings_reasoning_check", sql`${t.defaultReasoning} in ${LEVELS}`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A provider a workspace runs models on, at most one of each kind. Its credentials are one secret of
 * kind `llm_key`, sealed as JSON and opened only in the worker; this row holds what people may see of them, whether
 * its test passed, and the allowlisted models its own list offers. OpenDash, the deployment's own, has no secret and
 * no row until an admin changes it.
 */
export const aiProvider = app
  .table(
    "ai_provider",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      kind: text("kind").notNull(),
      secretId: uuid("secret_id"),
      /** What Settings shows of its credentials: a key's last four, a region, a project. Never a secret. */
      shown: jsonb("shown").notNull().default({}),
      status: text("status").notNull().default("testing"),
      /** Why a test failed, in words a person can act on. */
      message: text("message"),
      testedAt: timestamp("tested_at", { withTimezone: true }),
      /** Its list met with the allowlist: allowlisted model id → the id the provider listed it under. */
      available: jsonb("available").notNull().default({}),
      listedAt: timestamp("listed_at", { withTimezone: true }),
      /** The allowlisted models people can pick from it; null: those measured. */
      picked: jsonb("picked"),
      enabled: boolean("enabled").notNull().default(true),
      createdBy: uuid("created_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      uniqueIndex("ai_provider_kind_uq").on(t.orgId, t.kind),
      // Composite FK: a provider can't point at another org's secret.
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }),
      check("ai_provider_kind_check", sql`${t.kind} in ${PROVIDER_KINDS}`),
      check("ai_provider_status_check", sql`${t.status} in ('testing', 'ok', 'failed')`),
      // OpenDash alone has nothing to seal; every other kind has its credentials.
      check("ai_provider_secret_check", sql`(${t.kind} = 'opendash') = (${t.secretId} is null)`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A provider's credentials as an admin typed them, tested before anything is saved: the worker reads
 * what the provider can run and asks it once, and Set up turns a test that passed into the provider, taking its
 * secret. A replaced key changes nothing until then. Tests nobody saved lose their secret after a day.
 */
export const aiProviderTest = app
  .table(
    "ai_provider_test",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      kind: text("kind").notNull(),
      secretId: uuid("secret_id").notNull(),
      /** What Settings will show of the credentials. Never a secret. */
      shown: jsonb("shown").notNull().default({}),
      status: text("status").notNull().default("testing"),
      message: text("message"),
      /** Its list met with the allowlist: allowlisted model id → the id the provider listed it under. */
      available: jsonb("available").notNull().default({}),
      requestedBy: uuid("requested_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      finishedAt: timestamp("finished_at", { withTimezone: true }),
      /** When a provider was set up from it (once). */
      usedAt: timestamp("used_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.secretId], foreignColumns: [secret.orgId, secret.id] }).onDelete("cascade"),
      check("ai_provider_test_kind_check", sql`${t.kind} in ${PROVIDER_KINDS} and ${t.kind} <> 'opendash'`),
      check("ai_provider_test_status_check", sql`${t.status} in ('testing', 'ok', 'failed')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

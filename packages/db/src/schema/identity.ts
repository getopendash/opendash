import { sql } from "drizzle-orm";
import { check, integer, jsonb, pgSchema, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { tenantPolicies } from "./policies";

/** Product tables live in the `app` schema; Better Auth owns `auth`, pg-boss owns `pgboss`. */
export const app = pgSchema("app");

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** One row per organization. id = auth.organization.id; created by the auth package when an organization is. */
export const org = app
  .table(
    "org",
    {
      id: uuid("id")
        .primaryKey()
        .references(() => organization.id, { onDelete: "restrict" }),
      name: text("name").notNull(),
      plan: text("plan").notNull().default("free"),
      status: text("status").notNull().default("active"),
      region: text("region"),
      /** The workspace's time zone: when its routines run and its metrics are checked. */
      tz: text("tz").notNull().default("UTC"),
      settings: jsonb("settings").notNull().default({}),
      billingRef: text("billing_ref"),
      ...timestamps,
    },
    (t) => [
      check("org_status_check", sql`${t.status} in ('active', 'suspended', 'deleting')`),
      ...tenantPolicies({ orgColumn: "id" }),
    ],
  )
  .enableRLS();

/** Wrapped data-encryption keys per org. Destroying every version crypto-shreds the org's secrets. */
export const orgKey = app
  .table(
    "org_key",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      version: integer("version").notNull(),
      wrappedDek: text("wrapped_dek").notNull(),
      kekRef: text("kek_ref").notNull(),
      state: text("state").notNull().default("active"),
      ...timestamps,
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.version] }),
      check("org_key_state_check", sql`${t.state} in ('active', 'retired', 'destroyed')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** Per-member preferences: time zone, interruption budget, quiet hours. What arrives on a schedule is a routine. */
export const memberPref = app
  .table(
    "member_pref",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      userId: uuid("user_id").notNull(),
      tz: text("tz").notNull().default("UTC"),
      pushBudgetPerDay: smallint("push_budget_per_day").notNull().default(1),
      pushBudgetPerWeek: smallint("push_budget_per_week").notNull().default(3),
      quietHours: jsonb("quiet_hours"),
      minPushSeverity: smallint("min_push_severity").notNull().default(3),
      ...timestamps,
    },
    (t) => [primaryKey({ columns: [t.orgId, t.userId] }), ...tenantPolicies()],
  )
  .enableRLS();

/** Favorite / seen / dismissed / snoozed marks a user puts on any object. */
export const userMark = app
  .table(
    "user_mark",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      userId: uuid("user_id").notNull(),
      targetType: text("target_type").notNull(),
      targetId: uuid("target_id").notNull(),
      mark: text("mark").notNull(),
      untilAt: timestamp("until_at", { withTimezone: true }),
      createdAt: timestamps.createdAt,
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.userId, t.targetType, t.targetId, t.mark] }),
      check("user_mark_mark_check", sql`${t.mark} in ('favorite', 'seen', 'dismissed', 'snoozed')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** Plan entitlements and overrides (seats, features, limits). */
export const entitlement = app
  .table(
    "entitlement",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      key: text("key").notNull(),
      value: jsonb("value").notNull(),
      source: text("source").notNull().default("plan"),
      validUntil: timestamp("valid_until", { withTimezone: true }),
      ...timestamps,
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.key] }),
      check("entitlement_source_check", sql`${t.source} in ('plan', 'override', 'license')`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

// Later domains use composite FKs: foreignKey({ columns: [t.orgId, t.xId], foreignColumns: [x.orgId, x.id] }),
// so a cross-tenant reference can't be written.

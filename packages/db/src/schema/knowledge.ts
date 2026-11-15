import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgPolicy,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { appRole, systemRole } from "./roles";
import { connection } from "./sources";

/** Stands in for "no source" and "no scope id" in unique keys, where NULLs would never collide. */
const NIL = sql.raw("'00000000-0000-0000-0000-000000000000'::uuid");

/**
 * Governed knowledge: typed items with immutable versions. The semantic
 * layer v0 uses two kinds, datasets and metrics, both about one source; the other kinds, scopes and anchors are here
 * so they don't need a migration later, with nothing built on them yet. Releases (context_release) come with the
 * eval gate: until then the agent reads each verified item's current version, and a query_run records the versions
 * it used.
 */
export const contextItem = app
  .table(
    "context_item",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      kind: text("kind").notNull(),
      scope: text("scope").notNull().default("org"),
      scopeId: uuid("scope_id"),
      anchorType: text("anchor_type").notNull().default("none"),
      anchorId: uuid("anchor_id"),
      /** The source it's about: datasets and metrics are per source (their SQL is in its dialect). */
      connectionId: uuid("connection_id"),
      /** Its place in the virtual filesystem: /sources/<connection id>/models/mrr_monthly.yaml. */
      path: text("path").notNull(),
      /** The dataset's ref or the metric's name. */
      slug: text("slug").notNull(),
      title: text("title").notNull(),
      ownerId: uuid("owner_id"),
      status: text("status").notNull().default("draft"),
      currentVersion: integer("current_version").notNull(),
      releasedVersion: integer("released_version"),
      verifiedBy: uuid("verified_by"),
      verifiedAt: timestamp("verified_at", { withTimezone: true }),
      /** An autosave buffer while someone edits; not a version. */
      draft: jsonb("draft"),
      trust: numeric("trust"),
      usageCount: integer("usage_count").notNull().default(0),
      lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.connectionId], foreignColumns: [connection.orgId, connection.id] }),
      check(
        "context_item_kind_check",
        sql`${t.kind} in ('dataset', 'metric', 'guide', 'term', 'verified_query', 'skill', 'memory', 'goal', 'doc')`,
      ),
      check("context_item_scope_check", sql`${t.scope} in ('org', 'project', 'team', 'personal')`),
      check(
        "context_item_anchor_check",
        sql`${t.anchorType} in ('none', 'connection', 'schema', 'table', 'column', 'dataset', 'metric', 'routine')`,
      ),
      check(
        "context_item_status_check",
        sql`${t.status} in ('draft', 'proposed', 'verified', 'needs_review', 'deprecated')`,
      ),
      // One dataset or metric of a name per source (keyed by scope and source, so two sources
      // can each have an `accounts` dataset).
      uniqueIndex("context_item_slug_uq")
        .on(
          t.orgId,
          t.kind,
          sql`coalesce(${t.connectionId}, ${NIL})`,
          t.scope,
          sql`coalesce(${t.scopeId}, ${NIL})`,
          t.slug,
        )
        .where(sql`${t.deletedAt} is null`),
      uniqueIndex("context_item_path_uq").on(t.orgId, t.path).where(sql`${t.deletedAt} is null`),
      index("context_item_connection_idx").on(t.orgId, t.connectionId, t.kind),
      ...tenantPolicies({ personalScope: true }),
    ],
  )
  .enableRLS();

const VERSION_VISIBLE = sql`org_id = (select app.org_id()) and exists (
  select 1 from app.context_item i where i.org_id = context_item_version.org_id and i.id = context_item_version.item_id)`;

/** One version of an item, never changed once written (only `derived`, filled by the validation job). */
export const contextItemVersion = app
  .table(
    "context_item_version",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      itemId: uuid("item_id").notNull(),
      version: integer("version").notNull(),
      /** As authored: YAML for datasets and metrics. */
      body: text("body").notNull(),
      bodyHash: text("body_hash").notNull(),
      /** The body parsed by its kind's spec. */
      spec: jsonb("spec").notNull(),
      /** What the validation job found: { status, problems, columns, checkedAt }. */
      derived: jsonb("derived"),
      source: text("source").notNull(),
      authorId: uuid("author_id"),
      changeNote: text("change_note"),
      proposalId: uuid("proposal_id"),
      /**
       * The drafter run that wrote this version, when the Modeler leads a batch: drafters share its proposal,
       * and each repairs only its own drafts. Null for any other author.
       */
      authorRunId: uuid("author_run_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.itemId, t.version] }),
      foreignKey({ columns: [t.orgId, t.itemId], foreignColumns: [contextItem.orgId, contextItem.id] }).onDelete(
        "cascade",
      ),
      check(
        "context_item_version_source_check",
        sql`${t.source} in ('user', 'agent', 'proposal', 'import', 'doc_sync', 'miner', 'modeler', 'pack')`,
      ),
      // A version is only as visible as its item: someone else's personal item hides its versions too. The subquery
      // reads context_item under that table's own policy, so the item's scope rule applies here unchanged.
      pgPolicy("tenant", {
        as: "permissive",
        for: "all",
        to: appRole,
        using: VERSION_VISIBLE,
        withCheck: VERSION_VISIBLE,
      }),
      pgPolicy("system", { as: "permissive", for: "all", to: systemRole, using: sql`true`, withCheck: sql`true` }),
    ],
  )
  .enableRLS();

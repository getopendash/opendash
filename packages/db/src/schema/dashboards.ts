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
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";
import { project } from "./projects";

/**
 * Dashboards: one product, from a page of numbers to a working tool, built by the analyst for a purpose.
 * Its definition (`dashboard.json`: named queries, filters, pages of sections) and any custom parts are a version;
 * the frame draws a version's render revision. Like a conversation, it's private to its owner, shared with its
 * project's people, or shared with the organization (`visibility`, checked in core the way threads are; row security
 * keeps organizations apart).
 */
export const dashboard = app
  .table(
    "dashboard",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      projectId: uuid("project_id"),
      /** A folder of its project; cleared when it moves out of the project. */
      folderId: uuid("folder_id"),
      title: text("title").notNull(),
      /** What it's for, in one line: the plan card's purpose. */
      purpose: text("purpose"),
      ownerId: uuid("owner_id").notNull(),
      visibility: text("visibility").notNull().default("private"),
      /** The version people open; 0 until its first is saved (a draft being built). */
      currentVersion: integer("current_version").notNull().default(0),
      tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
      /** The conversation it was built in: "Built with the analyst · Continue". */
      threadId: uuid("thread_id"),
      /**
       * The plan it was built from, kept from the moment Build it was pressed: its page draws the plan's pages as
       * outlines until each lands. `planRunId` is the run whose plan it was: starting again from it finds this one.
       */
      plan: jsonb("plan"),
      planRunId: uuid("plan_run_id"),
      /**
       * The owner's work that doesn't build yet: the manifest and files of a save that failed
       * its check, on the base it started from, so the next save fixes only what failed instead of writing every file
       * again. Cleared when a save passes. Never drawn: the page shows the last build that passed.
       */
      work: jsonb("work"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      check("dashboard_visibility_check", sql`${t.visibility} in ('private', 'project', 'org')`),
      check("dashboard_project_visibility_check", sql`${t.visibility} <> 'project' or ${t.projectId} is not null`),
      foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [project.orgId, project.id] }),
      // The folder key checks nothing when project_id is null: a folder needs its project.
      check("dashboard_folder_project_check", sql`${t.folderId} is null or ${t.projectId} is not null`),
      foreignKey({
        name: "dashboard_folder_fk",
        columns: [t.orgId, t.projectId, t.folderId],
        foreignColumns: [project.orgId, project.parentId, project.id],
      }),
      index("dashboard_project_idx").on(t.orgId, t.projectId),
      index("dashboard_updated_idx").on(t.orgId, t.updatedAt.desc()),
      // One dashboard a plan: Build it pressed twice, or a replayed start, finds the one it made.
      uniqueIndex("dashboard_plan_run_uq").on(t.orgId, t.planRunId).where(sql`${t.planRunId} is not null`),
      index("dashboard_owner_idx").on(t.orgId, t.ownerId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * One saved version of a dashboard, never changed once written (a trigger refuses updates): a change is a new
 * version. Its render revision binds the definition, the custom parts' bundle, the runtime and the query contracts;
 * the frame and every request name it.
 */
export const dashboardVersion = app
  .table(
    "dashboard_version",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      dashboardId: uuid("dashboard_id").notNull(),
      version: integer("version").notNull(),
      /** `dashboard.json`, checked. */
      definition: jsonb("definition").notNull(),
      /** Custom parts' sources, by path (`/parts/AccountCard.tsx`): empty for a sections-only dashboard. */
      parts: jsonb("parts").notNull().default(sql`'{}'::jsonb`),
      /** The parts' checked bundle and its hash; null when it has none. */
      bundle: text("bundle"),
      bundleHash: text("bundle_hash"),
      /** The runtime it was checked against and is drawn with (kept and served by hash). */
      runtimeHash: text("runtime_hash").notNull(),
      /** sha256 of the definition, bundle hash, runtime hash and query contracts' version. */
      revision: text("revision").notNull(),
      /** Who saved it: a person, or the analyst in a run for them. */
      authorId: uuid("author_id"),
      runId: uuid("run_id"),
      parentVersion: integer("parent_version"),
      changeNote: text("change_note"),
      /**
       * The definitions it read that weren't released when it was published (datasets and metrics, by item id): their
       * version then. A later edit to one of those drafts never changes what a published version draws; a release
       * (an admin's) does.
       */
      pins: jsonb("pins"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.dashboardId, t.version] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      // No index on the revision: a restore is a new version drawing an earlier one's revision, and a revision is
      // looked up within one dashboard's few versions.
      index("dashboard_version_bundle_idx").on(t.bundleHash),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * The draft being built or changed: one per dashboard, its owner's live preview. Saving checks it and writes the next
 * version from it, against the version it was based on.
 */
export const dashboardDraft = app
  .table(
    "dashboard_draft",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      dashboardId: uuid("dashboard_id").notNull(),
      definition: jsonb("definition").notNull(),
      parts: jsonb("parts").notNull().default(sql`'{}'::jsonb`),
      bundle: text("bundle"),
      bundleHash: text("bundle_hash"),
      runtimeHash: text("runtime_hash"),
      revision: text("revision"),
      /** The saved version it started from (0: none yet): saving refuses a draft whose base moved on. */
      baseVersion: integer("base_version").notNull().default(0),
      updatedBy: uuid("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      /**
       * What an analyst's run can put back ("Undo these changes"): the draft as it was before the run's
       * first save of it (null: no draft, the version), the run, the version then, and the revision it last saved.
       * Undone only while that's still the draft; any other save clears it.
       */
      undo: jsonb("undo"),
      /**
       * The render check of the revision the draft holds: what the person's browser measured at each
       * width, `{ revision, widths: { "390": findings… } }`. Every save clears it: a new revision is measured again.
       */
      renderCheck: jsonb("render_check"),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.dashboardId] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      index("dashboard_draft_bundle_idx").on(t.bundleHash),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * Answers to a dashboard's named queries, cached by the complete bound query's identity: the query, its
 * page, cursor and sort, the datasets' versions, and who it may be shown to. Written by the worker, read by the web
 * app; a stale or revoked answer is never served (checked before delivery).
 */
export const dashboardResult = app
  .table(
    "dashboard_result",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      cacheKey: text("cache_key").notNull(),
      status: text("status").notNull(),
      result: jsonb("result"),
      error: text("error"),
      /** The query run that answered it: a press on one of its numbers opens what's behind it from here. */
      queryRunId: uuid("query_run_id"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.cacheKey] }),
      check("dashboard_result_status_check", sql`${t.status} in ('ok', 'failed')`),
      index("dashboard_result_expires_idx").on(t.expiresAt),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * The work on a dashboard's records: who owns a record, where it stands, a note and when to follow
 * up, kept in OpenDash beside the warehouse's rows (never written back to them). One row a record (its dataset and
 * key), changed by anyone who works in the dashboard, each change remembered by who and when.
 */
export const dashboardWork = app
  .table(
    "dashboard_work",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      dashboardId: uuid("dashboard_id").notNull(),
      /** The source its records come from: the same dataset name on two sources is two sets of records. */
      connectionId: uuid("connection_id").notNull(),
      dataset: text("dataset").notNull(),
      recordKey: text("record_key").notNull(),
      ownerId: uuid("owner_id"),
      status: text("status"),
      note: text("note"),
      followUp: date("follow_up"),
      updatedBy: uuid("updated_by"),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.dashboardId, t.connectionId, t.dataset, t.recordKey] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      check("dashboard_work_note_check", sql`char_length(${t.note}) <= 2000`),
      index("dashboard_work_owner_idx").on(t.orgId, t.ownerId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A change a person makes in a service from a dashboard's row: the effect, written
 * before the call. Prepared from the revision the page draws (the tool, the arguments filled with the row's key, the
 * account and the tool's digest as they were shown), confirmed by that person on OpenDash's own dialog within two
 * minutes, claimed once (`prepared` → `running`) and settled: `done`, `failed`, or `unknown` when the service's answer
 * never came (never sent again). A replay reads the settled row.
 */
export const dashboardAction = app
  .table(
    "dashboard_action",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      dashboardId: uuid("dashboard_id").notNull(),
      revision: text("revision").notNull(),
      section: text("section").notNull(),
      action: text("action").notNull(),
      userId: uuid("user_id").notNull(),
      recordKey: text("record_key").notNull(),
      serverId: uuid("server_id").notNull(),
      tool: text("tool").notNull(),
      arguments: jsonb("arguments").notNull(),
      argumentsHash: text("arguments_hash").notNull(),
      connectionId: uuid("connection_id").notNull(),
      accountRevision: integer("account_revision").notNull(),
      toolDigest: text("tool_digest").notNull(),
      status: text("status").notNull().default("prepared"),
      result: text("result"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
      ranAt: timestamp("ran_at", { withTimezone: true }),
      settledAt: timestamp("settled_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      check("dashboard_action_status_check", sql`${t.status} in ('prepared', 'running', 'done', 'failed', 'unknown')`),
      check("dashboard_action_result_check", sql`char_length(${t.result}) <= 300`),
      index("dashboard_action_user_idx").on(t.orgId, t.userId, t.createdAt),
      // One change at a time to a row: a second press (another tab, another person) waits for the first to settle.
      uniqueIndex("dashboard_action_running_uq")
        .on(t.orgId, t.dashboardId, t.section, t.recordKey)
        .where(sql`status = 'running'`),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A worked record's history: each change to its owner, status, note or follow-up, with who and when,
 * written with the change. Read as the work is (each record checked against what the reader may see).
 */
export const dashboardWorkEvent = app
  .table(
    "dashboard_work_event",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      dashboardId: uuid("dashboard_id").notNull(),
      connectionId: uuid("connection_id").notNull(),
      dataset: text("dataset").notNull(),
      recordKey: text("record_key").notNull(),
      field: text("field").notNull(),
      value: text("value"),
      by: uuid("by"),
      at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      check("dashboard_work_event_field_check", sql`${t.field} in ('owner', 'status', 'note', 'follow_up')`),
      check("dashboard_work_event_value_check", sql`char_length(${t.value}) <= 2000`),
      index("dashboard_work_event_record_idx").on(t.orgId, t.dashboardId, t.connectionId, t.dataset, t.recordKey, t.at),
      // The rate cap on an App's writes counts one person's changes to it in the last ten minutes, under its lock
      // (core dashboards/work.ts): read from this, never by scanning the App's whole history.
      index("dashboard_work_event_rate_idx").on(t.orgId, t.dashboardId, t.by, t.at),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A person a dashboard is shared with, on top of its visibility: `view` reads
 * it as anyone its visibility covers does; `edit` changes its draft too (publishing, restoring, sharing and deleting
 * stay its owner's). Only its owner adds, changes and removes people, each a member of the organization (checked in
 * core when they're added); access is checked in the queries, as for visibility, and row security keeps
 * organizations apart.
 */
export const dashboardShare = app
  .table(
    "dashboard_share",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      dashboardId: uuid("dashboard_id").notNull(),
      userId: uuid("user_id").notNull(),
      role: text("role").notNull(),
      addedBy: uuid("added_by").notNull(),
      addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      check("dashboard_share_role_check", sql`${t.role} in ('view', 'edit')`),
      // One share a person a dashboard: a second add changes their role.
      uniqueIndex("dashboard_share_person_uq").on(t.orgId, t.dashboardId, t.userId),
      // What's shared with someone: their list's "Shared with you", and their shares dropped when they leave.
      index("dashboard_share_user_idx").on(t.orgId, t.userId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/**
 * A dashboard's kept inputs: a value set for everyone who opens it ("target net retention 110 %"), with
 * who set it and when. Saved only from the page's own dialog.
 */
export const dashboardInput = app
  .table(
    "dashboard_input",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      dashboardId: uuid("dashboard_id").notNull(),
      input: text("input").notNull(),
      value: doublePrecision("value").notNull(),
      setBy: uuid("set_by").notNull(),
      setAt: timestamp("set_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.dashboardId, t.input] }),
      foreignKey({ columns: [t.orgId, t.dashboardId], foreignColumns: [dashboard.orgId, dashboard.id] }).onDelete(
        "cascade",
      ),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

import { sql } from "drizzle-orm";
import { check, foreignKey, index, jsonb, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { member } from "./auth";
import { app, org } from "./identity";
import { tenantPolicies } from "./policies";

/**
 * Projects: a place for a piece of work,
 * holding conversations and dashboards. Folders (`kind = folder`, `parent_id`) and key tables (`settings`) come
 * later; the columns are here so they need no migration. Visible to its people, or to everyone in the organization
 * when `visibility = org` (checked in core, like threads; RLS keeps organizations apart).
 */
export const project = app
  .table(
    "project",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      id: uuid("id").notNull(),
      kind: text("kind").notNull().default("project"),
      parentId: uuid("parent_id"),
      name: text("name").notNull(),
      slug: text("slug").notNull(),
      description: text("description"),
      visibility: text("visibility").notNull().default("private"),
      settings: jsonb("settings").notNull().default({}),
      createdBy: uuid("created_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
      deletedAt: timestamp("deleted_at", { withTimezone: true }),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.id] }),
      foreignKey({ columns: [t.orgId, t.parentId], foreignColumns: [t.orgId, t.id] }),
      check("project_kind_check", sql`${t.kind} in ('project', 'folder')`),
      check("project_visibility_check", sql`${t.visibility} in ('private', 'org')`),
      // A project sits at the top; a folder sits in a project (one level only, checked in core).
      check("project_folder_parent_check", sql`(${t.kind} = 'project') = (${t.parentId} is null)`),
      // One name per place: projects at the top, a project's folders within it.
      unique("project_slug_uq").on(t.orgId, t.parentId, t.slug).nullsNotDistinct(),
      // What a thread's or dashboard's folder points at: a folder of its own project.
      unique("project_parent_uq").on(t.orgId, t.parentId, t.id),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

/** A project's people and their roles (manager, editor, viewer). Teams come later, as another principal type. */
export const projectMember = app
  .table(
    "project_member",
    {
      orgId: uuid("org_id")
        .notNull()
        .references(() => org.id, { onDelete: "cascade" }),
      projectId: uuid("project_id").notNull(),
      principalType: text("principal_type").notNull().default("user"),
      principalId: uuid("principal_id").notNull(),
      role: text("role").notNull(),
      addedBy: uuid("added_by"),
      createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
      primaryKey({ columns: [t.orgId, t.projectId, t.principalType, t.principalId] }),
      foreignKey({ columns: [t.orgId, t.projectId], foreignColumns: [project.orgId, project.id] }).onDelete("cascade"),
      // A project's people are its organization's members: their roles go with the membership, so someone invited
      // back starts with none (as slack_identity's link, 0068).
      foreignKey({
        name: "project_member_member_fk",
        columns: [t.orgId, t.principalId],
        foreignColumns: [member.organizationId, member.userId],
      }).onDelete("cascade"),
      check("project_member_type_check", sql`${t.principalType} in ('user')`),
      check("project_member_role_check", sql`${t.role} in ('manager', 'editor', 'viewer')`),
      // Every visibility check asks "is this person in that project?".
      index("project_member_principal_idx").on(t.orgId, t.principalId),
      ...tenantPolicies(),
    ],
  )
  .enableRLS();

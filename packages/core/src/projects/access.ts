/**
 * Who reads a conversation or a dashboard: its owner; everyone in the
 * organization, when it's shared with the organization; the project's people (or everyone, when the project is open
 * to the organization), when it's shared with its project. One rule for threads, dashboards, the queries behind them
 * and attachments. It's a check on the person only: callers without one (an organization API key, evals) read only
 * what has no owner, and what's shared with the organization. A dashboard may also be shared with people by name, each
 * to view or to edit its draft (`dashboardReadableBy`, `dashboardEditableBy`).
 */
import { type SQL, sql } from "@opendash/db";

interface Columns {
  org: SQL;
  owner: SQL;
  visibility: SQL;
  project: SQL;
}

export function readableBy(c: Columns, userId: string | null): SQL {
  return sql`(${c.owner} is not distinct from ${userId} or ${c.visibility} = 'org'
    or (${c.visibility} = 'project' and ${userId}::uuid is not null and exists (
      select 1 from app.project p
      where p.org_id = ${c.org} and p.id = ${c.project} and p.deleted_at is null
        and (p.visibility = 'org' or exists (
          select 1 from app.project_member m
          where m.org_id = p.org_id and m.project_id = p.id and m.principal_type = 'user'
            and m.principal_id = ${userId}::uuid)))))`;
}

/**
 * A thread (alias `t`) of background work that's one person's alone, and not this viewer's:
 * a private routine's run (it reaches only its owner), the investigation of a private finding, someone's Describe it
 * draft. Nobody else reads it, owners and admins included, nor anything acting as no person (an org API key).
 */
/**
 * Someone else's background work (alias `t`) that's one person's alone: a private routine's
 * run, a private finding's investigation, a Describe it draft. Their conversations carry that person as their owner
 * from the start (routines/privacy.ts, checks/investigate.ts), while the workspace's own background work has none.
 * Nobody but its owner reads it: owners, admins and org API keys included.
 */
export const othersPrivateWork = (userId: string | null) =>
  sql`(t.channel in ('routine', 'insight') and t.created_by is not null and t.created_by is distinct from ${userId}::uuid)`;

/** A thread (alias `t`) the person can read. */
export const threadReadableBy = (userId: string | null) =>
  readableBy(
    { org: sql`t.org_id`, owner: sql`t.created_by`, visibility: sql`t.visibility`, project: sql`t.project_id` },
    userId,
  );

/**
 * The person builds in the workspace now: a member who isn't one of its viewers. Checked whenever an edit share is
 * used, never only when it was given: someone made a viewer since keeps reading, and their edit share acts as View.
 */
const builds = (userId: string | null) =>
  sql`coalesce(app.member_role(${userId}::uuid) in ('owner', 'admin', 'member'), false)`;

/**
 * The person (alias `d`'s) is one the dashboard is shared with, at `role` when it's given: shares add people on top of
 * its visibility (app.dashboard_share). Nobody, for a caller with no person (an organization key).
 */
const sharedWith = (userId: string | null, role?: "edit") =>
  sql`(${userId}::uuid is not null and exists (
    select 1 from app.dashboard_share s
    where s.org_id = d.org_id and s.dashboard_id = d.id and s.user_id = ${userId}::uuid
      ${role ? sql`and s.role = ${role} and ${builds(userId)}` : sql``}))`;

/** A dashboard (alias `d`) the person can read: its owner, anyone its visibility covers, anyone it's shared with. */
export const dashboardReadableBy = (userId: string | null) =>
  sql`(${readableBy(
    { org: sql`d.org_id`, owner: sql`d.owner_id`, visibility: sql`d.visibility`, project: sql`d.project_id` },
    userId,
  )} or ${sharedWith(userId)})`;

/**
 * A dashboard (alias `d`) whose draft the person may change: its owner, or someone it's shared with to edit. Changing
 * the draft is all an editor may do: publishing, restoring, sharing and deleting stay its owner's.
 */
export const dashboardEditableBy = (userId: string | null) =>
  sql`(d.owner_id is not distinct from ${userId}::uuid or ${sharedWith(userId, "edit")})`;

/**
 * How the dashboard (alias `d`) is shared with the person themselves: 'view', 'edit', or null when it isn't. An edit
 * share of someone who doesn't build now (a viewer) reads as the View it acts as.
 */
export const dashboardShareOf = (userId: string | null) =>
  sql`(select case when s.role = 'edit' and not ${builds(userId)} then 'view' else s.role end
    from app.dashboard_share s
    where s.org_id = d.org_id and s.dashboard_id = d.id and s.user_id = ${userId}::uuid)`;

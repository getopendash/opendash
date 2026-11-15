/**
 * Projects: a place for a piece of work, its people and their roles, and
 * moving conversations and dashboards in and out. Every change checks the actor's role here, so neither the web app
 * nor the API can skip it. The organization role comes from the caller (the app can't read `auth`):
 * `orgRole` is the actor's, already resolved by the web app or the API.
 */
import { isUuid, sql, type TenantTx, uuidv7 } from "@opendash/db";
import { dashboardReadableBy, threadReadableBy } from "./access";

export type ProjectRole = "manager" | "editor" | "viewer";
export type OrgRole = "owner" | "admin" | "member" | "viewer";

export interface ProjectActor {
  orgId: string;
  userId: string;
  orgRole: string;
}

export interface ProjectView {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "private" | "org";
  /** The actor's role in it, or null (an organization admin, or anyone in an org-visible project, who isn't in it). */
  role: ProjectRole | null;
  people: number;
  conversations: number;
  dashboards: number;
  createdAt: string;
}

export interface ProjectPerson {
  userId: string;
  role: ProjectRole;
  addedAt: string;
}

/** A project that doesn't exist, or that this person can't see: the same answer, so existence isn't revealed. */
export class ProjectNotFound extends Error {
  override name = "ProjectNotFound";
  constructor() {
    super("That project doesn't exist.");
  }
}

/** Something the actor's role doesn't allow, with what would. */
export class ProjectRefused extends Error {
  override name = "ProjectRefused";
}

const isOrgAdmin = (a: ProjectActor) => a.orgRole === "owner" || a.orgRole === "admin";
const RANK: Record<ProjectRole, number> = { viewer: 0, editor: 1, manager: 2 };

const slugOf = (name: string) =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "project";

type Row = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  visibility: "private" | "org";
  role: ProjectRole | null;
  people: number;
  conversations: number;
  dashboards: number;
  created_at: string;
};

/**
 * The actor's role as it counts now: a viewer of the organization is at most a viewer in a project, whatever role
 * was stored before they became one (an org role can change after someone is added).
 */
const effective = (role: ProjectRole | null, orgRole: string): ProjectRole | null =>
  role && orgRole === "viewer" ? "viewer" : role;

const view = (r: Row, orgRole: string): ProjectView => ({
  id: r.id,
  name: r.name,
  slug: r.slug,
  description: r.description,
  visibility: r.visibility,
  role: effective(r.role, orgRole),
  people: Number(r.people),
  conversations: Number(r.conversations),
  dashboards: Number(r.dashboards),
  createdAt: new Date(r.created_at).toISOString(),
});

/** Projects the actor sees: theirs, the ones open to the organization, and (for owners and admins) every one. */
async function projects(tx: TenantTx, actor: ProjectActor, id?: string): Promise<ProjectView[]> {
  const rows = await tx.execute<Row>(sql`
    select p.id, p.name, p.slug, p.description, p.visibility, me.role, p.created_at::text,
      (select count(*) from app.project_member m where m.org_id = p.org_id and m.project_id = p.id)::int as people,
      -- What's in it that this person can read.
      (select count(*) from app.thread t
        where t.org_id = p.org_id and t.project_id = p.id and t.deleted_at is null
          and ${threadReadableBy(actor.userId)})::int as conversations,
      (select count(*) from app.dashboard d
        where d.org_id = p.org_id and d.project_id = p.id and d.deleted_at is null
          and ${dashboardReadableBy(actor.userId)})::int as dashboards
    from app.project p
    left join app.project_member me on me.org_id = p.org_id and me.project_id = p.id
      and me.principal_type = 'user' and me.principal_id = ${actor.userId}::uuid
    where p.org_id = ${actor.orgId} and p.deleted_at is null and p.kind = 'project'
      ${id ? sql`and p.id = ${id}` : sql``}
      and (me.role is not null or p.visibility = 'org' or ${isOrgAdmin(actor)})
    order by lower(p.name), p.id`);
  return rows.map((r) => view(r, actor.orgRole));
}

export const listProjects = (tx: TenantTx, actor: ProjectActor) => projects(tx, actor);

export async function getProject(tx: TenantTx, actor: ProjectActor, id: string): Promise<ProjectView | null> {
  return (await projects(tx, actor, id))[0] ?? null;
}

/** The project's people, managers first. Names come from the web app (`memberNames`), which can read them. */
export async function projectPeople(tx: TenantTx, actor: ProjectActor, id: string): Promise<ProjectPerson[]> {
  if (!(await getProject(tx, actor, id))) throw new ProjectNotFound();
  const rows = await tx.execute<{ principal_id: string; role: ProjectRole; created_at: string }>(sql`
    select principal_id, role, created_at::text from app.project_member
    where org_id = ${actor.orgId} and project_id = ${id} and principal_type = 'user'
    order by case role when 'manager' then 0 when 'editor' then 1 else 2 end, created_at`);
  return rows.map((r) => ({ userId: r.principal_id, role: r.role, addedAt: new Date(r.created_at).toISOString() }));
}

/** The actor's role in a project they can see, and whether they can manage it (a manager, or an org admin). */
async function standing(tx: TenantTx, actor: ProjectActor, id: string) {
  const p = await getProject(tx, actor, id);
  if (!p) throw new ProjectNotFound();
  return { project: p, manages: p.role === "manager" || isOrgAdmin(actor) };
}

export async function createProject(
  tx: TenantTx,
  actor: ProjectActor,
  input: { name: string; description?: string | null; visibility?: "private" | "org" },
): Promise<ProjectView> {
  if (actor.orgRole === "viewer")
    throw new ProjectRefused("Viewers can't create projects. An admin can make you a member.");
  const name = input.name.trim();
  if (!name) throw new ProjectRefused("Name the project.");
  if (name.length > 80) throw new ProjectRefused("Keep the name under 80 characters.");
  if ((input.description?.length ?? 0) > 300) throw new ProjectRefused("Keep the description under 300 characters.");
  const id = uuidv7();
  const base = slugOf(name);
  // The first free slug: board-pack, board-pack-2…
  const taken = new Set(
    (
      await tx.execute<{ slug: string }>(sql`
        select slug from app.project where org_id = ${actor.orgId} and parent_id is null
          and (slug = ${base} or slug like ${`${base}-%`})`)
    ).map((r) => r.slug),
  );
  let n = 1;
  const next = () => {
    let slug = n === 1 ? base : `${base}-${n}`;
    while (taken.has(slug)) slug = `${base}-${++n}`;
    taken.add(slug);
    return slug;
  };
  // Someone creating the same name at the same moment takes the slug first: the next free one, then.
  for (let attempt = 0; ; attempt++) {
    const [made] = await tx.execute<{ id: string }>(sql`
      insert into app.project (org_id, id, name, slug, description, visibility, created_by)
      values (${actor.orgId}, ${id}, ${name}, ${next()}, ${input.description?.trim() || null},
        ${input.visibility ?? "private"}, ${actor.userId})
      on conflict on constraint project_slug_uq do nothing
      returning id`);
    if (made) break;
    if (attempt === 4) throw new ProjectRefused("Couldn't name the project: try again in a moment.");
  }
  await tx.execute(sql`
    insert into app.project_member (org_id, project_id, principal_id, role, added_by)
    values (${actor.orgId}, ${id}, ${actor.userId}, 'manager', ${actor.userId})`);
  return (await getProject(tx, actor, id)) as ProjectView;
}

export async function updateProject(
  tx: TenantTx,
  actor: ProjectActor,
  id: string,
  input: { name?: string; description?: string | null; visibility?: "private" | "org" },
): Promise<ProjectView> {
  const { manages } = await standing(tx, actor, id);
  if (!manages) throw new ProjectRefused("Only the project's managers change it.");
  const name = input.name?.trim();
  if (name !== undefined && (!name || name.length > 80)) throw new ProjectRefused("Name it, in under 80 characters.");
  if ((input.description?.length ?? 0) > 300) throw new ProjectRefused("Keep the description under 300 characters.");
  await tx.execute(sql`
    update app.project set
      name = coalesce(${name ?? null}, name),
      description = ${input.description === undefined ? sql`description` : input.description?.trim() || null},
      visibility = coalesce(${input.visibility ?? null}, visibility),
      updated_at = now()
    where org_id = ${actor.orgId} and id = ${id}`);
  return (await getProject(tx, actor, id)) as ProjectView;
}

/**
 * Deletes a project: everything in it moves back out with its owner, and what was shared with the project becomes
 * private, so nothing is visible to more people than before.
 */
export async function deleteProject(tx: TenantTx, actor: ProjectActor, id: string): Promise<void> {
  const { manages } = await standing(tx, actor, id);
  if (!manages) throw new ProjectRefused("Only the project's managers delete it.");
  for (const table of [sql`app.thread`, sql`app.dashboard`]) {
    await tx.execute(sql`
      update ${table} set project_id = null, folder_id = null,
        visibility = case when visibility = 'project' then 'private' else visibility end
      where org_id = ${actor.orgId} and project_id = ${id}`);
  }
  await tx.execute(sql`
    update app.project set deleted_at = now(), updated_at = now()
    where org_id = ${actor.orgId} and parent_id = ${id} and kind = 'folder' and deleted_at is null`);
  await tx.execute(sql`delete from app.project_member where org_id = ${actor.orgId} and project_id = ${id}`);
  await tx.execute(sql`
    update app.project set deleted_at = now(), updated_at = now() where org_id = ${actor.orgId} and id = ${id}`);
}

/** Managers left, besides `except`. */
async function otherManagers(tx: TenantTx, orgId: string, id: string, except: string): Promise<number> {
  const [r] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from app.project_member
    where org_id = ${orgId} and project_id = ${id} and role = 'manager' and principal_id <> ${except}::uuid`);
  return r?.n ?? 0;
}

/**
 * Adds someone, or changes their role. `person.orgRole` is theirs in the organization, resolved by the caller with the
 * member list (the web app or the API): only people of the organization can be added, and its viewers only as viewers.
 */
export async function setProjectPerson(
  tx: TenantTx,
  actor: ProjectActor,
  id: string,
  person: { userId: string; orgRole: string; role: ProjectRole },
): Promise<void> {
  const { manages } = await standing(tx, actor, id);
  if (!manages) throw new ProjectRefused("Only the project's managers add people.");
  if (person.orgRole === "viewer" && person.role !== "viewer") {
    throw new ProjectRefused("Viewers of the organization can only be viewers in a project.");
  }
  const [current] = await tx.execute<{ role: ProjectRole }>(sql`
    select role from app.project_member
    where org_id = ${actor.orgId} and project_id = ${id} and principal_type = 'user' and principal_id = ${person.userId}::uuid`);
  if (
    current?.role === "manager" &&
    person.role !== "manager" &&
    !isOrgAdmin(actor) &&
    (await otherManagers(tx, actor.orgId, id, person.userId)) === 0
  ) {
    throw new ProjectRefused("A project needs a manager: make someone else one first.");
  }
  await tx.execute(sql`
    insert into app.project_member (org_id, project_id, principal_id, role, added_by)
    values (${actor.orgId}, ${id}, ${person.userId}, ${person.role}, ${actor.userId})
    on conflict (org_id, project_id, principal_type, principal_id) do update set role = excluded.role`);
}

/**
 * Removes someone (a manager removes anyone, anyone removes themselves). They stop seeing what's shared with the
 * project, and keep their own things in it.
 */
export async function removeProjectPerson(
  tx: TenantTx,
  actor: ProjectActor,
  id: string,
  userId: string,
): Promise<void> {
  const { manages } = await standing(tx, actor, id);
  if (!manages && userId !== actor.userId) throw new ProjectRefused("Only the project's managers remove people.");
  const [current] = await tx.execute<{ role: ProjectRole }>(sql`
    select role from app.project_member
    where org_id = ${actor.orgId} and project_id = ${id} and principal_type = 'user' and principal_id = ${userId}::uuid`);
  if (!current) return;
  if (current.role === "manager" && !isOrgAdmin(actor) && (await otherManagers(tx, actor.orgId, id, userId)) === 0) {
    throw new ProjectRefused("A project needs a manager: make someone else one first.");
  }
  await tx.execute(sql`
    delete from app.project_member
    where org_id = ${actor.orgId} and project_id = ${id} and principal_type = 'user' and principal_id = ${userId}::uuid`);
}

/** The actor's role in a project, for starting or moving things into it: editors and managers only. */
async function canAddTo(tx: TenantTx, actor: ProjectActor, id: string): Promise<void> {
  const p = await getProject(tx, actor, id);
  if (!p) throw new ProjectNotFound();
  if (!p.role || RANK[p.role] < RANK.editor) {
    throw new ProjectRefused("Only the project's editors and managers add to it.");
  }
}

/** Whether the actor may start a conversation in this project (submitQuestion's `projectId`). */
export const assertCanAddToProject = canAddTo;

/**
 * Moves the actor's own conversation or dashboard into a project (shared with its people when `share`), or out of
 * its project (`projectId` null). What was shared with its old project becomes private unless it's shared with the
 * new one: moving never shows it to people nobody chose.
 */
export async function moveToProject(
  tx: TenantTx,
  actor: ProjectActor,
  item: { kind: "thread" | "dashboard"; id: string },
  projectId: string | null,
  options: { share?: boolean } = {},
): Promise<void> {
  const table = item.kind === "thread" ? sql`app.thread` : sql`app.dashboard`;
  const owner = item.kind === "thread" ? sql`created_by` : sql`owner_id`;
  const [row] = await tx.execute<{ mine: boolean }>(sql`
    select ${owner} is not distinct from ${actor.userId}::uuid as mine from ${table}
    where org_id = ${actor.orgId} and id = ${item.id} and deleted_at is null
`);
  if (!row?.mine) throw new ProjectRefused("Only its owner moves it.");
  if (projectId) await canAddTo(tx, actor, projectId);
  // A folder belongs to its project: moving clears it.
  await tx.execute(sql`
    update ${table} set project_id = ${projectId}, folder_id = null,
      visibility = case
        when ${projectId}::uuid is not null and ${options.share === true} then 'project'
        when visibility = 'project' then 'private'
        else visibility end
    where org_id = ${actor.orgId} and id = ${item.id}`);
}

/** A folder in a project: one level, holding the project's conversations and dashboards. */
export interface FolderView {
  id: string;
  name: string;
  /** What's in it that the actor can read. */
  conversations: number;
  dashboards: number;
}

/** A project's folders, by name, with what's in each that the actor can read. */
export async function listFolders(tx: TenantTx, actor: ProjectActor, projectId: string): Promise<FolderView[]> {
  if (!(await getProject(tx, actor, projectId))) throw new ProjectNotFound();
  const rows = await tx.execute<{ id: string; name: string; conversations: number; dashboards: number }>(sql`
    select f.id, f.name,
      (select count(*) from app.thread t where t.org_id = f.org_id and t.folder_id = f.id and t.deleted_at is null
        and ${threadReadableBy(actor.userId)})::int as conversations,
      (select count(*) from app.dashboard d where d.org_id = f.org_id and d.folder_id = f.id
        and d.deleted_at is null and ${dashboardReadableBy(actor.userId)})::int as dashboards
    from app.project f
    where f.org_id = ${actor.orgId} and f.parent_id = ${projectId} and f.kind = 'folder' and f.deleted_at is null
    order by lower(f.name), f.id`);
  return rows.map((r) => ({ ...r, conversations: Number(r.conversations), dashboards: Number(r.dashboards) }));
}

const folderName = (raw: string) => {
  const name = raw.trim();
  if (!name || name.length > 60) throw new ProjectRefused("Name the folder, in under 60 characters.");
  return name;
};

/** A new folder in a project: its editors and managers make one. Names are unique within the project. */
export async function createFolder(
  tx: TenantTx,
  actor: ProjectActor,
  projectId: string,
  rawName: string,
): Promise<FolderView> {
  await canAddTo(tx, actor, projectId);
  const name = folderName(rawName);
  const [made] = await tx.execute<{ id: string }>(sql`
    insert into app.project (org_id, id, kind, parent_id, name, slug, created_by)
    values (${actor.orgId}, ${uuidv7()}, 'folder', ${projectId}, ${name}, ${slugOf(name)}, ${actor.userId})
    on conflict on constraint project_slug_uq do nothing
    returning id`);
  if (!made) throw new ProjectRefused("This project has a folder by that name already.");
  return { id: made.id, name, conversations: 0, dashboards: 0 };
}

/** A folder the actor can add to (an editor or manager of its project), with its project. */
async function folderFor(tx: TenantTx, actor: ProjectActor, folderId: string): Promise<{ projectId: string }> {
  const [f] = await tx.execute<{ parent_id: string }>(sql`
    select parent_id from app.project
    where org_id = ${actor.orgId} and id = ${folderId} and kind = 'folder' and deleted_at is null`);
  if (!f) throw new ProjectNotFound();
  await canAddTo(tx, actor, f.parent_id);
  return { projectId: f.parent_id };
}

/** Renames a folder: its project's editors and managers. */
export async function renameFolder(tx: TenantTx, actor: ProjectActor, folderId: string, rawName: string) {
  await folderFor(tx, actor, folderId);
  const name = folderName(rawName);
  const rows = await tx.execute(sql`
    update app.project set name = ${name}, slug = ${slugOf(name)}, updated_at = now()
    where org_id = ${actor.orgId} and id = ${folderId}
      and not exists (select 1 from app.project o where o.org_id = app.project.org_id
        and o.parent_id = app.project.parent_id and o.slug = ${slugOf(name)} and o.id <> app.project.id)
    returning id`);
  if (!rows.length) throw new ProjectRefused("This project has a folder by that name already.");
}

/** Deletes a folder: what was in it stays in the project, in no folder. Its project's editors and managers. */
export async function deleteFolder(tx: TenantTx, actor: ProjectActor, folderId: string): Promise<void> {
  await folderFor(tx, actor, folderId);
  for (const table of [sql`app.thread`, sql`app.dashboard`]) {
    await tx.execute(
      sql`update ${table} set folder_id = null where org_id = ${actor.orgId} and folder_id = ${folderId}`,
    );
  }
  await tx.execute(sql`
    update app.project set deleted_at = now(), updated_at = now() where org_id = ${actor.orgId} and id = ${folderId}`);
}

/**
 * Puts the owner's conversation or dashboard in a folder of its project, or in none (`folderId` null). Only its
 * owner moves it, and only where they can add (an editor or manager of the project).
 */
export async function moveToFolder(
  tx: TenantTx,
  actor: ProjectActor,
  item: { kind: "thread" | "dashboard"; id: string },
  folderId: string | null,
): Promise<void> {
  const table = item.kind === "thread" ? sql`app.thread` : sql`app.dashboard`;
  const owner = item.kind === "thread" ? sql`created_by` : sql`owner_id`;
  const [row] = await tx.execute<{ mine: boolean; project_id: string | null }>(sql`
    select ${owner} is not distinct from ${actor.userId}::uuid as mine, project_id from ${table}
    where org_id = ${actor.orgId} and id = ${item.id} and deleted_at is null
`);
  if (!row?.mine) throw new ProjectRefused("Only its owner moves it.");
  if (!row.project_id) throw new ProjectRefused("It isn't in a project, so it can't go in a folder.");
  if (folderId) {
    const { projectId } = await folderFor(tx, actor, folderId);
    if (projectId !== row.project_id) throw new ProjectNotFound();
  } else {
    await canAddTo(tx, actor, row.project_id);
  }
  await tx.execute(sql`update ${table} set folder_id = ${folderId} where org_id = ${actor.orgId} and id = ${item.id}`);
}

/** A table a project's work rests on (a key table): a source's table, by its schema-qualified name. */
export interface KeyTable {
  connectionId: string;
  table: string;
}

/** A key table as the project's page shows it: whether it's still in the catalog, and a verified dataset over it. */
export interface KeyTableView extends KeyTable {
  sourceName: string;
  rows: number | null;
  /** Still in the source's catalog (a table can be dropped after it was chosen). */
  present: boolean;
  /** A released dataset that reads it, if any. */
  covered: { id: string; title: string } | null;
}

export const MAX_KEY_TABLES = 20;

const keyOf = (t: KeyTable) => `${t.connectionId}:${t.table.toLowerCase()}`;

/** The catalog's facts and coverage for these tables, keyed by connection and lowercased name. */
async function describeTables(
  tx: TenantTx,
  orgId: string,
  connectionIds: string[],
): Promise<{
  tables: Map<string, { sourceName: string; rows: number | null }>;
  covered: Map<string, { id: string; title: string }>;
}> {
  const ids = [...new Set(connectionIds.filter(isUuid))];
  if (!ids.length) return { tables: new Map(), covered: new Map() };
  const list = sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = await tx.execute<{
    connection_id: string;
    fq_name: string;
    source_name: string;
    rows: string | null;
  }>(sql`
    select o.connection_id, o.fq_name, c.name as source_name, o.profile->>'rows' as rows from app.catalog_object o
    join app.connection c on c.org_id = o.org_id and c.id = o.connection_id and c.deleted_at is null
    where o.org_id = ${orgId} and o.connection_id in (${list}) and o.kind in ('table', 'view') and o.removed_at is null`);
  const datasets = await tx.execute<{ connection_id: string; fq: string; id: string; title: string }>(sql`
    select i.connection_id, lower(t) as fq, i.id, i.title from app.context_item i
    join app.context_item_version v on v.org_id = i.org_id and v.item_id = i.id and v.version = i.released_version
    cross join jsonb_array_elements_text(coalesce(v.derived->'tables', '[]'::jsonb)) t
    where i.org_id = ${orgId} and i.kind = 'dataset' and i.deleted_at is null and i.released_version is not null
      and i.connection_id in (${list})
    -- The most specific first: a dataset over just that table names it better than one joining it in.
    order by jsonb_array_length(coalesce(v.derived->'tables', '[]'::jsonb)), i.title`);
  const tables = new Map(
    rows.map((r) => [
      `${r.connection_id}:${r.fq_name.toLowerCase()}`,
      { sourceName: r.source_name, rows: r.rows === null || r.rows === "" ? null : Number(r.rows) },
    ]),
  );
  const covered = new Map<string, { id: string; title: string }>();
  for (const d of datasets) {
    const k = `${d.connection_id}:${d.fq}`;
    if (!covered.has(k)) covered.set(k, { id: d.id, title: d.title });
  }
  return { tables, covered };
}

/** A project's key tables, in the order chosen, each with whether a verified dataset covers it. */
export async function projectKeyTables(tx: TenantTx, actor: ProjectActor, projectId: string): Promise<KeyTableView[]> {
  if (!(await getProject(tx, actor, projectId))) throw new ProjectNotFound();
  const [p] = await tx.execute<{ key_tables: KeyTable[] | null }>(sql`
    select settings->'key_tables' as key_tables from app.project where org_id = ${actor.orgId} and id = ${projectId}`);
  const chosen = (Array.isArray(p?.key_tables) ? p.key_tables : []).filter(
    (t): t is KeyTable => isUuid(t?.connectionId) && typeof t?.table === "string",
  );
  const { tables, covered } = await describeTables(
    tx,
    actor.orgId,
    chosen.map((t) => t.connectionId),
  );
  return chosen.map((t) => {
    const facts = tables.get(keyOf(t));
    return {
      connectionId: t.connectionId,
      table: t.table,
      sourceName: facts?.sourceName ?? "A removed source",
      rows: facts?.rows ?? null,
      present: Boolean(facts),
      covered: covered.get(keyOf(t)) ?? null,
    };
  });
}

/** What a manager picks from: a source's tables, most used first, each with its coverage. */
export async function keyTableChoices(
  tx: TenantTx,
  actor: ProjectActor,
  projectId: string,
  connectionId: string,
): Promise<{ table: string; rows: number | null; covered: { id: string; title: string } | null }[]> {
  if (!(await getProject(tx, actor, projectId))) throw new ProjectNotFound();
  if (!isUuid(connectionId)) return [];
  const rows = await tx.execute<{ fq_name: string }>(sql`
    select fq_name from app.catalog_object
    where org_id = ${actor.orgId} and connection_id = ${connectionId} and kind in ('table', 'view') and removed_at is null
    order by usage_score desc, (profile->>'rows')::float8 desc nulls last, fq_name
    limit 500`);
  const { tables, covered } = await describeTables(tx, actor.orgId, [connectionId]);
  return rows.map((r) => {
    const k = `${connectionId}:${r.fq_name.toLowerCase()}`;
    return { table: r.fq_name, rows: tables.get(k)?.rows ?? null, covered: covered.get(k) ?? null };
  });
}

/**
 * Sets a project's key tables: its managers (or an owner or admin of the organization). Each must be a table or view
 * in a source's catalog; at most MAX_KEY_TABLES, once each.
 */
export async function setKeyTables(
  tx: TenantTx,
  actor: ProjectActor,
  projectId: string,
  input: KeyTable[],
): Promise<KeyTableView[]> {
  const { manages } = await standing(tx, actor, projectId);
  if (!manages) throw new ProjectRefused("Only the project's managers choose its key tables.");
  const seen = new Set<string>();
  const chosen = input.filter((t) => {
    if (!isUuid(t?.connectionId) || typeof t?.table !== "string" || t.table.length > 300) return false;
    const k = keyOf(t);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (chosen.length > MAX_KEY_TABLES) {
    throw new ProjectRefused(`Choose up to ${MAX_KEY_TABLES} key tables.`);
  }
  const { tables } = await describeTables(
    tx,
    actor.orgId,
    chosen.map((t) => t.connectionId),
  );
  const missing = chosen.find((t) => !tables.has(keyOf(t)));
  if (missing) throw new ProjectRefused(`${missing.table} isn't a table in that source's catalog.`);
  await tx.execute(sql`
    update app.project
    set settings = jsonb_set(settings, '{key_tables}', ${JSON.stringify(chosen.map((t) => ({ connectionId: t.connectionId, table: t.table })))}::jsonb),
      updated_at = now()
    where org_id = ${actor.orgId} and id = ${projectId}`);
  return projectKeyTables(tx, actor, projectId);
}
